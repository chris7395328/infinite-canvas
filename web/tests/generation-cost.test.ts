import { afterAll, expect, mock, test } from "bun:test";
import type { GenerationCostRecord } from "../src/types/generation-cost";
import type { CanvasNodeData } from "../src/types/canvas";

const data = new Map<string, unknown>();
const stores = new Map<string, Map<string, unknown>>([["generation_costs", data]]);
mock.module("localforage", () => ({ default: { config: () => {}, createInstance: ({ storeName }: { storeName: string }) => {
    if (!stores.has(storeName)) stores.set(storeName, new Map());
    const store = stores.get(storeName)!;
    return {
        getItem: async (key: string) => structuredClone(store.get(key) ?? null),
        setItem: async (key: string, value: unknown) => { store.set(key, structuredClone(value)); },
        iterate: async (callback: (value: unknown) => void) => { for (const value of store.values()) callback(structuredClone(value)); },
    };
} } }));
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
afterAll(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

const { defaultConfig, normalizeChannelModels, useConfigStore } = await import("../src/stores/use-config-store");
const { createGenerationCostSnapshot, recordGenerationSubmitted, recordReceivedGeneration, cancelFailedGenerationCosts } = await import("../src/services/generation-cost");
const { useGenerationCostStore } = await import("../src/stores/use-generation-cost-store");
const { generationCostMicros, filterCostRecords, normalizeResolutionPrices, normalizePriceResolution } = await import("../src/lib/generation-cost");
const { copyNodeMetadata } = await import("../src/lib/canvas/canvas-node-factory");
const { CanvasNodeType } = await import("../src/types/canvas");
const config = {
    ...defaultConfig, model: "relay-b::same-model", videoSeconds: "8",
    channels: [
        { id: "relay-a", name: "渠道甲", baseUrl: "https://a.example.com", apiKey: "private-a", apiFormat: "openai" as const, models: [{ name: "same-model", capability: "video" as const, price: { unit: "request" as const, amount: "99" } }] },
        { id: "relay-b", name: "渠道乙", baseUrl: "https://b.example.com", apiKey: "private-b", apiFormat: "openai" as const, models: [{ name: "same-model", capability: "video" as const, price: { unit: "second" as const, amount: "0.53" } }] },
    ],
};
const record = (id: string) => useGenerationCostStore.getState().records.find((item) => item.id === id)!;
const node = (status: "error" | "success"): CanvasNodeData => ({ id: "node", type: CanvasNodeType.Video, title: "Video", width: 340, height: 200, position: { x: 0, y: 0 }, metadata: { status } });

test("model price survives channel normalization and config round trip", () => {
    const models = normalizeChannelModels(JSON.parse(JSON.stringify(config.channels[1].models)));
    expect(models[0].price).toEqual({ unit: "second", amount: "0.53" });
});

test("resolution tiers round trip, normalize aliases, reject duplicate/invalid prices and per-second images", () => {
    const tiers = [
        { resolution: "720P", unit: "second" as const, amount: "0.53" },
        { resolution: "4K", unit: "request" as const, amount: "10" },
        { resolution: "2160p", unit: "request" as const, amount: "99" },
        { resolution: "bad", unit: "request" as const, amount: "10" },
        { resolution: "1080p", unit: "second" as const, amount: "-1" },
    ];
    const models = normalizeChannelModels(JSON.parse(JSON.stringify([{ name: "video", capability: "video", resolutionPrices: tiers }])));
    expect(models[0].resolutionPrices).toEqual([
        { resolution: "720p", unit: "second", amount: "0.53" },
        { resolution: "2160p", unit: "request", amount: "10" },
    ]);
    expect(normalizeResolutionPrices([{ resolution: "2K", unit: "second", amount: "1" }], "image")).toEqual([]);
    expect(normalizePriceResolution("1024 × 1024", "image")).toBe("1024x1024");
});

const tieredVideoConfig = {
    ...config, vquality: "720",
    channels: config.channels.map((channel) => ({ ...channel, models: channel.models.map((model) => ({ ...model, price: undefined, resolutionPrices: [
        { resolution: "720p", unit: "second" as const, amount: "0.1" },
        { resolution: "1080p", unit: "request" as const, amount: "3" },
        { resolution: "4K", unit: "second" as const, amount: "0.8" },
    ] })) })),
};

test("video resolution selects its own seconds/request price, with only explicitly configured fallback", () => {
    const cost = (vquality: string, videoSeconds = "8") => createGenerationCostSnapshot({ ...tieredVideoConfig, vquality, videoSeconds }, "tiers", "node");
    expect(cost("720")).toMatchObject({ resolution: "720p", seconds: 8, price: { amount: "0.1", unit: "second" } });
    expect(cost("1080p", "-1")).toMatchObject({ resolution: "1080p", price: { amount: "3", unit: "request" } });
    expect(cost("4K")).toMatchObject({ resolution: "2160p", price: { amount: "0.8", unit: "second" } });
    expect(cost("480").price).toBeUndefined();
    const fallback = { ...tieredVideoConfig, channels: tieredVideoConfig.channels.map((channel) => ({ ...channel, models: channel.models.map((model) => ({ ...model, price: { unit: "request" as const, amount: "0" } })) })) };
    expect(createGenerationCostSnapshot({ ...fallback, vquality: "480" }, "tiers", "node").price).toEqual({ unit: "request", amount: "0" });
});

test("native Seedance draft prices the forced 480p parameter, not the formal resolution", () => {
    const draftConfig = { ...tieredVideoConfig, model: "relay-b::dreamina-seedance-2-5-260628", vquality: "1080", seedanceChannelId: "relay-b", seedance: { ...config.seedance, draft: true }, channels: tieredVideoConfig.channels.map((channel) => ({ ...channel, apiFormat: "volcengine" as const, models: channel.models.map((model) => ({ ...model, name: "dreamina-seedance-2-5-260628", resolutionPrices: [...model.resolutionPrices, { resolution: "480p", unit: "second" as const, amount: "0.01" }] })) })) };
    expect(createGenerationCostSnapshot(draftConfig, "draft", "node")).toMatchObject({ resolution: "480p", price: { unit: "second", amount: "0.01" } });
});

test("image prices use node pixel presets or Gemini size, exact pixel price takes priority", () => {
    const imageConfig = { ...config, size: "2048x1152", geminiImageSize: "4K", channels: config.channels.map((channel) => ({ ...channel, models: channel.models.map((model) => ({ ...model, capability: "image" as const, price: undefined, resolutionPrices: [
        { resolution: "1K", unit: "request" as const, amount: "0.1" },
        { resolution: "2K", unit: "request" as const, amount: "0.2" },
        { resolution: "4K", unit: "request" as const, amount: "0.4" },
        { resolution: "1024x1024", unit: "request" as const, amount: "0.15" },
        { resolution: "512", unit: "request" as const, amount: "0.05" },
    ] })) })) };
    expect(createGenerationCostSnapshot(imageConfig, "image-tier", "node")).toMatchObject({ resolution: "2K", size: "2048x1152", price: { amount: "0.2" } });
    expect(createGenerationCostSnapshot({ ...imageConfig, size: "1536x1024" }, "image-tier", "node")).toMatchObject({ resolution: "1K", price: { amount: "0.1" } });
    expect(createGenerationCostSnapshot({ ...imageConfig, size: "1024x1024" }, "image-tier", "node").price?.amount).toBe("0.15");
    const geminiConfig = { ...imageConfig, model: "relay-b::gemini-3.1-flash-image-preview", channels: imageConfig.channels.map((channel) => ({ ...channel, models: channel.models.map((model) => ({ ...model, name: "gemini-3.1-flash-image-preview" })) })) };
    expect(createGenerationCostSnapshot(geminiConfig, "gemini-tier", "node")).toMatchObject({ resolution: "4K", price: { amount: "0.4" } });
    expect(createGenerationCostSnapshot({ ...geminiConfig, geminiImageSize: "512" }, "gemini-tier", "node")).toMatchObject({ resolution: "512", price: { amount: "0.05" } });
    expect(createGenerationCostSnapshot({ ...imageConfig, size: "auto" }, "image-tier", "node").price).toBeUndefined();
});

test("submitted resolution and rate stay frozen through confirmation, persistence, channel and type filters", async () => {
    const video = createGenerationCostSnapshot(tieredVideoConfig, "tier-persistence", "node");
    await recordGenerationSubmitted(video);
    tieredVideoConfig.channels[1].models[0].resolutionPrices[0].amount = "0.9";
    await recordReceivedGeneration(video, { url: "blob:video", storageKey: "video:tiered" });
    expect(generationCostMicros(record(video.id))).toBe(800000);
    expect(record(video.id).resolution).toBe("720p");
    useGenerationCostStore.setState({ records: [] });
    await useGenerationCostStore.getState().load();
    expect(record(video.id).price?.amount).toBe("0.1");
    const image = { ...record(video.id), id: "image-filter", capability: "image" as const, resolution: "2K" };
    const list = [record(video.id), image];
    expect(filterCostRecords(list, undefined, undefined, "image")).toEqual([image]);
    expect(filterCostRecords(list, undefined, undefined, "video")).toEqual([record(video.id)]);
    expect(filterCostRecords(list)).toHaveLength(2);
    const otherChannel = createGenerationCostSnapshot({ ...tieredVideoConfig, model: "relay-a::same-model" }, "channels", "node");
    expect(otherChannel).toMatchObject({ channelId: "relay-a", price: { amount: "0.1" } });
    expect(createGenerationCostSnapshot(tieredVideoConfig, "channels", "node").price?.amount).toBe("0.9");
    tieredVideoConfig.channels[1].models[0].resolutionPrices[0].amount = "0.1";
});

test("submission uses selected channel and node parameters; failure cancels, recovered success confirms once", async () => {
    const snapshot = createGenerationCostSnapshot(config, "project", "node");
    await recordReceivedGeneration(snapshot, { url: "blob:local", storageKey: "video:file" });
    expect(record(snapshot.id)).toBeUndefined(); // A script returning a file without a POST is not a submitted generation.
    await recordGenerationSubmitted(snapshot);
    expect(record(snapshot.id).status).toBe("pending");
    expect(record(snapshot.id).channelName).toBe("渠道乙");
    expect(generationCostMicros(record(snapshot.id))).toBe(4240000); // 8 node seconds, regardless of output duration.
    const submittedAt = record(snapshot.id).submittedAt;
    await cancelFailedGenerationCosts("project", [node("error")]);
    expect(record(snapshot.id).status).toBe("cancelled");
    await recordReceivedGeneration(snapshot, { url: "https://upstream.example.com/result" });
    expect(record(snapshot.id).status).toBe("cancelled"); // A result URL alone has not been saved in the frontend.
    await recordReceivedGeneration(snapshot, { url: "blob:saved", storageKey: "video:file" });
    await recordReceivedGeneration(snapshot, { url: "blob:recovered", storageKey: "video:reloaded" });
    await recordGenerationSubmitted(snapshot);
    expect(record(snapshot.id).status).toBe("success");
    expect(record(snapshot.id).submittedAt).toBe(submittedAt);
    expect(useGenerationCostStore.getState().records.filter((item) => item.id === snapshot.id)).toHaveLength(1);
    expect(JSON.stringify(data.get(snapshot.id))).not.toContain("private-b");
    expect(copyNodeMetadata({ generationCost: snapshot })?.generationCost).toBeUndefined();
});

test("retry creates a new charge with new price; existing history retains the submitted price", async () => {
    const old = createGenerationCostSnapshot(config, "history", "old");
    await recordGenerationSubmitted(old);
    const updated = { ...config, channels: config.channels.map((channel) => ({ ...channel, models: channel.models.map((model) => ({ ...model, price: { unit: "second" as const, amount: "1" } })) })) };
    const next = createGenerationCostSnapshot(updated, "history", "new");
    await recordGenerationSubmitted(next);
    expect(next.id).not.toBe(old.id);
    expect(generationCostMicros(record(old.id))).toBe(4240000);
    expect(generationCostMicros(record(next.id))).toBe(8000000);
});

test("batch image partial failure cancels only the failed submitted slot", async () => {
    const imageConfig = { ...config, channels: config.channels.map((channel) => ({ ...channel, models: channel.models.map((model) => ({ ...model, capability: "image" as const, price: { unit: "request" as const, amount: "0.2" } })) })) };
    const first = createGenerationCostSnapshot(imageConfig, "batch", "node", "one");
    const second = createGenerationCostSnapshot(imageConfig, "batch", "node", "two");
    await recordGenerationSubmitted(first);
    await recordGenerationSubmitted(second);
    await recordReceivedGeneration(first, { url: "blob:one", storageKey: "image:one" });
    await cancelFailedGenerationCosts("batch", [{ ...node("success"), metadata: { status: "success", images: [{ id: "two", status: "error", content: "", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "" }] } }]);
    expect(record(first.id).status).toBe("success");
    expect(record(second.id).status).toBe("cancelled");
    expect(generationCostMicros(record(first.id))).toBe(200000);
});

test("automatic duration stays unpriced and date boundaries filter by submission, not receipt", async () => {
    const snapshot = createGenerationCostSnapshot({ ...config, videoSeconds: "-1" }, "auto", "node");
    await recordGenerationSubmitted(snapshot);
    expect(generationCostMicros(record(snapshot.id))).toBeUndefined();
    const entry = { ...record(snapshot.id), submittedAt: "2026-10-18T16:00:00.000Z", receivedAt: "2026-10-20T16:00:00.000Z" } satisfies GenerationCostRecord;
    expect(filterCostRecords([entry], Date.parse("2026-10-18T16:00:00Z"), Date.parse("2026-10-19T16:00:00Z"))).toHaveLength(1);
    expect(filterCostRecords([entry], undefined, Date.parse("2026-10-18T16:00:00Z"))).toHaveLength(0);
});

test("restoring an interrupted canvas does not cancel a pending estimate before recovery runs", async () => {
    const snapshot = createGenerationCostSnapshot(config, "restore", "node");
    await recordGenerationSubmitted(snapshot);
    await cancelFailedGenerationCosts("restore", [node("error")], []);
    expect(record(snapshot.id).status).toBe("pending");
    await cancelFailedGenerationCosts("restore", [node("error")], [{ ...node("error"), metadata: { status: "loading" } }]);
    expect(record(snapshot.id).status).toBe("cancelled");
});

test("reloading the ledger preserves submission parameters, cancellations and unique charge IDs", async () => {
    const before = useGenerationCostStore.getState().records.map((entry) => ({ id: entry.id, status: entry.status, seconds: entry.seconds })).sort((a, b) => a.id.localeCompare(b.id));
    useGenerationCostStore.setState({ records: [] });
    await useGenerationCostStore.getState().load();
    const after = useGenerationCostStore.getState().records.map((entry) => ({ id: entry.id, status: entry.status, seconds: entry.seconds })).sort((a, b) => a.id.localeCompare(b.id));
    expect(after).toEqual(before);
});

test("the outgoing request sees a pending estimate before being sent", async () => {
    const { backgroundFetch } = await import("../src/services/api/background-tasks");
    const snapshot = createGenerationCostSnapshot(config, "transport", "node");
    useConfigStore.setState({ config: { ...config, proxyEnabled: false } });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
        expect(record(snapshot.id).status).toBe("pending");
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
        await backgroundFetch("https://relay.example.com/generate", { method: "POST", body: "{}" }, { projectId: "transport", nodeId: "node", billing: snapshot, snapshot: () => node("success") }, "openai-video");
    } finally { globalThis.fetch = originalFetch; }
});

test("uploading a replacement file into a node cannot confirm the original generation's estimate", async () => {
    const { acknowledgeSavedBackgroundTasks } = await import("../src/services/api/background-tasks");
    const snapshot = createGenerationCostSnapshot(config, "replacement", "node");
    await recordGenerationSubmitted(snapshot);
    const uploaded: CanvasNodeData = { ...node("success"), metadata: { status: "success", content: "blob:manual-upload", storageKey: "video:manual-upload" } };
    stores.get("background_tasks")!.set("task", { id: "task", key: "key", base: "https://proxy.example.com", projectId: "replacement", nodeId: "node", kind: "openai-video", billing: snapshot, snapshot: uploaded });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    try {
        await acknowledgeSavedBackgroundTasks("replacement", [uploaded]);
        expect(record(snapshot.id).status).toBe("pending");
    } finally { globalThis.fetch = originalFetch; stores.get("background_tasks")!.clear(); }
});
