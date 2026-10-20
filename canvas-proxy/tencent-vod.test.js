import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpConnection } from "tencentcloud-sdk-nodejs-common/tencentcloud/common/http/http_connection.js";
import { createMemoryTasks } from "./memory-tasks.js";
import { createVodCaller, generateTencentVod, vodRequest } from "./tencent-vod.js";

const fixture = () => ({ model: "1.5-pro", prompt: "第一张图的人物走进第二张图的场景", params: { seconds: 10, resolution: "1080p", ratio: "16:9", mode: "reference", generateAudio: true }, tencentVod: { subAppId: "123456", secretId: "fixture-id", secretKey: "fixture-secret", groupId: "canvas-fixture", usePrivateAssets: true }, references: [{ kind: "image", source: "data:image/png;base64,AQ==" }, { kind: "image", source: "data:image/png;base64,Ag==" }] });
const listen = async (handler) => { const server = createServer(handler); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); return { server, base: `http://127.0.0.1:${server.address().port}` }; };
const close = async (server) => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); };
const immediate = async () => {};

test("VOD versions and node parameters map only to documented fields", () => {
    const input = fixture();
    const { body } = vodRequest(input);
    assert.equal(body.ModelName, "wand-vega-video"); assert.equal(body.ModelVersion, "1.5-pro");
    assert.equal(body.OutputConfig.Duration, 10); assert.equal(body.OutputConfig.Resolution, "1080P");
    assert.equal(body.OutputConfig.StorageMode, "Temporary");
    assert.ok(!("draft" in body) && !("camera_fixed" in body));
    assert.throws(() => vodRequest({ ...input, model: "Seedance2.5-OtherAlias" }), /模型版本/);
    assert.throws(() => vodRequest({ ...input, model: "1.0-pro", params: { ...input.params, seconds: 30 } }), /4～15/);
    assert.equal(vodRequest({ ...input, params: { ...input.params, seconds: -1, resolution: "2160p" } }).body.OutputConfig.Resolution, "4K");
    assert.throws(() => vodRequest({ ...input, params: { ...input.params, resolution: "480p" } }), /分辨率/);
    assert.throws(() => vodRequest({ ...input, params: { ...input.params, mode: "frames" }, references: [...input.references, { kind: "video", source: "https://media.example.com/a.mp4" }] }), /首尾帧/);
});

test("COS and international material registration preserve reference order; create once and poll the same task", async () => {
    const input = fixture();
    const calls = []; let poll = 0; const waits = [];
    const result = await generateTencentVod(input, { wait: async (ms) => waits.push(ms), uploadToCos: async (source) => "https://cos.example.com/" + source.slice(-6) + ".png", call: async (action, body) => {
        calls.push({ action, body: structuredClone(body) });
        if (action === "CreateAigcMaterial") return { TaskId: "material-" + calls.length };
        if (action === "DescribeTaskDetail" && body.TaskId.startsWith("material-")) return { Status: "FINISH", CreateAigcMaterialTask: { ErrCode: 0, Output: { AssetId: "asset-" + body.TaskId } } };
        if (action === "CreateAigcVideoTask") return { TaskId: "original-video" };
        assert.equal(body.TaskId, "original-video");
        if (++poll === 1) { const error = new Error("temporarily unavailable"); error.retryable = true; error.retryAfter = 20000; throw error; }
        return { Status: "FINISH", AigcVideoTask: { ErrCode: 0, Output: { FileInfos: [{ FileType: "png", FileUrl: "https://cdn.example.com/end.png", UsageType: "last_frame_url" }, { FileType: "mp4", FileUrl: "https://cdn.example.com/result.mp4?sig=a%2Fb%2Bc" }] } } };
    } });
    const materials = calls.filter((item) => item.action === "CreateAigcMaterial");
    assert.equal(materials.length, 2); assert.ok(materials.every((item) => item.body.IsRealPerson === "False"));
    assert.ok(waits.includes(20000));
    const creation = calls.filter((item) => item.action === "CreateAigcVideoTask");
    assert.equal(creation.length, 1);
    assert.deepEqual(creation[0].body.FileInfos.map((item) => item.Url), ["asset://asset-material-1", "asset://asset-material-3"]);
    assert.equal(creation[0].body.Prompt, input.prompt);
    assert.equal(result.url, "https://cdn.example.com/result.mp4?sig=a%2Fb%2Bc"); assert.deepEqual(result.headers, {});
});

test("frame roles retain their order and a failed creation is never automatically retried", async () => {
    const input = fixture(); input.params.mode = "frames"; input.tencentVod.usePrivateAssets = false;
    let calls = 0;
    await assert.rejects(generateTencentVod(input, { wait: immediate, uploadToCos: async (source) => "https://cos.example.com/" + source.slice(-6) + ".png", call: async (action, body) => { calls++; assert.equal(action, "CreateAigcVideoTask"); assert.deepEqual(body.FileInfos.map((file) => file.Usage), ["FirstFrame", "LastFrame"]); throw new Error("网络中断，可能已受理"); } }), /网络中断/);
    assert.equal(calls, 1);
});

test("SDK signs each API call and preserves HTTP/JSON error codes, messages and request IDs without credentials", async (t) => {
    const received = [];
    const upstream = await listen(async (req, res) => {
        let body = ""; for await (const chunk of req) body += chunk;
        received.push({ headers: req.headers, body });
        res.setHeader("content-type", "application/json");
        if (req.headers["x-tc-action"] === "DescribeTaskDetail") { res.writeHead(401); res.end(JSON.stringify({ Response: { Error: { Code: "AuthFailure.SignatureFailure", Message: "错误说明 fixture-secret" }, RequestId: "vod-request-401" } })); }
        else res.end(JSON.stringify({ Response: { TaskId: "created-once" } }));
    });
    const original = HttpConnection.doRequestWithSign3;
    t.mock.method(HttpConnection, "doRequestWithSign3", (options) => { assert.equal(options.url, "https://vod.intl.tencentcloudapi.com/"); assert.equal(options.timeout, 0); return original.call(HttpConnection, { ...options, url: upstream.base + "/" }); });
    try {
        const call = await createVodCaller(fixture().tencentVod);
        await call("CreateAigcVideoTask", { SubAppId: 123456 });
        await assert.rejects(call("DescribeTaskDetail", { SubAppId: 123456, TaskId: "created-once" }), (error) => /401.*AuthFailure.SignatureFailure.*错误说明.*vod-request-401/.test(error.message) && !error.message.includes("fixture-secret") && error.retryable === false);
        assert.equal(received.length, 2);
        assert.ok(received.every((item) => item.headers.authorization.startsWith("TC3-HMAC-SHA256 ") && item.headers["x-tc-version"] === "2018-07-17"));
        assert.notEqual(received[0].headers.authorization, received[1].headers.authorization);
    } finally { t.mock.restoreAll(); await close(upstream.server); }
});

test("VOD disk task survives browser disconnect, ACK and restart, and never persists credentials or resubmits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canvas-vod-")); const previous = process.env.CANVAS_TASK_DIR; process.env.CANVAS_TASK_DIR = dir;
    const servers = []; let calls = 0; let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const media = await listen((req, res) => { assert.equal(req.headers.authorization, undefined); res.writeHead(200, { "content-type": "video/mp4" }); res.end("vod-fixture-video"); });
    try {
        const make = async () => { const handler = createMemoryTasks({ generateVod: async (input, { onTask }) => { calls++; assert.equal(input.tencentVod.secretKey, "fixture-secret"); await onTask("vod-original-task"); await gate; return { url: media.base + "/result.mp4", headers: {} }; } }); const item = await listen((req, res) => void handler(req, res)); servers.push(item.server); return item; };
        const first = await make(); const id = randomUUID(); const auth = { "x-canvas-task-key": randomUUID() }; const url = first.base + "/_tasks/" + id;
        const submit = { ...auth, "x-canvas-target-url": "/tencent-vod/video" };
        assert.equal((await fetch(url, { method: "POST", headers: submit, body: JSON.stringify(fixture()) })).status, 202);
        assert.equal((await fetch(url, { method: "POST", headers: submit, body: "duplicate" })).status, 202);
        release(); let state;
        for (let i = 0; i < 100; i++) { state = await (await fetch(url, { headers: auth })).json(); if (state.state === "completed") break; await new Promise((resolve) => setTimeout(resolve, 10)); }
        assert.equal(state.state, "completed"); assert.equal(state.upstreamId, "vod-original-task");
        const second = await make(); const restored = second.base + "/_tasks/" + id;
        assert.equal(await (await fetch(restored + "/result", { headers: auth })).text(), "vod-fixture-video");
        await fetch(restored, { method: "DELETE", headers: auth });
        assert.equal((await (await fetch(restored, { headers: auth })).json()).expiresAt, state.expiresAt);
        assert.equal(calls, 1);
        for (const name of await readdir(dir)) { const text = await readFile(join(dir, name), "utf8"); assert.ok(!text.includes("fixture-secret") && !text.includes("data:image") && !text.includes(fixture().prompt)); }
    } finally { for (const server of servers) await close(server); await close(media.server); if (previous === undefined) delete process.env.CANVAS_TASK_DIR; else process.env.CANVAS_TASK_DIR = previous; await rm(dir, { recursive: true, force: true }); }
});

test("terminal VOD failure reaches the failed Docker receipt with detailed provider message, never another create", async () => {
    let calls = 0;
    const handler = createMemoryTasks({ generateVod: async (input, options) => generateTencentVod({ ...fixture(), references: [] }, { ...options, wait: immediate, call: async (action) => { if (action === "CreateAigcVideoTask") { calls++; return { TaskId: "failed-original" }; } return { RequestId: "failed-request", Status: "FINISH", AigcVideoTask: { ErrCode: -1, ErrCodeExt: "InputSensitiveContent", Message: "素材审核失败" } }; } }) });
    const proxy = await listen((req, res) => void handler(req, res));
    try {
        const auth = { "x-canvas-task-key": randomUUID() }; const url = proxy.base + "/_tasks/" + randomUUID();
        await fetch(url, { method: "POST", headers: { ...auth, "x-canvas-target-url": "/tencent-vod/video" }, body: "{}" });
        let state;
        for (let i = 0; i < 100; i++) { state = await (await fetch(url, { headers: auth })).json(); if (state.state === "failed") break; await new Promise((resolve) => setTimeout(resolve, 10)); }
        assert.equal(state.state, "failed"); assert.match(state.error, /InputSensitiveContent.*素材审核失败.*failed-request/); assert.equal(state.upstreamId, "failed-original"); assert.equal(calls, 1);
    } finally { await close(proxy.server); }
});
