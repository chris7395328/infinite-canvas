import { afterAll, expect, mock, test } from "bun:test";
import axios from "axios";
import { gptImageRequestFields, imagePayloadMime, imageFileExtension, isGptImage26Model, supportsGptMarkup } from "../src/lib/gpt-image";
import { getImageQualityOptions } from "../src/lib/image-quality";
const stores = new Map<string, Map<string, unknown>>();
mock.module("localforage", () => ({ default: { config: () => {}, createInstance: ({ storeName }: { storeName: string }) => {
    if (!stores.has(storeName)) stores.set(storeName, new Map());
    const data = stores.get(storeName)!;
    return { getItem: async (key: string) => data.get(key) ?? null, setItem: async (key: string, value: unknown) => data.set(key, value), removeItem: async (key: string) => data.delete(key), iterate: async (fn: (value: unknown) => void) => { for (const value of data.values()) fn(value); } };
} } }));
const originals = ["localStorage", "window", "Image"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
const originalFetch = globalThis.fetch; const adapter = axios.defaults.adapter;
const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage, location: { href: "https://canvas.example.com", origin: "https://canvas.example.com" }, setTimeout, clearTimeout } });
Object.defineProperty(globalThis, "Image", { configurable: true, value: class {
    naturalWidth = 512; naturalHeight = 512; onload?: () => void;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
} });
afterAll(() => { axios.defaults.adapter = adapter; globalThis.fetch = originalFetch; for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
const { createModelChannel, defaultConfig, useConfigStore } = await import("../src/stores/use-config-store");
const { requestGeneration, requestEdit, parseImagePayload } = await import("../src/services/api/image");
const { buildGenerationConfig } = await import("../src/lib/canvas/canvas-generation-helpers");
const { buildImageGenerationMetadata } = await import("../src/lib/canvas/canvas-node-factory");
const { uploadImage, getImageBlob } = await import("../src/services/image-storage");
const { recoverBackgroundResult } = await import("../src/services/background-task-recovery");
const { historyFileName } = await import("../src/lib/generation-resource-history");
const gif = btoa("GIF89a mock animation frames retained");
const png = "data:image/png;base64,AQID";
const configFor = (model = "gpt-image-2.6-flare") => ({ ...defaultConfig, model: `official::${model}`, imageModel: `official::${model}`, count: "1", size: "auto", proxyEnabled: false, channels: [createModelChannel({ id: "official", baseUrl: "https://api.openai.com", apiKey: "fixture-key", models: [{ name: model, capability: "image" }] })] });
const calls: any[] = [];
function intercept(payload: Record<string, unknown>) {
    calls.length = 0;
    axios.defaults.adapter = async (request) => { calls.push(request); return { data: payload, status: 200, statusText: "OK", headers: {}, config: request }; };
}

test("2.6 models and2.5 snapshots have exact capabilities without upgrading aliases or Gemini", () => {
    for (const model of ["gpt-image-2.6-flare", "official::gpt-image-2.6-sunburst"]) {
        expect(isGptImage26Model(model)).toBe(true);
        expect(getImageQualityOptions(model).map((item) => item.value)).toEqual(["auto", "low", "medium", "high", "xhigh", "max"]);
    }
    expect(getImageQualityOptions("gpt-image-2.5-flare-2026-09-08")).toHaveLength(6);
    expect(isGptImage26Model("relay::image-2.6")).toBe(false);
    expect(supportsGptMarkup("gpt-image-2.6-flare-2026-09-08")).toBe(false);
    expect(gptImageRequestFields("gemini-3-pro-image-preview", { format: "svg", complexity: "high" })).toEqual({ output_format: "png" });
});

test("format rules exclude compression/frame/SVG fields from incompatible outputs", () => {
    expect(gptImageRequestFields("gpt-image-2.6-flare", { format: "gif", compression: "70", frameCount: "12", frameDurationMs: "125", svgModel: "ignored", complexity: "medium" })).toEqual({ output_format: "gif", complexity: "medium", frame_count: 12, frame_duration_ms: 125 });
    expect(gptImageRequestFields("gpt-image-2.6-flare", { format: "webp", compression: "0", frameCount: "16" }, { transparent: true })).toEqual({ output_format: "webp", output_compression: 0 });
    expect(() => gptImageRequestFields("gpt-image-2.6-flare", { format: "gif" }, { transparent: true })).toThrow("透明背景");
    expect(() => gptImageRequestFields("gpt-image-2.6-flare", { format: "svg" }, { edit: true })).toThrow("纯文字");
    expect(() => gptImageRequestFields("gpt-image-2.6-flare", { format: "svg" }, { count: 2 })).toThrow("1张");
    expect(() => gptImageRequestFields("gpt-image-2.6-flare", { format: "gif", frameCount: "17" })).toThrow("2～16");
    expect(() => gptImageRequestFields("gpt-image-2.6-flare", { format: "gif", frameDurationMs: "1" })).toThrow("20");
    expect(() => gptImageRequestFields("gpt-image-2.6-flare", {}, { count: 1.5 })).toThrow("整数");
});

test("native GIF generation sends documented JSON with small per-frame size and preserves animation MIME", async () => {
    const config = { ...configFor(), size: "512x512", quality: "max", gptImage: { format: "gif" as const, frameCount: "9", frameDurationMs: "200", complexity: "low" as const } };
    useConfigStore.setState({ config }); intercept({ data: [{ b64_json: gif }], output_format: "gif" });
    const result = await requestGeneration(config, "循环动画，小猫眨眼");
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].data)).toMatchObject({ model: "gpt-image-2.6-flare", output_format: "gif", complexity: "low", frame_count: 9, frame_duration_ms: 200, size: "512x512", quality: "max" });
    expect(JSON.parse(calls[0].data).response_format).toBeUndefined();
    expect(result[0].dataUrl).toBe(`data:image/gif;base64,${gif}`);
    const stored = await uploadImage(result[0].dataUrl);
    expect(stored.mimeType).toBe("image/gif");
    expect(await (await getImageBlob(stored.storageKey!))!.text()).toBe(atob(gif)); // Never flattened to PNG.
});

test("SVG generation carries optional author model and returns actual XML MIME, not PNG", async () => {
    const config = { ...configFor("gpt-image-2.6-sunburst"), gptImage: { format: "svg" as const, svgModel: "account-selected-author", svgReasoning: "high", complexity: "high" as const } };
    useConfigStore.setState({ config });
    const xml = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg>';
    intercept({ data: [{ b64_json: btoa(xml) }], output_format: "svg" });
    const result = await requestGeneration(config, "线条标志");
    expect(JSON.parse(calls[0].data)).toMatchObject({ model: "gpt-image-2.6-sunburst", output_format: "svg", n: 1, svg: { model: "account-selected-author", reasoning: { effort: "high" } } });
    expect(result[0].dataUrl).toContain("data:image/svg+xml;base64,");
    expect(imageFileExtension("image/svg+xml")).toBe("svg");
    expect(historyFileName({ kind: "image", title: "矢量图", mimeType: "image/svg+xml" } as any)).toEndWith(".svg");
});

test("reference GIF and independent markup PNG use multipart without merging annotation into the inputs", async () => {
    const config = { ...configFor(), gptImage: { format: "gif" as const, markupNodeId: "markup", complexity: "high" as const } };
    useConfigStore.setState({ config }); intercept({ data: [{ b64_json: gif }] });
    const result = await requestEdit(config, "让圈选主体眨眼", [{ id: "source", name: "source.png", type: "image/png", dataUrl: png }, { id: "markup", name: "markup.png", type: "image/png", dataUrl: png }]);
    const body = calls[0].data as FormData;
    expect(body.get("output_format")).toBe("gif");
    expect(body.get("markup")).toBeInstanceOf(File);
    expect(body.get("image")).toBeInstanceOf(File);
    expect(body.get("image[]")).toBeNull();
    expect(body.get("mask")).toBeNull();
    expect(body.get("output_compression")).toBeNull();
    expect(result[0].dataUrl).toContain("image/gif");
    calls.length = 0;
    await expect(requestEdit({ ...config, gptImage: { format: "svg" } }, "edit", [{ id: "i", name: "i.png", type: "image/png", dataUrl: png }])).rejects.toThrow("SVG");
    expect(calls).toHaveLength(0);
});

test("old GPT and Gemini don't receive2.6 parameters, while node and copied metadata retain the selected settings", async () => {
    const config = { ...configFor("gpt-image-2"), gptImage: { format: "gif" as const, complexity: "high" as const } };
    useConfigStore.setState({ config }); intercept({ data: [{ b64_json: "iVBORw0KGgo=" }] });
    await requestGeneration(config, "普通图");
    const body = JSON.parse(calls[0].data);
    expect(body.output_format).toBe("png"); expect(body.complexity).toBeUndefined(); expect(body.frame_count).toBeUndefined();
    const metadata = buildImageGenerationMetadata("generate", config, 1, []);
    expect(buildGenerationConfig(config, { id: "n", type: "image", title: "n", position: { x: 0, y: 0 }, width: 100, height: 100, metadata }, "image").gptImage).toEqual(config.gptImage);
});

test("payload format/sniffing and refresh recovery keep GIF bytes without another generation POST", async () => {
    expect(imagePayloadMime(gif)).toBe("image/gif");
    expect(parseImagePayload({ data: [{ b64_json: btoa("<svg xmlns='http://www.w3.org/2000/svg'/>") }] })[0].dataUrl).toContain("image/svg+xml");
    const requests: string[] = [];
    const node = { id: "node", type: "image" as const, title: "GIF", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { model: "official::gpt-image-2.6-flare", status: "loading" as const, gptImage: { format: "gif" as const } } };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input); requests.push(init?.method || "GET");
        if (url.startsWith("data:")) return originalFetch(input, init);
        if (url.endsWith("/result")) return Response.json({ data: [{ b64_json: gif }] });
        return Response.json({ state: "completed" });
    }) as typeof fetch;
    const saved = await recoverBackgroundResult({ id: "task", key: "key", base: "https://proxy.example.com", nodeId: node.id, projectId: "project", kind: "openai-image", snapshot: node } as any, node, new AbortController().signal);
    expect(saved.metadata?.mimeType).toBe("image/gif");
    expect(requests).not.toContain("POST");
});
