import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { mkdtemp, mkdir, writeFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localHandler, origin } from "./server.mjs";

const listen = async (server) => { await new Promise((done) => server.listen(0, "127.0.0.1", done)); return `http://127.0.0.1:${server.address().port}`; };
const close = async (server) => { server.closeAllConnections(); await new Promise((done) => server.close(done)); };
// Native fetch overrides a custom Host header; use http.request to probe the exact old origin.
const fetch = (url, init = {}) => new Promise((done, reject) => {
    const req = request(url, { method: init.method || "GET", headers: init.headers }, (res) => {
        const chunks = []; res.on("data", (chunk) => chunks.push(chunk)); res.on("error", reject);
        res.on("end", () => done(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
    });
    req.on("error", reject); req.end(init.body);
});

test("local deployment serves the built app, same-origin runtime config and raw streaming proxy without touching browser data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canvas-local-"));
    await mkdir(join(dir, "dist"));
    await writeFile(join(dir, "dist/index.html"), "<html>fixture-canvas</html>");
    await writeFile(join(dir, "dist/app.js"), "fixture-script");
    await writeFile(join(dir, "private.txt"), "outside-dist");
    const proxy = createServer(async (req, res) => {
        if (req.url === "/") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ memoryTasks: 2, taskStorage: "disk", tencentVod: 1 })); return; }
        const body = []; for await (const chunk of req) body.push(chunk);
        res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ url: req.url, body: Buffer.concat(body).toString("hex") }));
    });
    await listen(proxy);
    const app = createServer(localHandler({ dist: await realpath(join(dir, "dist")), proxyPort: proxy.address().port, build: "fixture-build" }));
    const base = await listen(app);
    const headers = { host: "192.168.123.232:3001" };
    try {
        for (const path of ["/", "/canvas/example"]) {
            const response = await fetch(base + path, { headers });
            assert.equal(response.status, 200); assert.match(await response.text(), /fixture-canvas/);
            assert.equal(response.headers.get("clear-site-data"), null);
        }
        assert.match(await (await fetch(base + "/config.js", { headers })).text(), /CANVAS_PROXY_PATH: "\/canvas-proxy"/);
        assert.match((await fetch(base + "/app.js", { headers })).headers.get("content-type"), /javascript/);
        assert.equal((await (await fetch(base + "/__local/status", { headers })).json()).origin, origin);
        assert.equal((await (await fetch(base + "/canvas-proxy/", { headers })).json()).taskStorage, "disk");
        const target = "/https://media.example.com/videos?id=a%2Fb%2Bc&signature=one+two%26three";
        const result = await (await fetch(base + "/canvas-proxy" + target, { method: "POST", headers: { ...headers, origin, "content-type": "application/octet-stream" }, body: Buffer.from([0, 1, 255]) })).json();
        assert.equal(result.url, target); assert.equal(result.body, "0001ff");
        for (const path of ["/missing.js", "/%2e%2e%2fprivate.txt"]) assert.equal((await fetch(base + path, { headers })).status, 404);
        assert.equal((await fetch(base + "/canvas-proxy/", { headers: { ...headers, origin: "https://unrelated.example.com" } })).status, 403);
        assert.equal((await fetch(base + "/", { headers: { host: "unrelated.example.com" } })).status, 403);
    } finally { await close(app); await close(proxy); await rm(dir, { recursive: true, force: true }); }
});
