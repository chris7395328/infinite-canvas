import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

// Payload budget, not total Node RSS. No task data is written to disk.
const BUDGET = 256 * 1024 * 1024;
const RETENTION = 24 * 60 * 60 * 1000;
const OVERHEAD = 1024;
const digest = (value) => createHash("sha256").update(value).digest("hex");

export function createMemoryTasks() {
    const tasks = new Map();
    let bytes = 0;
    const json = (res, code, body) => {
        res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(body));
    };
    const release = (task) => {
        bytes -= task.bytes;
        task.bytes = 0;
        task.chunks = [];
        task.controller.abort();
        tasks.delete(task.id);
    };
    const reserve = (task, size) => {
        if (tasks.get(task.id) !== task) throw new Error("后台任务已取消或过期，未继续提交生成。");
        if (bytes + size > BUDGET) throw new Error("后台任务内存预算已满（256 MiB）。未自动重试；如已提交，上游可能计费。");
        task.bytes += size;
        bytes += size;
    };
    const fail = (task, error) => {
        if (tasks.get(task.id) !== task) return;
        bytes -= task.bytes - OVERHEAD;
        task.bytes = OVERHEAD;
        task.chunks = [];
        task.state = "failed";
        task.error = error instanceof Error ? error.message : String(error);
        task.controller.abort();
    };
    const sweep = () => {
        for (const task of tasks.values()) if (Date.now() - task.createdAt >= RETENTION) release(task);
    };
    const timer = setInterval(sweep, 60_000);
    timer.unref();

    return async function handle(req, res) {
        const match = (req.url || "").match(/^\/_tasks\/([a-f0-9-]{36})(\/result)?$/);
        if (!match) { json(res, 404, { error: "未知后台任务地址" }); return; }
        sweep();
        const [, id, result] = match;
        const token = String(req.headers["x-canvas-task-key"] || "");
        if (!/^[a-f0-9-]{36}$/.test(token)) { json(res, 403, { error: "缺少任务访问凭据" }); return; }
        let task = tasks.get(id);
        if (task && task.key !== digest(token)) { json(res, 403, { error: "任务访问凭据不匹配" }); return; }
        if (req.method === "POST" && !result) {
            if (task) { req.resume(); json(res, 202, { state: task.state }); return; }
            let target;
            try {
                const rawTarget = String(req.headers["x-canvas-target-url"] || "");
                target = new URL(rawTarget === "/seedance/video" ? `http://127.0.0.1:${req.socket.localPort}/seedance/video` : rawTarget);
                if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) throw new Error();
            } catch { json(res, 400, { error: "无效的上游地址" }); return; }
            if (bytes + OVERHEAD > BUDGET) { req.resume(); json(res, 507, { error: "后台任务内存预算已满（256 MiB），未提交生成。" }); return; }
            task = { id, key: digest(token), state: "uploading", createdAt: Date.now(), bytes: 0, chunks: [], controller: new AbortController() };
            tasks.set(id, task);
            reserve(task, OVERHEAD);
            try {
                for await (const chunk of req) { reserve(task, chunk.length); task.chunks.push(chunk); }
            } catch (error) { fail(task, error); json(res, 507, { error: task.error || "后台任务已取消或过期，未继续提交生成。" }); return; }
            if (tasks.get(id) !== task) { json(res, 409, { error: "后台任务已取消或过期，未提交生成。" }); return; }
            const headers = {};
            for (const [key, value] of Object.entries(req.headers)) {
                if (key.startsWith("x-canvas-") || ["host", "connection", "content-length", "accept-encoding", "origin", "referer", "cookie"].includes(key) || key.startsWith("sec-") || value === undefined) continue;
                headers[key] = Array.isArray(value) ? value.join(", ") : value;
            }
            const body = Readable.from(task.chunks);
            task.state = "running";
            // This work deliberately outlives the browser connection. Never log credentials or bodies.
            void (async () => {
                try {
                    // Native HTTP avoids fetch's implicit headers timeout for long synchronous generation.
                    // The approved task retention/AbortController is the lifetime boundary; no retries/redirects.
                    const upstream = await new Promise((resolve, reject) => {
                        const outgoing = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, { method: "POST", headers, signal: task.controller.signal }, resolve);
                        outgoing.once("error", reject);
                        body.once("error", (error) => outgoing.destroy(error));
                        body.pipe(outgoing);
                    });
                    if (tasks.get(id) !== task) { upstream.destroy(); return; }
                    bytes -= task.bytes - OVERHEAD;
                    task.bytes = OVERHEAD;
                    task.chunks = [];
                    task.status = upstream.statusCode || 502;
                    task.contentType = upstream.headers["content-type"] || "application/octet-stream";
                    for await (const chunk of upstream) {
                        if (tasks.get(id) !== task) return;
                        reserve(task, chunk.length);
                        task.chunks.push(chunk);
                    }
                    task.state = "completed";
                } catch (error) { fail(task, error); }
            })();
            json(res, 202, { state: task.state });
            return;
        }
        if (!task) { json(res, 404, { error: "后台内存任务不存在或已过期／容器已重启。未重新生成；上游是否计费需另行核对。" }); return; }
        if (req.method === "DELETE" && !result) { release(task); json(res, 200, { released: true }); return; }
        if (req.method === "GET" && !result) {
            json(res, 200, { state: task.state, error: task.error, createdAt: task.createdAt, expiresAt: task.createdAt + RETENTION });
            return;
        }
        if (req.method === "GET" && result && task.state === "completed") {
            res.writeHead(task.status, { "content-type": task.contentType, "cache-control": "no-store" });
            // A disconnected GET is not an ACK. Keep buffers until explicit acknowledgement.
            Readable.from(task.chunks).pipe(res);
            return;
        }
        json(res, 409, { error: task.error || "后台任务尚未完成" });
    };
}
