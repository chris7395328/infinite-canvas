import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { createMemoryTasks, responseError } from "./memory-tasks.js";
import { providerError } from "./provider-error.js";
import { createTaskStorage } from "./task-storage.js";
import { resolveVideoTask } from "./video-tasks.js";

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
    let legacyLength;
    const upstream = await listen(async (req, res) => {
        for await (const chunk of req) { /* drain fixture request */ }
        legacyLength = req.headers["content-length"];
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
        assert.equal(legacyLength, undefined); // Existing task transport does not opt in.
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
        if (req.url === "/plain") {
            res.writeHead(429, { "content-type": "text/plain; charset=utf-8", "retry-after": "7" });
            res.end("大草原，居然是上游模型维护,敬请期待");
            return;
        }
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
        const plainId = randomUUID();
        const plainTask = `${proxy.base}/_tasks/${plainId}`;
        assert.equal((await fetch(plainTask, { method: "POST", headers: { ...headers, "x-canvas-target-url": upstream.base + "/plain" }, body: "fixture" })).status, 202);
        for (let index = 0; index < 100; index++) {
            state = await (await fetch(plainTask, { headers })).json();
            if (state.state === "failed") break;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(state.state, "failed");
        assert.match(state.error, /HTTP 429.*大草原，居然是上游模型维护,敬请期待/);
        for (let index = 0; index < 100; index++) {
            saved = JSON.parse(await readFile(join(dir, plainId + ".json"), "utf8"));
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
    assert.equal(responseError(Buffer.from('"上游模型维护，敬请期待"')), "上游模型维护，敬请期待");
    assert.equal(responseError(Buffer.from("<!DOCTYPE html><html>maintenance</html>")), "");
    assert.equal(responseError(Buffer.from('{"message":')), "");
    assert.equal(providerError({ ResponseMetadata: { RequestId: "pixmax-42", Error: { Code: "SignatureDoesNotMatch", Message: "Signature mismatch" } } }), "SignatureDoesNotMatch；Signature mismatch；Request ID: pixmax-42");
});

test("multipart background POST has exact Content-Length and public result omits Bearer", async () => {
    const taskId = "0123456789abcdef0123456789abcdef";
    const body = Buffer.from("--fixture\r\nContent-Disposition: form-data; name=\"prompt\"\r\n\r\ntest\r\n--fixture--\r\n");
    let receivedLength;
    let mediaAuthorization;
    let pollHeaders;
    let upstreamBase;
    const upstream = await listen(async (req, res) => {
        if (req.method === "POST") {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            receivedLength = req.headers["content-length"];
            assert.equal(Number(receivedLength), Buffer.concat(chunks).length);
            assert.match(req.headers["content-type"], /^multipart\/form-data; boundary=fixture$/);
            assert.equal(req.headers["idempotency-key"], "fixture-key-123");
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ code: "1", task_id: taskId, status: "processing" }));
            return;
        }
        if (req.url === `/api/v1/videos/${taskId}`) {
            pollHeaders = req.headers;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ code: "1", task_id: taskId, status: "succeeded", url: upstreamBase + "/media" }));
            return;
        }
        if (req.url === "/media") {
            mediaAuthorization = req.headers.authorization;
            res.writeHead(mediaAuthorization ? 403 : 200, { "content-type": "video/mp4" });
            res.end(mediaAuthorization ? "unexpected Bearer" : "fixture-video");
            return;
        }
        res.writeHead(404); res.end();
    });
    upstreamBase = upstream.base;
    const createHandle = createMemoryTasks();
    const proxy = await listen((req, res) => void createHandle(req, res));
    try {
        const id = randomUUID();
        const key = randomUUID();
        const taskUrl = `${proxy.base}/_tasks/${id}`;
        const headers = { "x-canvas-task-key": key };
        const submitted = await fetch(taskUrl, { method: "POST", headers: {
            ...headers, "x-canvas-target-url": upstream.base + "/api/v1/videos", "x-canvas-video-protocol": "json-video",
            "x-canvas-video-public-result": "1", "x-canvas-require-content-length": "1", Authorization: "Bearer fixture-token", "Idempotency-Key": "fixture-key-123",
            "content-type": "multipart/form-data; boundary=fixture",
        }, body });
        assert.equal(submitted.status, 202);
        let state;
        for (let index = 0; index < 1200; index++) {
            state = await (await fetch(taskUrl, { headers })).json();
            if (state.state === "completed" || state.state === "failed") break;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(state.state, "completed", state.error);
        assert.equal(receivedLength, String(body.length));
        assert.equal(pollHeaders.authorization, "Bearer fixture-token");
        assert.equal(pollHeaders["content-length"], undefined);
        assert.equal(pollHeaders["content-type"], undefined);
        assert.equal(pollHeaders["idempotency-key"], undefined);
        assert.equal(mediaAuthorization, undefined);
        assert.equal(await (await fetch(taskUrl + "/result", { headers })).text(), "fixture-video");
    } finally {
        await close(proxy.server);
        await close(upstream.server);
    }
});

test("JSON video business errors expose the provider message", async () => {
    await assert.rejects(resolveVideoTask("json-video", { code: "0", message: "积分不足" }, new URL("https://example.com/api/v1/videos"), {}, { controller: new AbortController() }, async () => {}), /积分不足/);
});
