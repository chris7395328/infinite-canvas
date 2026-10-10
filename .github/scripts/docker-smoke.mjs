import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const base = "http://127.0.0.1:3000";
const response = await fetch(`${base}/`);
assert.equal(response.status, 200);
assert.match(await response.text(), /<html/);
const config = await (await fetch(`${base}/config.js`)).text();
assert.match(config, /CANVAS_PROXY_PATH: "\/canvas-proxy"/);
const identity = await (await fetch(`${base}/canvas-proxy/`)).json();
assert.equal(identity.proxy, "@basketikun/canvas-proxy");
assert.equal(identity.memoryTasks, 1);

// An isolated fixture verifies both proxy hops without calling providers or using credentials.
const fixture = `let pending, pendingTask, taskCalls = 0;
require('node:http').createServer(async (req,res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  if (req.url === '/stream') {
    res.writeHead(200, {'content-type':'text/event-stream'});
    res.write('data: first\\n\\n');
    pending = res;
    return;
  }
  if (req.url === '/release') { pending.end('data: last\\n\\n'); res.end('ok'); return; }
  if (req.url === '/task') { taskCalls++; pendingTask = {res,body,headers:req.headers}; return; }
  if (req.url === '/task-release') {
    pendingTask.res.setHeader('content-type','application/json');
    pendingTask.res.end(JSON.stringify({calls:taskCalls,body:pendingTask.body,cookie:pendingTask.headers.cookie || '',privateHeader:pendingTask.headers['x-canvas-task-key'] || ''}));
    res.end('ok'); return;
  }
  if (req.url === '/task-calls') { res.end(String(taskCalls)); return; }
  res.setHeader('content-type','application/json');
  res.end(JSON.stringify({url:req.url,method:req.method,header:req.headers['x-smoke'],body}));
}).listen(24123,'0.0.0.0');`;
execFileSync("docker", ["compose", "exec", "-d", "proxy", "node", "-e", fixture]);
async function verifyProxy() {
    // Probe readiness, bounded to the fixture startup only.
    for (let i = 0; i < 20; i++) {
        const probe = await fetch(`${base}/canvas-proxy/http://proxy:24123/ready`);
        if (probe.ok) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const query = "/echo?signature=a%2Fb%2Bc&value=hello%20world";
    const forwarded = await fetch(`${base}/canvas-proxy/http://proxy:24123${query}`, {
        method: "POST", headers: { "x-smoke": "preserved" }, body: "x".repeat(2 * 1024 * 1024),
    });
    assert.equal(forwarded.status, 200);
    const echo = await forwarded.json();
    assert.equal(echo.url, query);
    assert.equal(echo.method, "POST");
    assert.equal(echo.header, "preserved");
    assert.equal(echo.body.length, 2 * 1024 * 1024);
    const stream = await fetch(`${base}/canvas-proxy/http://proxy:24123/stream`);
    const reader = stream.body.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /data: first/);
    assert.doesNotMatch(new TextDecoder().decode(first.value), /data: last/);
    assert.equal((await fetch(`${base}/canvas-proxy/http://proxy:24123/release`)).status, 200);
    let rest = "";
    for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        rest += new TextDecoder().decode(chunk.value);
    }
    assert.match(rest, /data: last/);
    const missing = await fetch(`${base}/canvas-proxy/seedance/video`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    assert.equal(missing.status, 400);
    assert.ok((await missing.json()).error);
    // Simulate page closure after admission: no waiting browser request is kept open.
    const id = randomUUID();
    const key = randomUUID();
    const task = `${base}/canvas-proxy/_tasks/${id}`;
    const auth = { "x-canvas-task-key": key };
    const submit = { ...auth, "x-canvas-target-url": "http://proxy:24123/task", "content-type": "text/plain", cookie: "private-session=must-not-forward" };
    assert.equal((await fetch(task, { method: "POST", headers: submit, body: "fixture-result" })).status, 202);
    // Exact same receipt must not create a second upstream call.
    assert.equal((await fetch(task, { method: "POST", headers: submit, body: "duplicate" })).status, 202);
    assert.equal((await fetch(task)).status, 403);
    assert.equal((await fetch(task, { headers: { "x-canvas-task-key": randomUUID() } })).status, 403);
    for (let i = 0; i < 20; i++) {
        if (await (await fetch(`${base}/canvas-proxy/http://proxy:24123/task-calls`)).text() === "1") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal((await fetch(`${task}/result`, { headers: auth })).status, 409);
    await fetch(`${base}/canvas-proxy/http://proxy:24123/task-release`);
    for (let i = 0; i < 20; i++) {
        if ((await (await fetch(task, { headers: auth })).json()).state === "completed") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const recovered = await (await fetch(`${task}/result`, { headers: auth })).json();
    assert.equal(recovered.calls, 1);
    assert.equal(recovered.body, "fixture-result");
    assert.equal(recovered.cookie, "");
    assert.equal(recovered.privateHeader, "");
    assert.equal((await fetch(`${task}/result`, { headers: auth })).status, 200);
    assert.equal((await fetch(task, { method: "DELETE", headers: auth })).status, 200);
    assert.equal((await fetch(task, { headers: auth })).status, 404);
    console.log("Compose smoke passed: frontend, proxy, signed URL, SSE and RAM task admission/recovery/idempotency/secret/ACK.");
}
await verifyProxy();
