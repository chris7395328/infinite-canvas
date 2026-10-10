import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { resolveVideoTask } from "./video-tasks.js";
import { setTimeout as pause } from "node:timers/promises";

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
        task.finishedAt = Date.now();
        task.error = error instanceof Error ? error.message : String(error);
        task.controller.abort();
    };
    const sweep = () => {
        for (const task of tasks.values()) if (task.finishedAt && Date.now() - task.finishedAt >= RETENTION) release(task);
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
            const protocol = req.headers["x-canvas-video-protocol"];
            if (protocol && !["openai", "gemini", "omni", "moyu", "xing933"].includes(protocol)) { req.resume(); json(res, 400, { error: "未知视频任务协议，未提交生成。" }); return; }
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
            const request = (url, method, requestHeaders, source) => new Promise((resolve, reject) => {
                const parsed = new URL(url);
                if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) { reject(new Error("无效的结果地址")); return; }
                const outgoing = (parsed.protocol === "https:" ? httpsRequest : httpRequest)(parsed, { method, headers: requestHeaders, signal: task.controller.signal }, resolve);
                outgoing.once("error", reject);
                if (source) { source.once("error", (error) => outgoing.destroy(error)); source.pipe(outgoing); }
                else outgoing.end();
            });
            const collect = async (upstream) => {
                if (tasks.get(id) !== task) { upstream.destroy(); task.controller.signal.throwIfAborted(); return; }
                bytes -= task.bytes - OVERHEAD;
                task.bytes = OVERHEAD;
                task.chunks = [];
                task.status = upstream.statusCode || 502;
                task.contentType = upstream.headers["content-type"] || "application/octet-stream";
                for await (const chunk of upstream) {
                    task.controller.signal.throwIfAborted();
                    reserve(task, chunk.length);
                    task.chunks.push(chunk);
                }
            };
            const read = async (url, requestHeaders) => {
                const upstream = await request(url, "GET", requestHeaders);
                const retry = upstream.headers["retry-after"];
                task.retryAfter = retry ? Math.max(10000, /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : 10000;
                await collect(upstream);
                if (task.status < 200 || task.status >= 300) throw new Error(`原任务查询返回 HTTP ${task.status}`);
                return JSON.parse(Buffer.concat(task.chunks).toString("utf8"));
            };
            // This work deliberately outlives the browser connection. Never log credentials or bodies.
            void (async () => {
                try {
                    // Native HTTP avoids fetch's implicit headers timeout for long synchronous generation.
                    // Running tasks have no local deadline; POST is sent exactly once.
                    await collect(await request(target, "POST", headers, body));
                    if (protocol && task.status >= 200 && task.status < 300) {
                        const result = await resolveVideoTask(protocol, JSON.parse(Buffer.concat(task.chunks).toString("utf8")), target, headers, task, read);
                        // Upstream generation is finished; unclaimed-result retention now starts.
                        task.finishedAt = Date.now();
                        if (result.data) {
                            bytes -= task.bytes - OVERHEAD;
                            task.bytes = OVERHEAD;
                            task.chunks = [];
                            const video = Buffer.from(result.data, "base64");
                            reserve(task, video.length);
                            task.chunks = [video];
                            task.status = 200;
                            task.contentType = result.mime;
                        } else {
                            let url = new URL(result.url);
                            let downloadHeaders = result.headers;
                            const visited = new Set();
                            for (;;) {
                                if (visited.has(url.href)) throw new Error("视频下载出现循环重定向；原任务已生成，未重新生成。");
                                visited.add(url.href);
                                let download;
                                try { download = await request(url, "GET", downloadHeaders); }
                                catch (error) {
                                    if (task.controller.signal.aborted) throw error;
                                    task.warning = "视频已生成，下载连接异常，后台继续领取原结果，未重新生成。";
                                    visited.clear();
                                    await pause(10000, undefined, { signal: task.controller.signal });
                                    continue;
                                }
                                if (download.statusCode === 409 || download.statusCode === 429 || download.statusCode >= 500) {
                                    const retry = download.headers["retry-after"];
                                    const wait = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : 10000;
                                    download.resume();
                                    visited.clear();
                                    task.warning = "视频已生成，后台继续等待原文件可领取，未重新生成。";
                                    await pause(Math.max(10000, wait || 10000), undefined, { signal: task.controller.signal });
                                    continue;
                                }
                                if ([301, 302, 303, 307, 308].includes(download.statusCode) && download.headers.location) {
                                    const next = new URL(download.headers.location, url);
                                    if (next.origin !== url.origin) downloadHeaders = {};
                                    url = next;
                                    download.resume();
                                    continue;
                                }
                                await collect(download);
                                break;
                            }
                            if (task.status < 200 || task.status >= 300 || /json|text\/html/i.test(task.contentType) || task.bytes === OVERHEAD) throw new Error("API 已生成，但视频下载失败；未重新生成，请核对上游结果。");
                            if (task.contentType === "application/octet-stream") task.contentType = result.mime || "video/mp4";
                        }
                    }
                    task.state = "completed";
                    task.finishedAt ||= Date.now();
                    task.warning = undefined;
                } catch (error) { fail(task, new Error(`${error.message}（后台通信或处理失败不等于上游生成失败；未重新提交。）`)); }
            })();
            json(res, 202, { state: task.state });
            return;
        }
        if (!task) { json(res, 404, { error: "后台内存任务不存在或已过期／容器已重启。未重新生成；上游是否计费需另行核对。" }); return; }
        if (req.method === "DELETE" && !result) { release(task); json(res, 200, { released: true }); return; }
        if (req.method === "GET" && !result) {
            json(res, 200, { state: task.state, error: task.error, warning: task.warning, upstreamId: task.upstreamId, createdAt: task.createdAt, expiresAt: task.finishedAt ? task.finishedAt + RETENTION : null });
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
