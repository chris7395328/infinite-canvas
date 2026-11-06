import { createHash, X509Certificate } from "node:crypto";
import { cpSync, createReadStream, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { request } from "node:http";
import { createServer, get } from "node:https";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createProxyServer } from "../../canvas-proxy/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const origin = "https://192.168.123.232:3001";
const runtime = join(root, ".runtime/local");
const mime = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".wasm": "application/wasm", ".mp4": "video/mp4" };

// Include the Docker web inputs and local backend code, excluding generated files and dependencies.
export function fingerprint() {
    const hash = createHash("sha256");
    const visit = (path) => {
        const info = statSyncSafe(path);
        if (!info) return;
        if (info.isDirectory()) {
            for (const name of readdirSync(path).sort()) if (!["node_modules", "dist", ".git"].includes(name)) visit(join(path, name));
        } else hash.update(relative(root, path)).update("\0").update(readFileSync(path));
    };
    for (const path of ["web", "canvas-proxy", "scripts/local", "start-local-canvas.ps1", "VERSION", "CHANGELOG.md"]) visit(join(root, path));
    return hash.digest("hex");
}

// Keep synchronous reads confined to startup and build-fingerprint calculation.
function statSyncSafe(path) { try { return statSync(path); } catch (error) { if (error.code !== "ENOENT") throw error; } }

export function localHandler({ dist, proxyPort, build }) {
    return async (req, res) => {
        try {
            const host = req.headers.host;
            if (!["192.168.123.232:3001", "127.0.0.1:3001", "localhost:3001"].includes(host) || req.headers.origin && req.headers.origin !== origin) {
                res.writeHead(403); res.end("仅允许本机画布访问"); return;
            }
            if (req.url === "/__local/status") {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ app: "infinite-canvas-local", origin, build, taskStorage: "disk" })); return;
            }
            if (req.url === "/canvas-proxy") { res.writeHead(308, { location: "/canvas-proxy/" }); res.end(); return; }
            if (req.url.startsWith("/canvas-proxy/")) {
                // Slice the raw request target, never decode/re-encode signed upstream URLs.
                const upstream = request({ host: "127.0.0.1", port: proxyPort, path: req.url.slice("/canvas-proxy".length), method: req.method, headers: { ...req.headers, host: `127.0.0.1:${proxyPort}` }, timeout: 0 }, (response) => {
                    res.writeHead(response.statusCode, response.headers);
                    response.on("error", () => res.destroy()); response.pipe(res);
                });
                upstream.on("error", () => { if (res.headersSent) res.destroy(); else { res.writeHead(502); res.end("本机代理连接失败；未自动重新生成"); } });
                req.on("aborted", () => upstream.destroy());
                res.on("close", () => { if (!res.writableFinished) upstream.destroy(); });
                req.pipe(upstream); return;
            }
            if (!["GET", "HEAD"].includes(req.method)) { res.writeHead(405); res.end(); return; }
            res.setHeader("cache-control", "no-store");
            if (req.url.split("?")[0] === "/config.js") {
                res.setHeader("content-type", "application/javascript; charset=utf-8");
                res.end(req.method === "HEAD" ? undefined : 'window.__RUNTIME_CONFIG__ = { CANVAS_PROXY_PATH: "/canvas-proxy" };'); return;
            }
            const path = decodeURIComponent(new URL(req.url, origin).pathname);
            let file = resolve(dist, "." + path);
            if (file !== dist && !file.startsWith(dist + sep)) { res.writeHead(404); res.end(); return; }
            try { if (!(await stat(file)).isFile()) file = join(dist, "index.html"); }
            catch (error) { if (error.code !== "ENOENT") throw error; if (extname(path)) { res.writeHead(404); res.end(); return; } file = join(dist, "index.html"); }
            file = await realpath(file);
            if (!file.startsWith(dist + sep)) { res.writeHead(404); res.end(); return; }
            const info = await stat(file);
            res.writeHead(200, { "content-type": mime[extname(file)] || "application/octet-stream", "content-length": info.size });
            if (req.method === "HEAD") res.end();
            else { const stream = createReadStream(file); stream.on("error", () => res.destroy()); res.on("close", () => stream.destroy()); stream.pipe(res); }
        } catch { if (res.headersSent) res.destroy(); else { res.writeHead(500); res.end("本机服务处理失败，请检查本机日志；未重新提交生成"); } }
    };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    if (process.argv.includes("--fingerprint")) console.log(fingerprint());
    else if (process.argv.includes("--status")) {
        await new Promise((done) => {
            get("https://127.0.0.1:3001/__local/status", { ca: readFileSync(join(runtime, "cert.pem")), timeout: 1000 }, (res) => {
                let body = ""; res.on("data", (chunk) => body += chunk);
                res.on("end", () => { if (res.statusCode === 200) console.log(body); else process.exitCode = 1; done(); });
                res.on("error", () => { process.exitCode = 1; done(); });
            }).on("error", () => { process.exitCode = 1; done(); }).on("timeout", function () { this.destroy(); });
        });
    }
    else if (process.argv.includes("--prepare-build")) {
        const buildRoot = join(runtime, "builds", fingerprint());
        mkdirSync(buildRoot, { recursive: true });
        for (const name of ["VERSION", "CHANGELOG.md"]) cpSync(join(root, name), join(buildRoot, name));
        const web = join(root, "web");
        cpSync(web, join(buildRoot, "web"), { recursive: true, filter: (path) => !relative(web, path).split(sep).some((name) => ["node_modules", "dist", ".git"].includes(name)) });
        console.log(buildRoot);
    }
    else if (process.argv.includes("--pin")) {
        const cert = new X509Certificate(readFileSync(join(runtime, "cert.pem")));
        console.log(createHash("sha256").update(cert.publicKey.export({ type: "spki", format: "der" })).digest("base64"));
    } else {
        process.env.CANVAS_TASK_DIR = join(root, "task-data/local");
        const built = JSON.parse(readFileSync(join(runtime, "build.json"), "utf8").replace(/^\uFEFF/, ""));
        const build = built.fingerprint;
        const proxy = createProxyServer();
        await new Promise((done, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", done); });
        proxy.requestTimeout = 0;
        const dist = await realpath(built.dist);
        const server = createServer({ cert: readFileSync(join(runtime, "cert.pem")), key: readFileSync(join(runtime, "key.pem")) }, localHandler({ dist, proxyPort: proxy.address().port, build }));
        server.requestTimeout = 0;
        server.once("error", (error) => { console.error(error.code || "本机HTTPS启动失败"); proxy.close(); process.exitCode = 1; });
        server.listen(3001, "127.0.0.1", () => console.log(`本机HTTPS画布已启动：${origin}（仅监听127.0.0.1；任务保存在task-data/local）`));
    }
}
