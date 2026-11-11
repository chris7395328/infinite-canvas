import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createMemoryTasks } from "./memory-tasks.js";

const listen = async (handler) => { const server = createServer(handler); await new Promise((done) => server.listen(0, "127.0.0.1", done)); return { server, base: `http://127.0.0.1:${server.address().port}` }; };
const close = async (server) => { server.closeAllConnections(); await new Promise((done) => server.close(done)); };

test("new Seedance series polls normal/final IDs, downloads authenticated content and restores disk receipts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canvas-series-"));
    const previous = process.env.CANVAS_TASK_DIR; process.env.CANVAS_TASK_DIR = dir;
    const posts = []; const queries = []; const downloads = [];
    const upstream = await listen(async (req, res) => {
        assert.equal(req.headers.authorization, "Bearer fixture-series-key");
        if (req.method === "POST") {
            let raw = ""; for await (const chunk of req) raw += chunk;
            posts.push({ path: req.url, body: JSON.parse(raw) });
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ id: req.url.includes("final-conversions") ? "task_final" : "task_draft", status: "queued" })); return;
        }
        assert.equal(req.headers["content-type"], undefined);
        assert.equal(req.headers["idempotency-key"], undefined);
        if (req.url.endsWith("/content")) {
            downloads.push(req.url); res.setHeader("content-type", "video/mp4"); res.end("fixture-series-video"); return;
        }
        queries.push(req.url); res.setHeader("content-type", "application/json");
        // No public result URL: this is the exact newly documented completion contract.
        res.end(JSON.stringify({ id: req.url.split("/").at(-1), status: "completed", usage: { video_tokens: 38430 } }));
    });
    const proxies = [];
    try {
        const start = async () => { const handle = createMemoryTasks(); const proxy = await listen((req, res) => void handle(req, res)); proxies.push(proxy.server); return proxy.base; };
        const proxy = await start();
        const jobs = [];
        for (const formal of [false, true]) {
            const id = randomUUID(); const auth = { "x-canvas-task-key": randomUUID() };
            const url = `${proxy}/_tasks/${id}`;
            const target = upstream.base + (formal ? "/v1/final-conversions/task_own_draft" : "/v1/videos");
            assert.equal((await fetch(url, { method: "POST", headers: { ...auth, "x-canvas-target-url": target, "x-canvas-video-protocol": "seedance-series", authorization: "Bearer fixture-series-key", "content-type": "application/json", "idempotency-key": randomUUID() }, body: JSON.stringify(formal ? { quote: "quote_fixture" } : { model: "seedance-2.5", draft: true }) })).status, 202);
            jobs.push({ id, auth, url, formal });
        }
        for (const job of jobs) {
            let state;
            for (let i = 0; i < 600; i++) { state = await (await fetch(job.url, { headers: job.auth })).json(); if (["completed", "failed"].includes(state.state)) break; await new Promise((done) => setTimeout(done, 25)); }
            assert.equal(state.state, "completed", state.error);
            const restored = await start();
            const result = await fetch(`${restored}/_tasks/${job.id}/result`, { headers: job.auth });
            assert.equal(result.headers.get("content-type"), "video/mp4");
            assert.equal(result.headers.get("x-canvas-upstream-id"), job.formal ? "task_final" : "task_draft");
            assert.equal(await result.text(), "fixture-series-video");
            assert.ok(!(await readFile(join(dir, job.id + ".json"), "utf8")).includes("fixture-series-key"));
        }
        assert.equal(posts.length, 2);
        assert.deepEqual(queries.sort(), ["/v1/final-videos/task_final", "/v1/videos/task_draft"]);
        assert.deepEqual(downloads.sort(), ["/v1/final-videos/task_final/content", "/v1/videos/task_draft/content"]);
    } finally { for (const server of proxies) await close(server); await close(upstream.server); if (previous === undefined) delete process.env.CANVAS_TASK_DIR; else process.env.CANVAS_TASK_DIR = previous; await rm(dir, { recursive: true, force: true }); }
});

test("Seedance series terminal failure reaches the task error without downloading or creating again", async () => {
    let creates = 0;
    const upstream = await listen(async (req, res) => {
        creates++; assert.equal(req.method, "POST"); for await (const chunk of req) { /* fixture */ }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: "task_failed", status: "failed", error: { message: "编辑视频规格不符" } }));
    });
    const handle = createMemoryTasks(); const proxy = await listen((req, res) => void handle(req, res));
    try {
        const auth = { "x-canvas-task-key": randomUUID() }; const url = `${proxy.base}/_tasks/${randomUUID()}`;
        await fetch(url, { method: "POST", headers: { ...auth, "x-canvas-target-url": upstream.base + "/v1/videos", "x-canvas-video-protocol": "seedance-series" }, body: "{}" });
        let state;
        for (let i = 0; i < 100; i++) { state = await (await fetch(url, { headers: auth })).json(); if (state.state === "failed") break; await new Promise((done) => setTimeout(done, 10)); }
        assert.equal(state.state, "failed"); assert.match(state.error, /编辑视频规格不符/); assert.equal(creates, 1);
    } finally { await close(proxy.server); await close(upstream.server); }
});

test("Seedance customer rejection retains code, public task ID and request ID through polling and disk recovery", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canvas-series-rejection-"));
    const previous = process.env.CANVAS_TASK_DIR; process.env.CANVAS_TASK_DIR = dir;
    let creates = 0; let queries = 0;
    const upstream = await listen(async (req, res) => {
        assert.equal(req.headers.authorization, "Bearer fixture-rejection-key");
        res.setHeader("content-type", "application/json");
        if (req.method === "POST") {
            for await (const chunk of req) { /* drain fixture */ }
            creates++;
            res.end(JSON.stringify({ id: "task_customer_rejected", status: "queued" })); return;
        }
        assert.equal(req.url, "/v1/videos/task_customer_rejected"); queries++;
        res.end(JSON.stringify({ id: "task_customer_rejected", status: "failed", request_id: "req_public_rejection", error: { code: "video_submission_rejected", message: "提交被拒绝：生成服务未提供可公开的明确原因。" } }));
    });
    const proxies = [];
    try {
        const start = async () => { const handle = createMemoryTasks(); const proxy = await listen((req, res) => void handle(req, res)); proxies.push(proxy.server); return proxy.base; };
        const base = await start(); const id = randomUUID(); const auth = { "x-canvas-task-key": randomUUID() };
        const url = `${base}/_tasks/${id}`;
        assert.equal((await fetch(url, { method: "POST", headers: { ...auth, "x-canvas-target-url": upstream.base + "/v1/videos", "x-canvas-video-protocol": "seedance-series", authorization: "Bearer fixture-rejection-key", "content-type": "application/json" }, body: JSON.stringify({ model: "seedance-2.5", mode: "videoEdit2video", duration: 0, aspect_ratio: "adaptive" }) })).status, 202);
        let state;
        for (let i = 0; i < 600; i++) { state = await (await fetch(url, { headers: auth })).json(); if (state.state === "failed") break; await new Promise(done => setTimeout(done, 25)); }
        assert.equal(state.state, "failed");
        for (const detail of ["video_submission_rejected", "提交被拒绝", "平台任务ID：task_customer_rejected", "Request ID: req_public_rejection"]) assert.ok(state.error.includes(detail), state.error);
        assert.equal(state.upstreamId, "task_customer_rejected");
        const saved = await readFile(join(dir, id + ".json"), "utf8");
        assert.ok(saved.includes("video_submission_rejected")); assert.ok(!saved.includes("fixture-rejection-key"));
        const restored = await start();
        const recovered = await (await fetch(`${restored}/_tasks/${id}`, { headers: auth })).json();
        assert.equal(recovered.error, state.error); assert.equal(recovered.upstreamId, state.upstreamId);
        assert.equal(creates, 1); assert.equal(queries, 1);
    } finally { for (const server of proxies) await close(server); await close(upstream.server); if (previous === undefined) delete process.env.CANVAS_TASK_DIR; else process.env.CANVAS_TASK_DIR = previous; await rm(dir, { recursive: true, force: true }); }
});

test("scripted draft result retains public platform ID across disk restart and never exposes provider auth to media", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canvas-draft-metadata-"));
    const previous = process.env.CANVAS_TASK_DIR; process.env.CANVAS_TASK_DIR = dir;
    let creates = 0; let base;
    const upstream = await listen(async (req, res) => {
        if (req.url === "/v1/videos") {
            for await (const chunk of req) { /* drain fixture */ }
            creates++; assert.equal(req.method, "POST"); assert.equal(req.headers.authorization, "Bearer fixture-platform-key");
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ id: "task_PLATFORM_DRAFT", status: "completed", video_url: base + "/draft.mp4?sig=a%2Fb+z" })); return;
        }
        assert.equal(req.url, "/draft.mp4?sig=a%2Fb+z"); assert.equal(req.headers.authorization, undefined);
        res.setHeader("content-type", "video/mp4"); res.end("fixture-draft-video");
    }); base = upstream.base;
    const proxies = [];
    try {
        const start = async () => { const handle = createMemoryTasks(); const proxy = await listen((req, res) => void handle(req, res)); proxies.push(proxy.server); return proxy.base; };
        const first = await start(); const id = randomUUID(); const auth = { "x-canvas-task-key": randomUUID() };
        const url = first + "/_tasks/" + id;
        assert.equal((await fetch(url, { method: "POST", headers: { ...auth, "x-canvas-target-url": base + "/v1/videos", "x-canvas-video-protocol": "json-video", "x-canvas-video-public-result": "1", authorization: "Bearer fixture-platform-key", "content-type": "application/json" }, body: JSON.stringify({ model: "doubao-seedance-2-5-260628", draft: true }) })).status, 202);
        let state;
        for (let i = 0; i < 100; i++) { state = await (await fetch(url, { headers: auth })).json(); if (state.state === "completed") break; await new Promise((done) => setTimeout(done, 10)); }
        assert.equal(state.state, "completed"); assert.equal(state.upstreamId, "task_PLATFORM_DRAFT");
        const restored = await start();
        const response = await fetch(restored + "/_tasks/" + id + "/result", { headers: auth });
        assert.equal(response.headers.get("x-canvas-upstream-id"), "task_PLATFORM_DRAFT");
        assert.equal(await response.text(), "fixture-draft-video");
        assert.equal(creates, 1);
        assert.ok(!(await readFile(join(dir, id + ".json"), "utf8")).includes("fixture-platform-key"));
    } finally { for (const server of proxies) await close(server); await close(upstream.server); if (previous === undefined) delete process.env.CANVAS_TASK_DIR; else process.env.CANVAS_TASK_DIR = previous; await rm(dir, { recursive: true, force: true }); }
});
