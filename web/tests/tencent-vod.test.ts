import { afterAll, expect, test } from "bun:test";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
afterAll(() => { if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage); else Reflect.deleteProperty(globalThis, "localStorage"); });
const { createModelChannel, defaultConfig, defaultSeedanceConfig, resolveModelRequestConfig, useConfigStore } = await import("../src/stores/use-config-store");
const { defaultTencentVodConfig } = await import("../src/lib/tencent-vod");
const { buildGenerationConfig } = await import("../src/lib/canvas/canvas-generation-helpers");
const { CanvasNodeType } = await import("../src/types/canvas");
const { getTencentVodScript, runModelPlugin } = await import("../src/services/api/model-plugin");
const channel = createModelChannel({ id: "vod", apiFormat: "tencent-vod", models: [{ name: "1.5-pro", capability: "video", script: getTencentVodScript() }], tencentVod: { ...defaultTencentVodConfig, secretId: "vod-id", secretKey: "vod-secret", subAppId: "123456" }, seedance: { ...defaultSeedanceConfig, bridgeUrl: "https://canvas.example.com/canvas-proxy", cosBucket: "fixture-bucket" } });
const config = { ...defaultConfig, model: "vod::1.5-pro", videoModel: "vod::1.5-pro", channels: [channel] };

test("VOD channel config round trips without Bearer key and isolates per-channel secrets and COS", () => {
    const restored = createModelChannel(JSON.parse(JSON.stringify(channel)));
    expect(restored.apiFormat).toBe("tencent-vod"); expect(restored.tencentVod).toEqual(channel.tencentVod);
    expect(restored.seedance?.cosBucket).toBe("fixture-bucket"); expect(restored.models[0].script).toBe(getTencentVodScript());
    expect(useConfigStore.getState().isAiConfigReady(config, config.model)).toBe(true);
    const empty = { ...config, channels: [{ ...channel, tencentVod: { ...defaultTencentVodConfig } }] };
    expect(useConfigStore.getState().isAiConfigReady(empty, empty.model)).toBe(false);
    const resolved = resolveModelRequestConfig({ ...config, seedance: { ...defaultSeedanceConfig, cosBucket: "wrong-provider" } }, config.model);
    expect(resolved.model).toBe("1.5-pro"); expect(resolved.seedance.cosBucket).toBe("fixture-bucket"); expect(resolved.tencentVod?.secretKey).toBe("vod-secret");
});

test("VOD node task type, duration, seed and last-frame settings survive generation config resolution", () => {
    const node = { id: "vod-node", type: CanvasNodeType.Video, title: "VOD", width: 340, height: 191, position: { x: 0, y: 0 }, metadata: { model: "vod::1.5-pro", seconds: "10", vquality: "2160", seedanceTaskType: "edit" as const, seedanceSeed: "42", seedanceReturnLastFrame: true } };
    const prepared = buildGenerationConfig(config, node, "video");
    const resolved = resolveModelRequestConfig(prepared, prepared.model);
    expect(resolved.tencentVod).toMatchObject({ taskType: "edit", seed: "42", returnLastFrame: true });
    expect(resolved.videoSeconds).toBe("-1"); expect(resolved.vquality).toBe("2160");
});

test("VOD script sends one backend submission with node references and settings, not a Bearer or an upstream create", async () => {
    const previousFetch = globalThis.fetch;
    useConfigStore.setState({ config: { ...config, proxyEnabled: false } });
    const requests: Array<{ url: string; body?: Record<string, unknown>; headers: Headers }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const req = new Request(input, init);
        requests.push({ url: req.url, body: req.method === "POST" ? JSON.parse(await req.text()) : undefined, headers: req.headers });
        return req.method === "GET" ? Response.json({ tencentVod: 1 }) : new Response(new Blob(["fixture-video"], { type: "video/mp4" }));
    }) as typeof fetch;
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "https://canvas.example.com/" } } });
    try {
        const result = await runModelPlugin({ capability: "video", script: getTencentVodScript(), config: resolveModelRequestConfig(config, config.model), prompt: "图片1到图片2", images: ["data:image/png;base64,AQ==", "data:image/png;base64,Ag=="], params: { seconds: -1, resolution: "2160p", mode: "reference" } });
        expect(result).toBeInstanceOf(Blob);
        expect(requests.filter((item) => item.body)).toHaveLength(1);
        expect(requests[1].url).toBe("https://canvas.example.com/canvas-proxy/tencent-vod/video");
        expect(requests[1].headers.has("authorization")).toBe(false);
        expect(requests[1].body).toMatchObject({ model: "1.5-pro", params: { seconds: -1, resolution: "2160p" }, references: [{ kind: "image", source: "data:image/png;base64,AQ==" }, { kind: "image", source: "data:image/png;base64,Ag==" }], cos: { cosBucket: "fixture-bucket" } });
    } finally { globalThis.fetch = previousFetch; if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window"); }
});
