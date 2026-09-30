import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const base = "http://127.0.0.1:3000";
const response = await fetch(`${base}/`);
assert.equal(response.status, 200);
assert.match(await response.text(), /<html/);
const config = await (await fetch(`${base}/config.js`)).text();
assert.match(config, /CANVAS_PROXY_PATH: "\/canvas-proxy"/);
const identity = await (await fetch(`${base}/canvas-proxy/`)).json();
assert.equal(identity.proxy, "@basketikun/canvas-proxy");

// An isolated fixture verifies both proxy hops without calling providers or using credentials.
const fixture = `let pending;
require('node:http').createServer(async (req,res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  if (req.url === '/stream') {
    res.writeHead(200, {'content-type':'text/event-stream'});
    res.write('data: first\\n\\n');
    pending = res;
    return;
  }
  if (req.url === '/release') { pending.end('data: last\\n\\n'); res.end('ok'); return; }
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
    console.log("Compose smoke passed: frontend, runtime config, Seedance route, signed URL, large body and SSE.");
}
await verifyProxy();
