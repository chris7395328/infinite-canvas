import { afterAll, expect, mock, test } from "bun:test";
import type { GenerationCostRecord } from "../src/types/generation-cost";
import type { CanvasNodeData } from "../src/types/canvas";

const data = new Map<string, unknown>();
mock.module("localforage", () => ({ default: { config: () => {}, createInstance: () => ({
    getItem: async (key: string) => structuredClone(data.get(key) ?? null),
    setItem: async (key: string, value: unknown) => { data.set(key, structuredClone(value)); },
    iterate: async (callback: (value: unknown) => void) => { for (const value of data.values()) callback(structuredClone(value)); },
}) } }));
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
afterAll(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

const { defaultConfig, normalizeChannelModels, useConfigStore } = await import("../src/stores/use-config-store");
const { createGenerationCostSnapshot, recordGenerationSubmitted, recordReceivedGeneration, cancelFailedGenerationCosts } = await import("../src/services/generation-cost");
const { useGenerationCostStore } = await import("../src/stores/use-generation-cost-store");
const { generationCostMicros, filterCostRecords } = await import("../src/lib/generation-cost");
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
