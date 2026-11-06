import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const oldFetch = globalThis.fetch;
const cache = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => cache.get(key) || null, setItem: (key: string, value: string) => cache.set(key, value), removeItem: (key: string) => cache.delete(key) } });
Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: globalThis.localStorage, location: { href: "https://canvas.example.com/", origin: "https://canvas.example.com" } } });
afterAll(() => {
    globalThis.fetch = oldFetch;
    for (const [key, descriptor] of [["localStorage", oldStorage], ["window", oldWindow]] as const) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
});
const { createModelChannel, defaultConfig, defaultSeedanceConfig, resolveModelRequestConfig, useConfigStore, isVolcengineSeedance25 } = await import("../src/stores/use-config-store");
const { getSeedance25AssetsScript, isReplayablePluginScript, getVolcengineSeedanceScript } = await import("../src/services/api/model-plugin");
const { resolveScriptCos, createScriptCosUpload } = await import("../src/services/api/script-cos");
const { videoPluginResult, createVideoGenerationTask, pollVideoGenerationTask } = await import("../src/services/api/video");
const { createGenerationCostSnapshot } = await import("../src/services/generation-cost");
const { buildGenerationConfig } = await import("../src/lib/canvas/canvas-generation-helpers");
const { CanvasNodeType } = await import("../src/types/canvas");
const script = readFileSync(new URL("../src/services/api/seedance25-assets-script.js", import.meta.url), "utf8").trim();
const proxy = "https://canvas.example.com/canvas-proxy";
const model = "doubao-seedance-2-5-260628";
const params = { seconds: 8, resolution: "720p", ratio: "16:9", mode: "reference", generateAudio: true, watermark: false };
const channel = createModelChannel({ id: "platform", baseUrl: "http://154.40.44.244:3000", apiKey: "fixture-platform-key", apiFormat: "openai", models: [{ name: model, capability: "video", script }] });
const cos = { ...defaultSeedanceConfig, cosEnabled: true, cosBucket: "fixture-bucket", cosEndpoint: "cos.ap-singapore.myqcloud.com", cosPublicBaseUrl: "https://sg-cos.maxai.art", cosSecretId: "fixture-cos-id", cosSecretKey: "fixture-cos-key" };
const config = { ...defaultConfig, model: "platform::" + model, videoModel: "platform::" + model, proxyEnabled: true, proxyUrl: proxy, channels: [channel, createModelChannel({ id: "storage", seedance: cos })] };

async function execute(options: { images?: string[]; videos?: File[]; audios?: File[]; params?: Record<string, unknown>; seedance?: Record<string, unknown>; source?: string; failAsset?: boolean } = {}) {
    cache.clear();
    const actions: Array<{ action: string; body: Record<string, unknown>; url: string }> = [];
    const creates: Record<string, any>[] = []; const uploads: string[] = []; const waits: number[] = [];
    let assetIndex = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === proxy + "/") return Response.json({ taskResultMetadata: 1 });
        const parsed = new URL(url);
        const action = parsed.searchParams.get("Action")!;
        expect(parsed.searchParams.getAll("model")).toEqual([model]);
        expect(parsed.searchParams.getAll("Version")).toEqual(["2024-01-01"]);
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-platform-key");
        const body = JSON.parse(String(init?.body)); expect(body.model).toBeUndefined();
        actions.push({ action, body, url });
        if (action === "CreateAssetGroup") return Response.json({ Result: { Id: "group-fixture" } });
        if (action === "CreateAsset") return Response.json({ Result: { Id: "asset_" + ++assetIndex } });
        if (options.failAsset) return Response.json({ Result: { Status: "Failed" } });
        return Response.json({ Result: { Status: "Active" } });
    }) as typeof fetch;
    const runner = new Function("prompt", "images", "videos", "audios", "params", "model", "baseUrl", "apiKey", "seedance", "http", "sleep", "signal", "fetch", "uploadToCos", `return (async()=>{${options.source || script}\n})();`);
    const result = await runner("图片1保持在图片2左边", options.images || [], options.videos || [], options.audios || [], { ...params, ...options.params }, model, channel.baseUrl, "fixture-platform-key", { ...defaultSeedanceConfig, ...options.seedance }, { url: (path: string) => proxy + "/" + channel.baseUrl + "/v1" + path }, async (ms: number) => waits.push(ms), new AbortController().signal,
        async (url: string, init: RequestInit) => { expect(url).toBe(proxy + "/" + channel.baseUrl + "/v1/videos"); expect(new Headers(init.headers).get("x-canvas-video-protocol")).toBe("json-video"); expect(new Headers(init.headers).get("x-canvas-video-public-result")).toBe("1"); creates.push(JSON.parse(String(init.body))); return new Response("fixture-video", { headers: { "content-type": "video/mp4", "x-canvas-upstream-id": "task_PLATFORM_DRAFT" } }); },
        async (file: string) => { uploads.push(file); return "https://sg-cos.maxai.art/reference-" + uploads.length + ".png"; });
    return { actions, creates, uploads, waits, result };
}

test("script opts one selected model into draft UI without changing other channels or default routing", () => {
    expect(getSeedance25AssetsScript()).toBe(script);
    expect(isReplayablePluginScript("video", script)).toBe(false);
    expect(isReplayablePluginScript("video", script.replace('const ASSET_GROUP_ID = "";', 'const ASSET_GROUP_ID = "verified";'))).toBe(false);
    expect(isReplayablePluginScript("video", getVolcengineSeedanceScript())).toBe(true);
    expect(isVolcengineSeedance25(config)).toBe(true);
    expect(isVolcengineSeedance25({ ...config, channels: [{ ...channel, models: [{ name: model, capability: "video" }] }] })).toBe(false);
    expect(resolveModelRequestConfig(config, config.model).apiFormat).toBe("openai");
    const node = { id: "fixture", type: CanvasNodeType.Video, title: "fixture", position: { x: 0, y: 0 }, width: 340, height: 191, metadata: { seedanceTaskType: "edit" as const, model: config.model, seconds: "8" } };
    expect(buildGenerationConfig(config, node, "video").videoSeconds).toBe("-1");
    const draftConfig = { ...config, seedanceChannelId: channel.id, seedance: { ...defaultSeedanceConfig, draft: true }, vquality: "1080" };
    expect(createGenerationCostSnapshot(draftConfig, "project", "node").resolution).toBe("480p");
});

test("text draft uses480p and returns the platform ID; text never sends omni/camera/seed/tail", async () => {
    const { result, creates, uploads, actions } = await execute({ seedance: { draft: true, returnLastFrame: true, cameraFixed: true, seed: "42" }, params: { seconds: -1 } });
    expect(creates).toHaveLength(1); expect(uploads).toHaveLength(0); expect(actions).toHaveLength(0);
    expect(creates[0]).toMatchObject({ model, draft: true, resolution: "480p", duration: -1 });
    for (const key of ["omni_reference_task_type", "camera_fixed", "seed", "return_last_frame", "seconds"]) expect(creates[0][key]).toBeUndefined();
    expect(videoPluginResult(result).draftTaskId).toBe("task_PLATFORM_DRAFT"); expect(result.blob).toBeInstanceOf(Blob);
});

test("formal continuation sends only platform draft ID/model/draft/resolution and never reads references", async () => {
    const { creates, uploads, actions } = await execute({ seedance: { draftTaskId: "task_OWN_DRAFT", draft: false }, images: ["data:image/png;base64,ignored"] });
    expect(uploads).toHaveLength(0); expect(actions).toHaveLength(0);
    expect(creates).toEqual([{ model, content: [{ type: "draft_task", draft_task: { id: "task_OWN_DRAFT" } }], draft: false, resolution: "1080p" }]);
});

test("ordinary Generate on a completed draft creates another preview rather than an implicit paid final", async () => {
    const { creates } = await execute({ seedance: { draft: true, draftTaskId: "task_OLDER_DRAFT" } });
    expect(creates[0].draft).toBe(true); expect(creates[0].resolution).toBe("480p");
    expect(creates[0].content[0].type).toBe("text");
});

test("COS then platform assets preserves duplicate image positions and mixed references", async () => {
    const { creates, uploads, actions } = await execute({ images: ["data:first", "data:first", "data:second"], videos: [new File(["fixture"], "ref.mp4")], audios: [new File(["fixture"], "ref.mp3")] });
    expect(uploads).toHaveLength(5);
    expect(actions.filter((entry) => entry.action === "CreateAssetGroup")).toHaveLength(1);
    expect(actions.filter((entry) => entry.action === "CreateAsset").map((entry) => entry.body.AssetType)).toEqual(["Image", "Image", "Image", "Video", "Audio"]);
    expect(creates[0].content.slice(1).map((entry: any) => entry[entry.type].url)).toEqual(["asset://asset_1", "asset://asset_2", "asset://asset_3", "asset://asset_4", "asset://asset_5"]);
    expect(creates[0].omni_reference_task_type).toBe("reference");
});

test("frame roles omit omni and force adaptive; audio-only and authenticated groups remain supported", async () => {
    const frames = await execute({ images: ["data:first", "data:last"], params: { mode: "frames" } });
    expect(frames.creates[0].ratio).toBe("adaptive"); expect(frames.creates[0].omni_reference_task_type).toBeUndefined();
    expect(frames.creates[0].content.slice(1).map((entry: any) => entry.role)).toEqual(["first_frame", "last_frame"]);
    const audio = await execute({ audios: [new File(["audio"], "ref.mp3")] });
    expect(audio.creates[0].content[1].role).toBe("reference_audio");
    const certified = await execute({ images: ["data:person"], source: script.replace('const ASSET_GROUP_ID = "";', 'const ASSET_GROUP_ID = "group-verified";') });
    expect(certified.actions.some((entry) => entry.action === "CreateAssetGroup")).toBe(false);
    expect(certified.actions.find((entry) => entry.action === "CreateAsset")?.body.GroupId).toBe("group-verified");
});

test("bad material or unsupported parameters fail before any generation POST", async () => {
    await expect(execute({ images: ["data:a"], failAsset: true })).rejects.toThrow("不可生成");
    await expect(execute({ params: { seconds: 31 } })).rejects.toThrow("4～30");
    await expect(execute({ images: ["data:a", "data:b", "data:c"], params: { mode: "frames" } })).rejects.toThrow("首尾帧");
    await expect(execute({ seedance: { taskType: "edit" } })).rejects.toThrow("必须连接参考视频");
});

test("script COS helper reuses the existing Singapore configuration and never sends platform credentials", async () => {
    useConfigStore.setState({ config });
    const resolved = resolveModelRequestConfig(config, config.model);
    expect(resolveScriptCos(resolved).cosPublicBaseUrl).toBe("https://sg-cos.maxai.art");
    const calls: Array<{ url: string; body: any }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => { calls.push({ url: String(input), body: JSON.parse(String(init?.body)) }); return Response.json({ url: "https://sg-cos.maxai.art/fixture.png" }); }) as typeof fetch;
    expect(await createScriptCosUpload(resolved)("data:image/png;base64,AQ==", "image")).toBe("https://sg-cos.maxai.art/fixture.png");
    expect(calls[0].url).toBe(proxy + "/seedance/cos-upload");
    expect(calls[0].body.seedance.cosBucket).toBe("fixture-bucket"); expect(JSON.stringify(calls)).not.toContain("fixture-platform-key");
    const other = { ...cos, cosBucket: "other-bucket" };
    useConfigStore.setState({ config: { ...config, channels: [...config.channels, createModelChannel({ id: "other", seedance: other })] } });
    expect(() => resolveScriptCos(resolved)).toThrow("多套COS");
});

test("formal generation entry skips stale image loading and keeps the platform draft ID out of ordinary parameters", async () => {
    cache.clear(); useConfigStore.setState({ config });
    let submitted: any;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === proxy + "/") return Response.json({ taskResultMetadata: 1 });
        submitted = JSON.parse(String(init?.body));
        return new Response("fixture-video", { headers: { "content-type": "video/mp4", "x-canvas-upstream-id": "task_FORMAL" } });
    }) as typeof fetch;
    const formal = { ...config, seedanceChannelId: channel.id, seedance: { ...defaultSeedanceConfig, draft: false, draftTaskId: "task_OWN_DRAFT" } };
    const task = await createVideoGenerationTask(formal, "ignored", [{ id: "unreadable", dataUrl: "" }]);
    expect(submitted.content).toEqual([{ type: "draft_task", draft_task: { id: "task_OWN_DRAFT" } }]);
    expect((await pollVideoGenerationTask(formal, task)).status).toBe("completed");
});
