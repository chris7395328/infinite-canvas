import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const previousFetch = globalThis.fetch;
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: globalThis.localStorage, location: { href: "https://canvas.example.com", origin: "https://canvas.example.com" } } });
afterAll(() => {
    globalThis.fetch = previousFetch;
    for (const [key, descriptor] of [["localStorage", previousStorage], ["window", previousWindow]] as const) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
});
const { createModelChannel, defaultConfig, defaultSeedanceConfig, isVolcengineSeedance25, useConfigStore } = await import("../src/stores/use-config-store");
const { getSeedanceSeriesScript, isReplayablePluginScript } = await import("../src/services/api/model-plugin");
const { seedanceSeriesCapabilities } = await import("../src/lib/script-video-profile");
const { estimateSeedanceFinal } = await import("../src/services/api/seedance-series");
const { createVideoGenerationTask, pollVideoGenerationTask } = await import("../src/services/api/video");
const { buildGenerationConfig } = await import("../src/lib/canvas/canvas-generation-helpers");
const { buildNodeGenerationContext } = await import("../src/components/canvas/canvas-node-generation");
const { createGenerationCostSnapshot } = await import("../src/services/generation-cost");
const { CanvasNodeType } = await import("../src/types/canvas");
const source = readFileSync(new URL("../src/services/api/seedance-series-script.js", import.meta.url), "utf8").trim();
const base = "http://154.40.44.244:3000";
const proxy = "https://canvas.example.com/canvas-proxy";
function configFor(model = "seedance-2.5") {
    return { ...defaultConfig, model: `platform::${model}`, proxyEnabled: true, proxyUrl: proxy, channels: [createModelChannel({ id: "platform", baseUrl: base, apiKey: "fixture-platform-key", apiFormat: "openai", models: [{ name: model, capability: "video", script: source }] })] };
}
async function execute(options: { model?: string; prompt?: string; images?: string[]; videos?: File[]; audios?: File[]; params?: Record<string, unknown>; seedance?: Record<string, unknown>; proxyVersion?: number } = {}) {
    const creates: Array<{ url: string; body: any; headers: Headers }> = [];
    const uploads: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => { expect(String(input)).toBe(proxy + "/"); return Response.json({ seedanceSeries: options.proxyVersion ?? 1 }); }) as typeof fetch;
    const run = new Function("model", "prompt", "images", "videos", "audios", "params", "seedance", "baseUrl", "apiKey", "http", "signal", "fetch", "uploadToCos", `return (async()=>{${source}\n})();`);
    const result = await run(options.model || "seedance-2.5", options.prompt ?? "图片1在图片2左边\n保留原文", options.images || [], options.videos || [], options.audios || [], { seconds: 8, resolution: "720p", ratio: "16:9", mode: "reference", ...options.params }, { ...defaultSeedanceConfig, ...options.seedance }, base, "fixture-platform-key", { url: (path: string) => `${proxy}/${base}/v1${path}` }, new AbortController().signal,
        async (url: string, init: RequestInit) => { creates.push({ url, body: JSON.parse(String(init.body)), headers: new Headers(init.headers) }); return new Response("fixture-video", { headers: { "content-type": "video/mp4", "x-canvas-upstream-id": "task_platform_draft" } }); },
        async (file: string, kind: string) => { uploads.push(file); return `https://sg-cos.maxai.art/${uploads.length}.${kind === "video" ? "mp4" : kind === "audio" ? "mp3" : "png"}`; });
    return { creates, uploads, result };
}

test("explicit profile matches all four selected IDs without guessing a host or changing aliases", () => {
    expect(getSeedanceSeriesScript()).toBe(source);
    expect(isReplayablePluginScript("video", source)).toBe(false);
    for (const model of ["seedance-2.0", "seedance-2.0-fast", "seedance-2.0-mini", "seedance-2.5"]) {
        const caps = seedanceSeriesCapabilities(source, `platform::${model}`)!;
        expect(caps.maxSeconds).toBe(model === "seedance-2.5" ? 30 : 15);
        expect(isVolcengineSeedance25(configFor(model))).toBe(model === "seedance-2.5");
    }
    expect(seedanceSeriesCapabilities("", "seedance-2.5")).toBeUndefined();
    expect(seedanceSeriesCapabilities(source, "doubao-seedance-2-5-260628")).toBeUndefined();
});

test("all models send one JSON creation with exact model, unchanged prompt and no undocumented Ark fields", async () => {
    for (const model of ["seedance-2.0", "seedance-2.0-fast", "seedance-2.0-mini", "seedance-2.5"]) {
        const { creates } = await execute({ model, seedance: { seed: "42", cameraFixed: true, returnLastFrame: true, outputFormat: "mov", searchEnabled: false }, params: { generateAudio: false, watermark: true } });
        expect(creates).toHaveLength(1);
        expect(creates[0].body).toMatchObject({ model, prompt: "图片1在图片2左边\n保留原文", duration: 8, resolution: "720p", aspect_ratio: "16:9", count: 1, search_enabled: false, generate_audio: false });
        for (const field of ["mode", "video_duration", "content", "omni_reference_task_type", "watermark", "seed", "camera_fixed", "return_last_frame", "output_format", "reference_audios"]) expect(creates[0].body[field]).toBeUndefined();
        expect(creates[0].headers.get("x-canvas-video-protocol")).toBe("seedance-series");
        expect(creates[0].headers.get("x-canvas-video-public-result")).toBeNull();
        expect(creates[0].headers.get("idempotency-key")).toBeNull();
    }
});

test("COS URLs and platform IDs preserve duplicate image positions without private-library registration", async () => {
    const { creates, uploads } = await execute({ images: ["data:first", "asset_own", "data:first", "https://media.example.com/image.png"], videos: [new File(["v"], "ref.mp4")], audios: [new File(["a"], "ref.mp3")] });
    expect(uploads).toHaveLength(4);
    expect(creates[0].body.reference_images).toEqual(["https://sg-cos.maxai.art/1.png", "asset_own", "https://sg-cos.maxai.art/2.png", "https://media.example.com/image.png"]);
    expect(creates[0].body.reference_videos).toEqual(["https://sg-cos.maxai.art/3.mp4"]);
    expect(creates[0].body.reference_audios).toEqual(["https://sg-cos.maxai.art/4.mp3"]);
});

test("edit uses0/adaptive, exactly one video with optional images, and no draft/audio", async () => {
    const { creates } = await execute({ videos: [new File(["v"], "edit.mp4")], images: ["asset_image"], seedance: { taskType: "edit" }, params: { seconds: -1, ratio: "9:16", video_duration: 19.05 } });
    expect(creates[0].body).toMatchObject({ mode: "videoEdit2video", duration: 0, video_duration: 19.05, aspect_ratio: "adaptive", draft: false });
    for (const options of [
        { seedance: { taskType: "edit" } },
        { model: "seedance-2.0", videos: [new File(["v"], "v.mp4")], seedance: { taskType: "edit" } },
        { videos: [new File(["v"], "v.mp4")], audios: [new File(["a"], "a.mp3")], seedance: { taskType: "edit" } },
        { videos: [new File(["v"], "v.mp4")], seedance: { taskType: "edit", draft: true } },
        { videos: [new File(["v"], "v.mp4"), new File(["v"], "v2.mp4")], seedance: { taskType: "edit" } },
    ]) await expect(execute(options)).rejects.toThrow("编辑");
});

test("frame, draft and per-model range validation follows the new guide", async () => {
    const frame = await execute({ model: "seedance-2.0", images: ["asset_first", "asset_last"], params: { mode: "frames" } });
    expect(frame.creates[0].body.mode).toBe("frames2video");
    const draft = await execute({ seedance: { draft: true }, params: { resolution: "1080p" } });
    expect(draft.creates[0].body).toMatchObject({ draft: true, resolution: "480p" });
    expect(draft.result.draftTaskId).toBe("task_platform_draft");
    await expect(execute({ model: "seedance-2.0", params: { seconds: 16 } })).rejects.toThrow("15");
    await expect(execute({ model: "seedance-2.0-mini", params: { resolution: "1080p" } })).rejects.toThrow("分辨率");
    await expect(execute({ model: "seedance-2.0-fast", seedance: { draft: true } })).rejects.toThrow("样片");
    await expect(execute({ params: { seconds: 31 } })).rejects.toThrow("30");
    await expect(execute({ images: Array(31).fill("asset_image") })).rejects.toThrow("数量");
    await expect(execute({ images: ["asset://old-platform"] })).rejects.toThrow();
    await expect(execute({ images: ["http://media.example.com/x.png"] })).rejects.toThrow("HTTPS");
    await expect(execute({ images: ["https://127.0.0.1/x.png"] })).rejects.toThrow("HTTPS");
    await expect(execute({ proxyVersion: 0 })).rejects.toThrow("更新");
});

test("final confirmation sends only an unexpired quote, no stale media or implicit estimate", async () => {
    const expires = Math.floor(Date.now() / 1000) + 600;
    const options = { seedance: { draft: false, draftTaskId: "task_draft", draftQuote: "quote_fixture", draftQuoteExpiresAt: expires }, images: ["data:unreadable"] };
    const { creates, uploads } = await execute(options);
    expect(uploads).toHaveLength(0);
    expect(creates[0].url).toBe(`${proxy}/${base}/v1/final-conversions/task_draft`);
    expect(creates[0].body).toEqual({ quote: "quote_fixture" });
    expect(creates[0].headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    await expect(execute({ ...options, seedance: { ...options.seedance, draftQuoteExpiresAt: 1 } })).rejects.toThrow("报价");
});

test("node submission keeps input duration across copy/retry, independently of edit0 and output billing", async () => {
    const config = configFor();
    const node = { id: "edit", title: "edit", type: CanvasNodeType.Video, position: { x: 0, y: 0 }, width: 340, height: 200, metadata: { model: config.model, seedanceTaskType: "edit" as const, seedanceDraft: true, seconds: "8", size: "1920x1080", seedanceSearchEnabled: false, seedanceVideoDuration: "19.05" } };
    const selected = buildGenerationConfig(config, node, "video");
    expect(selected).toMatchObject({ videoSeconds: "0", size: "auto", seedance: { draft: false, searchEnabled: false, videoDuration: "19.05" } });
    const { copyNodeMetadata } = await import("../src/lib/canvas/canvas-node-factory");
    expect(buildGenerationConfig(config, { ...node, metadata: copyNodeMetadata(node.metadata) }, "video").seedance.videoDuration).toBe("19.05");
    config.channels[0].seedance = { ...defaultSeedanceConfig, videoDuration: "12.5" };
    expect(buildGenerationConfig(config, { ...node, metadata: { ...node.metadata, seedanceVideoDuration: "" } }, "video").seedance.videoDuration).toBe("");
    expect(createGenerationCostSnapshot(selected, "project", node.id).seconds).toBeUndefined();
    const v20 = configFor("seedance-2.0");
    expect(buildGenerationConfig(v20, { ...node, metadata: { ...node.metadata, model: v20.model, seedanceTaskType: "reference" } }, "video").seedance.draft).toBe(false);
});

test("estimate is a separate non-generation request and rejects invalid, failed or expired quotes", async () => {
    const config = configFor(); useConfigStore.setState({ config });
    const quote = { quote: "quote_fixture", amount: "12.35", currency: "CNY", expires_at: Math.floor(Date.now() / 1000) + 600 };
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
        expect(String(url)).toBe(`${proxy}/${base}/v1/final-conversions/task_draft/estimate`);
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-platform-key");
        return Response.json(quote);
    }) as typeof fetch;
    expect(await estimateSeedanceFinal(config, "task_draft")).toEqual({ quote: quote.quote, amount: "12.35", expiresAt: quote.expires_at });
    for (const invalid of [{ ...quote, amount: "" }, { ...quote, currency: "USD" }, { ...quote, expires_at: 1 }]) {
        globalThis.fetch = (async () => Response.json(invalid)) as typeof fetch;
        await expect(estimateSeedanceFinal(config, "task_draft")).rejects.toThrow("报价");
    }
    globalThis.fetch = (async () => Response.json({ error: { message: "样片不可转正片" } }, { status: 409 })) as typeof fetch;
    await expect(estimateSeedanceFinal(config, "task_draft")).rejects.toThrow("样片不可转正片");
});

test("real script entry skips unreadable previous references for final confirmation and returns the downloaded video", async () => {
    const saved = configFor(); useConfigStore.setState({ config: saved });
    const config = { ...saved, seedanceChannelId: "platform", seedance: { ...defaultSeedanceConfig, draft: false, draftTaskId: "task_draft", draftQuote: "quote_fixture", draftQuoteExpiresAt: Math.floor(Date.now() / 1000) + 600 } };
    const submitted: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url) === proxy + "/") return Response.json({ seedanceSeries: 1 });
        expect(String(url)).toBe(`${proxy}/${base}/v1/final-conversions/task_draft`);
        expect(JSON.parse(String(init?.body))).toEqual({ quote: "quote_fixture" });
        submitted.push(String(url));
        return new Response("fixture-video", { headers: { "content-type": "video/mp4", "x-canvas-upstream-id": "task_final" } });
    }) as typeof fetch;
    const task = await createVideoGenerationTask(config, "unused", [{ id: "unreadable-old-image", dataUrl: "" }]);
    expect(submitted).toHaveLength(1);
    expect(await pollVideoGenerationTask(config, task)).toMatchObject({ status: "completed" });
});

test("real creation preserves adaptive ratio and smart duration rather than generic16:9 defaults", async () => {
    const config = { ...configFor("seedance-2.0"), size: "auto", videoSeconds: "-1" };
    useConfigStore.setState({ config });
    let creates = 0;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url) === proxy + "/") return Response.json({ seedanceSeries: 1 });
        expect(String(url)).toBe(`${proxy}/${base}/v1/videos`);
        expect(JSON.parse(String(init?.body))).toMatchObject({ model: "seedance-2.0", duration: -1, aspect_ratio: "adaptive" });
        creates++;
        return new Response("fixture-video", { headers: { "content-type": "video/mp4" } });
    }) as typeof fetch;
    await createVideoGenerationTask(config, "保持画面连贯");
    expect(creates).toBe(1);
});

test("canvas edit video stays a video through node inputs, File, COS upload and the real script JSON", async () => {
    const oldReader = Object.getOwnPropertyDescriptor(globalThis, "FileReader");
    Object.defineProperty(globalThis, "FileReader", { configurable: true, value: class {
        result = ""; onload?: () => void;
        readAsDataURL(file: Blob) { void file.arrayBuffer().then(bytes => { this.result = `data:${file.type};base64,${Buffer.from(bytes).toString("base64")}`; this.onload?.(); }); }
    } });
    try {
        for (const [withImage, durationMs, manual, expected] of [[false, 19050, "", 19.05], [true, 6050, "", 6.05], [true, 19050, "12.345", 12.345], [false, undefined, "28.05", 28.05]] as const) {
            const saved = configFor();
            saved.channels[0].seedance = { ...defaultSeedanceConfig, cosEnabled: true, cosBucket: "fixture-bucket", cosEndpoint: "https://cos.example.com", cosSecretId: "fixture-id", cosSecretKey: "fixture-secret", cosPublicBaseUrl: "https://sg-cos.maxai.art" };
            const node = { id: "edit", type: CanvasNodeType.Video, title: "edit", position: { x: 0, y: 0 }, width: 340, height: 200, metadata: { model: saved.model, seedanceTaskType: "edit" as const, seedanceVideoDuration: manual, seconds: "8", durationMs: 99999, size: "1280x720" } };
            const video = { ...node, id: "video-input", metadata: { content: "https://media.example.com/input.mp4", mimeType: "video/mp4", durationMs } };
            const image = { ...node, id: "image-input", type: CanvasNodeType.Image, metadata: { content: "data:image/png;base64,AQID", mimeType: "image/png" } };
            const nodes = [node, video, ...(withImage ? [image] : [])];
            const edges = [video, ...(withImage ? [image] : [])].map(input => ({ id: input.id, fromNodeId: input.id, toNodeId: node.id }));
            const context = buildNodeGenerationContext(node.id, nodes, edges, "保留动作，把场景改为黄昏");
            expect(context.referenceVideos.map(item => item.id)).toEqual([video.id]);
            expect(context.referenceImages).toHaveLength(withImage ? 1 : 0);
            const config = buildGenerationConfig(saved, node, "video"); useConfigStore.setState({ config });
            const uploads: any[] = []; const creates: any[] = [];
            globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                if (url === proxy + "/") return Response.json({ seedanceSeries: 1 });
                if (url === video.metadata.content) return new Response("fixture-original-video", { headers: { "content-type": "video/mp4" } });
                if (url === proxy + "/seedance/cos-upload") {
                    const body = JSON.parse(String(init?.body)); uploads.push(body);
                    return Response.json({ url: `https://sg-cos.maxai.art/${body.kind}.${body.kind === "video" ? "mp4" : "png"}` });
                }
                expect(url).toBe(`${proxy}/${base}/v1/videos`);
                creates.push(JSON.parse(String(init?.body)));
                return new Response("fixture-result", { headers: { "content-type": "video/mp4" } });
            }) as typeof fetch;
            await createVideoGenerationTask(config, context.prompt, context.referenceImages, { videos: context.referenceVideos, audios: context.referenceAudios });
            expect(creates).toHaveLength(1);
            expect(creates[0]).toMatchObject({ model: "seedance-2.5", mode: "videoEdit2video", duration: 0, video_duration: expected, aspect_ratio: "adaptive", draft: false, reference_videos: ["https://sg-cos.maxai.art/video.mp4"] });
            expect(creates[0].reference_images).toEqual(withImage ? ["https://sg-cos.maxai.art/image.png"] : undefined);
            const uploadedVideo = uploads.find(item => item.kind === "video");
            expect(uploadedVideo.dataUrl).toBe(`data:video/mp4;base64,${Buffer.from("fixture-original-video").toString("base64")}`);
        }
    } finally { if (oldReader) Object.defineProperty(globalThis, "FileReader", oldReader); else Reflect.deleteProperty(globalThis, "FileReader"); }
});

test("wrong-category edit references fail before COS upload or paid POST", async () => {
    await expect(execute({ videos: [new File(["png"], "wrong.png", { type: "image/png" })], seedance: { taskType: "edit" } })).rejects.toThrow("素材类别不匹配");
});

test("script failure includes actual edit parameters without leaking key, prompt, quote or material URLs", async () => {
    const config = { ...configFor(), seedanceChannelId: "platform", seedance: { ...defaultSeedanceConfig, taskType: "edit" as const } };
    useConfigStore.setState({ config });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        if (String(input) === proxy + "/") return Response.json({ seedanceSeries: 1 });
        return new Response("Video submission failed", { status: 400 });
    }) as typeof fetch;
    // Use the real runner with already-public references, so no upload/fee is involved.
    const { runModelPlugin } = await import("../src/services/api/model-plugin");
    let failure = "";
    try { await runModelPlugin({ capability: "video", script: source, config: { ...config, model: "seedance-2.5", baseUrl: base, apiKey: "fixture-platform-key" }, prompt: "private-prompt", videos: ["https://media.example.com/private-video.mp4?signature=secret" as any], params: { seconds: 8, video_duration: 19.05, resolution: "720p", ratio: "16:9" } }); }
    catch (error) { failure = (error as Error).message; }
    expect(failure).toContain("Video submission failed");
    expect(failure).toContain('"mode":"videoEdit2video"');
    expect(failure).toContain('"duration":0');
    expect(failure).toContain('"video_duration":19.05');
    expect(failure).toContain('"reference_videos":1');
    for (const secret of ["fixture-platform-key", "private-prompt", "signature=secret", "private-video.mp4"]) expect(failure).not.toContain(secret);
});

test("unknown or invalid actual input duration stops before any media fetch, COS or paid POST", async () => {
    let requests = 0;
    globalThis.fetch = (async () => { requests++; throw new Error("must not request"); }) as typeof fetch;
    for (const [manual, durationMs] of [["", undefined], ["", 0], ["", NaN], ["", Infinity], ["0", 19050], ["-1", 19050], ["invalid", 19050]] as const) {
        const config = { ...configFor(), seedanceChannelId: "platform", seedance: { ...defaultSeedanceConfig, taskType: "edit" as const, videoDuration: manual } };
        useConfigStore.setState({ config });
        await expect(createVideoGenerationTask(config, "edit", [], { videos: [{ id: "source", name: "input.mp4", type: "video/mp4", url: "https://media.example.com/input.mp4", durationMs }] })).rejects.toThrow("输入视频实际时长");
    }
    expect(requests).toBe(0);
});

test("script requires positive actual duration, permits explicit setting, and ignores it outside edit", async () => {
    for (const value of [undefined, "", 0, -1, NaN, Infinity]) await expect(execute({ videos: [new File(["v"], "ref.mp4")], seedance: { taskType: "edit" }, params: { video_duration: value } })).rejects.toThrow("video_duration");
    const manual = await execute({ videos: [new File(["v"], "ref.mp4")], seedance: { taskType: "edit", videoDuration: "19.05" } });
    expect(manual.creates[0].body.video_duration).toBe(19.05);
    const regular = await execute({ seedance: { videoDuration: "19.05" }, params: { video_duration: 19.05 } });
    expect(regular.creates[0].body.video_duration).toBeUndefined();
});

test("other custom video scripts do not acquire the series edit-duration requirement", async () => {
    const config = configFor();
    config.channels[0].models[0].script = 'if (params.video_duration !== undefined) throw new Error("unexpected duration"); return new Blob(["fixture"], {type:"video/mp4"});';
    config.channels[0].seedance = { ...defaultSeedanceConfig, taskType: "edit" };
    useConfigStore.setState({ config });
    const task = await createVideoGenerationTask(config, "other provider");
    expect(await pollVideoGenerationTask(config, task)).toMatchObject({ status: "completed" });
});

test("shared edit UI and both node panels preserve the editable actual-duration field", () => {
    const panel = readFileSync(new URL("../src/components/video-settings-panel.tsx", import.meta.url), "utf8");
    expect(panel).toContain('seriesEdit ? "输入视频实际时长（秒）"');
    expect(panel).toContain('step={allowEmpty ? "any" : 1}');
    expect(panel).toContain('<SecondsInput value={inputVideoSeconds}');
    expect(panel).toContain('value === undefined ? "" : String(value)');
    expect(panel).toContain('step={0.001} value={Number.isFinite(inputVideoSeconds) ? inputVideoSeconds : null}');
    expect(panel).toContain('onConfigChange("seedanceVideoDuration", String(Array.isArray(value) ? value[0] : value))');
    for (const file of ["canvas-node-prompt-panel.tsx", "canvas-config-node-panel.tsx"]) {
        const nodePanel = readFileSync(new URL(`../src/components/canvas/${file}`, import.meta.url), "utf8");
        expect(nodePanel).toContain('return { seedanceVideoDuration: value }');
        expect(nodePanel).toContain('videoDuration: node.metadata?.seedanceVideoDuration ?? seedance.videoDuration');
    }
});

test("old saved script cannot send an edit JSON without actual duration even when params already contain it", async () => {
    const { runModelPlugin } = await import("../src/services/api/model-plugin");
    const config = { ...configFor(), model: "seedance-2.5", baseUrl: base, apiKey: "fixture-platform-key" };
    useConfigStore.setState({ config });
    let requests = 0;
    globalThis.fetch = (async () => { requests++; return new Response("must-not-submit"); }) as typeof fetch;
    for (const field of [{}, { video_duration: 0 }, { video_duration: "19.05" }]) {
        const old = '// @canvas-video-profile seedance-series\nreturn fetch(http.url("/videos"), {method:"POST",headers:{"Content-Type":"application/json","x-canvas-video-protocol":"seedance-series"},body:JSON.stringify(' + JSON.stringify({ model: "seedance-2.5", mode: "videoEdit2video", duration: 0, ...field }) + ')});';
        await expect(runModelPlugin({ capability: "video", script: old, config, params: { video_duration: 19.05 } })).rejects.toThrow("当前模型已保存的调用脚本");
    }
    expect(requests).toBe(0);
});
