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
