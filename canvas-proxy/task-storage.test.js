import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { createMemoryTasks, responseError } from "./memory-tasks.js";
import { createTaskStorage } from "./task-storage.js";

const listen = async handler => {
    const server = createServer(handler);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    return { server, base: `http://127.0.0.1:${server.address().port}` };
};
const close = async server => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };

test("disk results survive a new server, ACK and duplicate POST; no request secrets stored", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canvas-persistence-"));
    const previous = process.env.CANVAS_TASK_DIR;
    process.env.CANVAS_TASK_DIR = dir;
    let calls = 0;
    const upstream = await listen(async (req, res) => {
        for await (const chunk of req) { /* drain fixture request */ }
        calls++;
        res.writeHead(200, { "content-type": "video/mp4" }); res.end("fixture-video-payload");
    });
    const servers = [];
    try {
        const create = async () => {
            const handle = createMemoryTasks();
            const item = await listen((req, res) => void handle(req, res).catch(error => { res.writeHead(500); res.end(error.message); }));
            servers.push(item.server); return item;
        };
        const first = await create();
        const id = randomUUID();
        const headers = { "x-canvas-task-key": randomUUID() };
        const submission = { ...headers, "x-canvas-target-url": upstream.base, Authorization: "Bearer fixture-secret-never-on-disk" };
        assert.equal((await fetch(`${first.base}/_tasks/${id}`, { method: "POST", headers: submission, body: "fixture-private-prompt" })).status, 202);
        let state;
        for (let index = 0; index < 100; index++) {
            state = await (await fetch(`${first.base}/_tasks/${id}`, { headers })).json();
            if (state.state === "completed") break;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(state.state, "completed");
        assert.equal(state.storage, "disk");
        const second = await create(); // same mapped directory, no original in-memory Map
        const task = `${second.base}/_tasks/${id}`;
        assert.equal(await (await fetch(`${task}/result`, { headers })).text(), "fixture-video-payload");
        assert.equal((await fetch(task, { method: "DELETE", headers })).status, 200);
        const after = await (await fetch(task, { headers })).json();
        assert.equal(after.expiresAt, state.expiresAt);
        assert.equal(await (await fetch(`${task}/result`, { headers })).text(), "fixture-video-payload");
        assert.equal((await fetch(task, { method: "POST", headers: submission, body: "duplicate" })).status, 202);
        assert.equal(calls, 1);
        assert.equal((await fetch(task, { headers: { "x-canvas-task-key": randomUUID() } })).status, 403);
        const metadata = await readFile(join(dir, id + ".json"), "utf8");
        assert.ok(!metadata.includes("fixture-secret") && !metadata.includes("fixture-private-prompt"));
        assert.ok(!metadata.includes(headers["x-canvas-task-key"]));
    } finally {
        for (const server of servers) await close(server);
        await close(upstream.server);
        if (previous === undefined) delete process.env.CANVAS_TASK_DIR; else process.env.CANVAS_TASK_DIR = previous;
        await rm(dir, { recursive: true, force: true });
    }
});

test("expired results are removed on load; unfinished requests become uncertain, never replayed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canvas-retention-"));
    try {
        const store = createTaskStorage(dir);
        const id = randomUUID();
        const task = { id, key: createHash("sha256").update(randomUUID()).digest("hex"), state: "running", createdAt: Date.now(), status: 200, contentType: "video/mp4", controller: new AbortController() };
        await store.save(task);
        await store.collect(task, Readable.from([Buffer.from("fixture-video")]));
        await store.complete(task);
        const [saved] = await createTaskStorage(dir).load();
        assert.equal(saved.state, "completed");
        await store.save(task); // interrupted metadata commit after the final payload rename
        const [repaired] = await createTaskStorage(dir).load();
        assert.equal(repaired.state, "completed");
        assert.equal(repaired.contentType, "application/octet-stream");
        await store.save({ ...saved, finishedAt: Date.now() - 24 * 60 * 60 * 1000 - 1 });
        assert.deepEqual(await createTaskStorage(dir).load(), []);
        assert.deepEqual(await readdir(dir), []);
        await store.save({ ...task, upstreamId: "original-upstream-task" });
        const [interrupted] = await createTaskStorage(dir).load();
        assert.equal(interrupted.state, "failed");
        assert.equal(interrupted.upstreamId, "original-upstream-task");
        assert.match(interrupted.error, /结果不确定/);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("provider error codes and request IDs reach a failed Docker task", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canvas-provider-error-"));
    const previous = process.env.CANVAS_TASK_DIR;
    process.env.CANVAS_TASK_DIR = dir;
    const upstream = await listen(async (req, res) => {
        for await (const chunk of req) { /* drain fixture request */ }
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ ResponseMetadata: { RequestId: "request-123", Error: { Code: "InvalidSignature", Message: "X-Content-Sha256 is missing" } } }));
    });
    const handle = createMemoryTasks();
    const proxy = await listen((req, res) => void handle(req, res));
    try {
        const id = randomUUID();
        const headers = { "x-canvas-task-key": randomUUID() };
        assert.equal((await fetch(`${proxy.base}/_tasks/${id}`, { method: "POST", headers: { ...headers, "x-canvas-target-url": upstream.base }, body: "fixture" })).status, 202);
        let state;
        for (let index = 0; index < 100; index++) {
            state = await (await fetch(`${proxy.base}/_tasks/${id}`, { headers })).json();
            if (state.state === "failed") break;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(state.state, "failed");
        assert.match(state.error, /HTTP 401.*InvalidSignature.*X-Content-Sha256 is missing.*request-123/);
        let saved;
        for (let index = 0; index < 100; index++) {
            saved = JSON.parse(await readFile(join(dir, id + ".json"), "utf8"));
            if (saved.state === "failed") break;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(saved.error, state.error);
    } finally {
        await close(proxy.server);
        await close(upstream.server);
        if (previous === undefined) delete process.env.CANVAS_TASK_DIR; else process.env.CANVAS_TASK_DIR = previous;
        await rm(dir, { recursive: true, force: true });
    }
});

test("common gateway error envelopes expose code and message", () => {
    assert.equal(responseError(Buffer.from(JSON.stringify({ data: { error: { code: "invalid_request_error", message: "Missing model" } }, request_id: "req-42" }))), "invalid_request_error；Missing model；Request ID: req-42");
});
