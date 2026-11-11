import { afterAll, expect, mock, test } from "bun:test";
import type { CanvasNodeData } from "../src/types/canvas";
import type { CanvasProject } from "../src/stores/canvas/use-canvas-store";
import type { BackgroundTask } from "../src/services/api/background-tasks";
import type { GenerationResource } from "../src/stores/use-generation-resource-store";

const stores = new Map<string, Map<string, unknown>>();
const downloads: { blob: Blob; name: string }[] = [];
mock.module("file-saver", () => ({ saveAs: (blob: Blob, name: string) => downloads.push({ blob, name }) }));
const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
afterAll(() => {
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});
mock.module("localforage", () => ({ default: { config: () => {}, createInstance: ({ storeName }: { storeName: string }) => {
    const data = stores.get(storeName) || new Map();
    stores.set(storeName, data);
    return {
        getItem: async (key: string) => structuredClone(data.get(key) ?? null),
        setItem: async (key: string, value: unknown) => { data.set(key, structuredClone(value)); },
        removeItem: async (key: string) => { data.delete(key); },
        iterate: async (callback: (value: unknown, key: string) => void) => { for (const [key, value] of data) callback(structuredClone(value), key); },
    };
} } }));

const { regenerateInPlace, resetGenerationResult } = await import("../src/lib/canvas/canvas-regeneration");
const { CanvasNodeType } = await import("../src/types/canvas");
const { collectExistingGenerationResources, preserveNodeResources } = await import("../src/services/generation-resources");
const { useGenerationResourceStore, generationResourceKeys, saveGenerationResource, removeGenerationResources } = await import("../src/stores/use-generation-resource-store");
const { backgroundTasks, backgroundFetch, supersedeNodeBackgroundTasks } = await import("../src/services/api/background-tasks");
const node = (type = CanvasNodeType.Image): CanvasNodeData => ({ id: "node", type, title: "结果", position: { x: 100, y: 200 }, width: 340, height: 200, metadata: { status: "success", model: "relay::selected", prompt: "原提示词", content: "blob:old", storageKey: "image:old" } });

test("same-type successful/failed/empty media nodes regenerate in place; config and cross-type still create outputs", () => {
    for (const type of [CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio, CanvasNodeType.Text]) {
        expect(regenerateInPlace(node(type), type)).toBe(true);
        expect(regenerateInPlace({ ...node(type), metadata: { status: "error" } }, type)).toBe(true);
        expect(regenerateInPlace({ ...node(type), metadata: {} }, type)).toBe(true);
    }
    expect(regenerateInPlace(node(CanvasNodeType.Config), "image")).toBe(false);
    expect(regenerateInPlace(node(CanvasNodeType.Text), "image")).toBe(false);
    expect(regenerateInPlace({ ...node(), metadata: { status: "success", content: "blob:manual-upload" } }, "image")).toBe(false);
    expect(regenerateInPlace({ ...node(CanvasNodeType.Text), metadata: { content: "手工输入的源文本" } }, "text")).toBe(false);
});

test("clear old outputs/receipts without changing node settings or the old snapshot", () => {
    const old = { ...node().metadata!, groupId: "group", composerContent: "@node", videoTaskId: "old-task", primaryImageId: "old-image", seedanceDraftTaskId: "old-draft" };
    const next = resetGenerationResult(old);
    expect(next.storageKey).toBeUndefined();
    expect(next.content).toBeUndefined();
    expect(next.videoTaskId).toBeUndefined();
    expect(next.seedanceDraftTaskId).toBeUndefined();
    expect(next.primaryImageId).toBeUndefined();
    expect(next.groupId).toBe("group");
    expect(next.model).toBe("relay::selected");
    expect(next.composerContent).toBe("@node");
    expect(old.content).toBe("blob:old");
});

test("backfill all projects and each successful batch slot once, never failed slots or uploaded material", async () => {
    const image = node();
    image.metadata!.images = [
        { id: "a", status: "success", content: "blob:a", storageKey: "image:a", naturalWidth: 100, naturalHeight: 100, bytes: 12, mimeType: "image/png" },
        { id: "b", status: "success", content: "blob:b", storageKey: "image:b", naturalWidth: 100, naturalHeight: 100, bytes: 12, mimeType: "image/png" },
        { id: "c", status: "error", content: "", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "" },
    ];
    const audio = { ...node(CanvasNodeType.Audio), metadata: { ...node().metadata, storageKey: "audio:one" } };
    const projects = [{ id: "p1", title: "画布一", updatedAt: "2026-11-01T08:00:00Z", nodes: [image, { ...node(), metadata: { status: "success", content: "blob:upload" } }] }, { id: "p2", title: "画布二", updatedAt: "2026-11-02T08:00:00Z", nodes: [audio] }] as CanvasProject[];
    await collectExistingGenerationResources(projects);
    await collectExistingGenerationResources(projects);
    expect(useGenerationResourceStore.getState().resources).toHaveLength(3);
    expect((await generationResourceKeys()).sort()).toEqual(["audio:one", "image:a", "image:b"]);
    expect(useGenerationResourceStore.getState().resources.every((entry) => entry.content === "" && entry.approximateDate)).toBe(true);
    const old = structuredClone(useGenerationResourceStore.getState().resources);
    projects[0].nodes = [];
    expect(useGenerationResourceStore.getState().resources).toEqual(old);
});

test("each regenerated file persists independently and preserves its true received date on later backfill", async () => {
    await saveGenerationResource({ kind: "video", projectId: "p3", projectTitle: "新画布", nodeId: "same-node", title: "视频", prompt: "提示", model: "current-model", createdAt: "2026-11-03T12:00:00Z", content: "blob:video", storageKey: "video:new" });
    await preserveNodeResources({ id: "p3", title: "新画布", updatedAt: "2026-11-06T00:00:00Z" }, { ...node(CanvasNodeType.Video), metadata: { ...node().metadata, storageKey: "video:new" } });
    const saved = useGenerationResourceStore.getState().resources.find((entry) => entry.storageKey === "video:new")!;
    expect(saved.createdAt).toBe("2026-11-03T12:00:00Z");
    expect(saved.approximateDate).toBeUndefined();
    expect(saved.content).toBe("");
});

test("superseded receipts retain credentials but do not participate in current node recovery", async () => {
    const task = { id: "old-receipt", base: "https://fixture-proxy.example", key: "fixture-not-a-secret", projectId: "p4", nodeId: "node", kind: "openai-video", snapshot: node() } as BackgroundTask;
    stores.get("background_tasks")!.set(task.id, task);
    await supersedeNodeBackgroundTasks("p4", "node");
    stores.get("background_tasks")!.set("new-receipt", { ...task, id: "new-receipt" });
    expect((await backgroundTasks("p4")).map((entry) => entry.id)).toEqual(["new-receipt"]);
    const all = await backgroundTasks("p4", true);
    expect(all).toHaveLength(2);
    expect(all.find((entry) => entry.id === "old-receipt")?.key).toBe("fixture-not-a-secret");
    expect(all.find((entry) => entry.id === "old-receipt")?.superseded).toBe(true);
});

test("shared media/image cleanup protects historical files even after nodes were overwritten", async () => {
    const { cleanupMediaFiles } = await import("../src/services/file-storage");
    const { cleanupImageFiles } = await import("../src/services/image-storage");
    stores.get("media_files")!.set("audio:one", new Blob(["keep"]));
    stores.get("media_files")!.set("video:trash", new Blob(["delete"]));
    stores.get("image_files")!.set("image:a", new Blob(["keep"]));
    stores.get("image_files")!.set("image:trash", new Blob(["delete"]));
    await cleanupMediaFiles([]);
    await cleanupImageFiles([]);
    expect(stores.get("media_files")!.has("audio:one")).toBe(true);
    expect(stores.get("media_files")!.has("video:trash")).toBe(false);
    expect(stores.get("image_files")!.has("image:a")).toBe(true);
    expect(stores.get("image_files")!.has("image:trash")).toBe(false);
});

test("archived receipt replay only GETs its own result, never the new attempt or a paid POST", async () => {
    const previous = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        expect((init?.method || "GET").toUpperCase()).toBe("GET");
        urls.push(String(input));
        return String(input).endsWith("/result") ? new Response("old-result", { headers: { "content-type": "video/mp4" } }) : Response.json({ state: "completed" });
    }) as typeof fetch;
    try {
        const result = await backgroundFetch("https://never-submit.example/videos", { method: "POST", body: "must-not-be-sent" }, { projectId: "p4", nodeId: "node", superseded: true, replay: true, snapshot: node }, "openai-video");
        expect(await result.text()).toBe("old-result");
        expect(urls).toEqual(["https://fixture-proxy.example/_tasks/old-receipt", "https://fixture-proxy.example/_tasks/old-receipt/result"]);
    } finally { globalThis.fetch = previous; }
});

test("history filters project/type/inclusive calendar dates and groups descending local dates", async () => {
    const { filterGenerationHistory, groupGenerationHistory } = await import("../src/lib/generation-resource-history");
    const base = { projectTitle: "项目", nodeId: "node", title: "素材", prompt: "提示", model: "model", content: "" };
    const items: GenerationResource[] = [
        { ...base, id: "a", projectId: "p1", kind: "video", createdAt: "2026-11-01T00:00:00" },
        { ...base, id: "b", projectId: "p1", kind: "image", createdAt: "2026-11-01T23:59:59" },
        { ...base, id: "c", projectId: "p2", kind: "audio", createdAt: "2026-11-02T12:00:00" },
    ];
    expect(filterGenerationHistory(items, { projectId: "p1", from: "2026-11-01", to: "2026-11-01" }).map((entry) => entry.id)).toEqual(["b", "a"]);
    expect(filterGenerationHistory(items, { kind: "video" }).map((entry) => entry.id)).toEqual(["a"]);
    expect(groupGenerationHistory(filterGenerationHistory(items, {})).map((group) => [group.date, group.items.length])).toEqual([["2026-11-02", 1], ["2026-11-01", 2]]);
    expect(filterGenerationHistory(items, { projectId: "missing" })).toEqual([]);
});

test("batch download creates one ZIP with unique valid filenames; insertion payloads preserve type and layout offsets", async () => {
    const { downloadGenerationResources, generationResourcePayload } = await import("../src/services/generation-resource-files");
    const { readZip } = await import("../src/lib/zip");
    const base = { projectId: "p1", projectTitle: "项目", nodeId: "node", title: "同名/素材", prompt: "提示", model: "model", createdAt: "2026-11-01T12:00:00", content: "" };
    const image: GenerationResource = { ...base, id: "i", kind: "image", storageKey: "image:a", mimeType: "image/jpeg" };
    const audio: GenerationResource = { ...base, id: "m", kind: "audio", storageKey: "audio:one", mimeType: "audio/mpeg" };
    downloads.length = 0;
    await downloadGenerationResources([image, audio]);
    expect(downloads).toHaveLength(1);
    expect(downloads[0].name).toBe("生成历史.zip");
    const files = await readZip(downloads[0].blob);
    expect([...files.keys()]).toEqual(["001-同名_素材.jpg", "002-同名_素材.mp3"]);
    const payload = await generationResourcePayload(audio, { x: 720, y: 720 });
    expect(payload.kind).toBe("audio");
    expect(payload.offset).toEqual({ x: 720, y: 720 });
    expect("storageKey" in payload && payload.storageKey).toBe("audio:one");
    expect("url" in payload && payload.url.startsWith("blob:")).toBe(true);
    expect(await generationResourcePayload({ ...base, id: "t", kind: "text", content: "生成文字" })).toEqual({ kind: "text", title: "同名/素材", content: "生成文字", offset: undefined });
});

test("deleting history persists tombstones without deleting media and backfill cannot resurrect it", async () => {
    const saved = useGenerationResourceStore.getState().resources.find((entry) => entry.storageKey === "image:a")!;
    expect(saved).toBeDefined();
    await removeGenerationResources([saved.id, saved.id]);
    expect(useGenerationResourceStore.getState().resources.some((entry) => entry.id === saved.id)).toBe(false);
    expect(stores.get("generation_resource_deletions")!.has(saved.id)).toBe(true);
    expect(stores.get("generation_resources")!.has(saved.id)).toBe(false);
    expect(stores.get("image_files")!.has("image:a")).toBe(true);
    await saveGenerationResource(saved);
    expect(useGenerationResourceStore.getState().resources.some((entry) => entry.id === saved.id)).toBe(false);
    expect(useGenerationResourceStore.getState().resources.some((entry) => entry.storageKey === "image:b")).toBe(true);
});
