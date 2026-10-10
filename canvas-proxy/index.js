#!/usr/bin/env node
import { createServer } from "node:http";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { createMemoryTasks } from "./memory-tasks.js";

const pkg = createRequire(import.meta.url)("./package.json");

const CORS_HEADERS = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "*",
    "access-control-allow-headers": "*",
    "access-control-expose-headers": "*",
    "access-control-max-age": "86400",
};

/** Headers that describe the hop to this proxy rather than the upstream request. */
const SKIP_REQUEST_HEADERS = new Set(["host", "connection", "content-length", "accept-encoding", "origin", "referer", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site"]);
/** fetch() already decoded and re-framed the body, so the upstream framing headers no longer apply. */
const SKIP_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);

function readArg(args, name, fallback) {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

function readTarget(url) {
    const raw = url.slice(1);
    // decodeURI undoes the escaping browsers apply to the path while keeping intentional encodeURIComponent escapes.
    let target = raw;
    try {
        target = decodeURI(raw);
    } catch {
        // Malformed escape sequence: forward the raw form instead of failing.
    }
    // Some clients collapse the "//" in the embedded target URL, so restore it before parsing.
    target = target.replace(/^(https?:)\/*/i, "$1//");
    return /^https?:\/\/[^/]/i.test(target) ? target : "";
}

function requestHeaders(req) {
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
        if (SKIP_REQUEST_HEADERS.has(key) || value === undefined) continue;
        headers[key] = Array.isArray(value) ? value.join(", ") : value;
    }
    return headers;
}

function responseHeaders(upstream) {
    const headers = { ...CORS_HEADERS };
    upstream.headers.forEach((value, key) => {
        if (SKIP_RESPONSE_HEADERS.has(key) || key.startsWith("access-control-")) return;
        headers[key] = value;
    });
    return headers;
}

function sendJson(res, status, payload) {
    res.writeHead(status, { ...CORS_HEADERS, "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
}

function logForward(method, target, outcome, startedAt) {
    const url = new URL(target);
    console.log(`${new Date().toLocaleTimeString()} ${method} ${url.origin}${url.pathname} -> ${outcome} ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

const ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const VOLC_OPEN_API = "https://open.volcengineapi.com";
const assetGroups = new Map();

function required(value, name) {
    if (!String(value || "").trim()) throw new Error(`缺少 ${name}`);
    return String(value).trim();
}

function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}

function hmacSha256(key, value, encoding) {
    return createHmac("sha256", key).update(value).digest(encoding);
}

function hmacSha1(key, value) {
    return createHmac("sha1", key).update(value).digest("hex");
}

function volcTimestamp(now) {
    return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

async function callVolcAssetApi(action, body, settings) {
    const accessKeyId = required(settings.accessKeyId, "方舟 Access Key ID");
    const secretAccessKey = required(settings.secretAccessKey, "方舟 Secret Access Key");
    const payload = JSON.stringify(body);
    const now = new Date();
    const timestamp = volcTimestamp(now);
    const date = timestamp.slice(0, 8);
    const query = `Action=${encodeURIComponent(action)}&Version=2024-01-01`;
    const host = "open.volcengineapi.com";
    const payloadHash = sha256(payload);
    const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-date:${timestamp}\n`;
    const signedHeaders = "content-type;host;x-date";
    const canonicalRequest = `POST\n/\n${query}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const scope = `${date}/cn-beijing/ark/request`;
    const signingKey = hmacSha256(hmacSha256(hmacSha256(hmacSha256(secretAccessKey, date), "cn-beijing"), "ark"), "request");
    const stringToSign = `HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(canonicalRequest)}`;
    const signature = hmacSha256(signingKey, stringToSign, "hex");
    const response = await fetch(`${VOLC_OPEN_API}/?${query}`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-date": timestamp,
            authorization: `HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        },
        body: payload,
    });
    const text = await response.text();
    let result;
    try { result = JSON.parse(text); } catch { result = {}; }
    if (!response.ok) throw new Error(`素材库 ${action} 失败 (${response.status})：${result.Message || result.Error?.Message || text.slice(0, 500) || "未返回错误说明"}`);
    return result;
}

function resultValue(result, name) {
    return result?.[name] || result?.Result?.[name] || "";
}

async function ensureAssetGroup(settings) {
    if (settings.assetGroupId?.trim()) return settings.assetGroupId.trim();
    const cacheKey = `${settings.accessKeyId}:${settings.projectName}`;
    if (assetGroups.has(cacheKey)) return assetGroups.get(cacheKey);
    const result = await callVolcAssetApi("CreateAssetGroup", {
        Name: "Infinite Canvas Seedance",
        Description: "Automatically managed by Infinite Canvas",
        GroupType: "AIGC",
        ProjectName: required(settings.projectName, "方舟项目名称"),
    }, settings);
    const id = resultValue(result, "Id");
    if (!id) throw new Error("素材库未返回素材组 ID");
    assetGroups.set(cacheKey, id);
    return id;
}

function dataUrlInfo(value) {
    const match = String(value).match(/^data:([^;,]+)?(?:;base64)?,(.*)$/s);
    if (!match) throw new Error("参考素材必须是 data URL");
    return { mime: match[1] || "application/octet-stream", bytes: Buffer.from(match[2], "base64") };
}

function extensionForMime(mime) {
    return ({ "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm", "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/mp4": ".m4a", "audio/aac": ".aac" })[mime] || "";
}

function cosEndpoint(value, bucket) {
    const endpoint = required(value, "COS 上传 Endpoint").replace("{bucket}", required(bucket, "COS Bucket")).replace(/\/+$/, "");
    return /^https?:\/\//i.test(endpoint) ? endpoint : `https://${endpoint}`;
}

function cosAuthorization(url, secretId, secretKey) {
    const now = Math.floor(Date.now() / 1000);
    const keyTime = `${now};${now + 900}`;
    const host = url.port ? url.host : url.hostname;
    const headerString = `host=${encodeURIComponent(host).replace(/%7E/g, "~")}`;
    const httpString = `put\n${decodeURIComponent(url.pathname)}\n\n${headerString}\n`;
    const stringToSign = `sha1\n${keyTime}\n${createHash("sha1").update(httpString).digest("hex")}\n`;
    const signKey = hmacSha1(secretKey, keyTime);
    const signature = hmacSha1(signKey, stringToSign);
    return `q-sign-algorithm=sha1&q-ak=${encodeURIComponent(secretId).replace(/%7E/g, "~")}&q-sign-time=${keyTime}&q-key-time=${keyTime}&q-header-list=host&q-url-param-list=&q-signature=${signature}`;
}

async function uploadToCos(dataUrl, kind, settings) {
    if (!settings.cosEnabled) throw new Error("本地素材需要启用 COS 上传");
    const { mime, bytes } = dataUrlInfo(dataUrl);
    const extension = extensionForMime(mime);
    if (!extension) throw new Error(`不支持的参考素材格式：${mime}`);
    const prefix = String(settings.cosObjectPrefix || "infinite-canvas").replace(/^\/+|\/+$/g, "");
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "/");
    const key = [prefix, date, `${kind}_${randomUUID().replace(/-/g, "")}${extension}`].filter(Boolean).join("/");
    const endpoint = cosEndpoint(settings.cosEndpoint, settings.cosBucket);
    const uploadUrl = new URL(`${endpoint}/${key.split("/").map(encodeURIComponent).join("/")}`);
    const response = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "content-type": mime, authorization: cosAuthorization(uploadUrl, required(settings.cosSecretId, "COS Secret ID"), required(settings.cosSecretKey, "COS Secret Key")) },
        body: bytes,
    });
    if (!response.ok) throw new Error(`COS 上传失败 (${response.status})：${(await response.text()).slice(0, 500) || response.statusText}`);
    const publicBase = cosEndpoint(settings.cosPublicBaseUrl || settings.cosEndpoint, settings.cosBucket);
    return `${publicBase}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

function assetType(kind) {
    return kind === "image" ? "Image" : kind === "video" ? "Video" : "Audio";
}

async function preparePrivateAsset(source, kind, settings) {
    const url = source.startsWith("data:") ? await uploadToCos(source, kind, settings) : source;
    const groupId = await ensureAssetGroup(settings);
    const result = await callVolcAssetApi("CreateAsset", {
        GroupId: groupId,
        URL: url,
        AssetType: assetType(kind),
        Name: `seedance-${kind}-${randomUUID().slice(0, 8)}`,
        ProjectName: required(settings.projectName, "方舟项目名称"),
    }, settings);
    const id = resultValue(result, "Id");
    if (!id) throw new Error("素材库未返回素材 ID");
    for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const statusResult = await callVolcAssetApi("GetAsset", { Id: id, ProjectName: required(settings.projectName, "方舟项目名称") }, settings);
        const status = String(resultValue(statusResult, "Status"));
        if (status.toLowerCase() === "active") return `asset://${id}`;
        if (status.toLowerCase() === "failed") throw new Error(`私域素材入库失败：${kind}`);
    }
}

function seedanceContent(prompt, references, mode) {
    return [{ type: "text", text: String(prompt || "").trim() }, ...references.map((item, index) => {
        const role = item.kind === "image" ? (mode === "frames" ? (index === 0 ? "first_frame" : index === 1 ? "last_frame" : "reference_image") : "reference_image") : item.kind === "video" ? "reference_video" : "reference_audio";
        const key = item.kind === "image" ? "image_url" : item.kind === "video" ? "video_url" : "audio_url";
        return { type: key, [key]: { url: item.url }, role };
    })];
}

async function generateSeedance(input) {
    const settings = input.seedance || {};
    const model = required(input.model, "Seedance 模型");
    const apiKey = required(input.apiKey, "方舟 API Key");
    const params = input.params || {};
    const draftTaskId = String(input.draftTaskId || "").trim();
    const isV25 = /seedance-2-5/i.test(model);
    const isV20 = /seedance-2-0/i.test(model);
    const isV20Fast = isV20 && /fast|mini/i.test(model);
    const allowedResolutions = isV20Fast ? ["480p", "720p"] : ["480p", "720p", "1080p"];
    const requestedResolution = String(params.resolution || "720p").toLowerCase();
    if ((isV20 || isV25) && !draftTaskId && !(isV25 && settings.draft) && !allowedResolutions.includes(requestedResolution)) {
        throw new Error("该 Seedance 模型不支持生成分辨率 " + requestedResolution + "，请选择 " + allowedResolutions.join("、") + "；4K 导出并非该 API 的 4K 生成。");
    }
    const requestedDuration = Number(params.seconds) || 8;
    if (isV20 && (requestedDuration < 4 || requestedDuration > 15)) throw new Error("Seedance 2.0 支持的生成时长为 4～15 秒，请调整节点时长。");
    if (isV25 && !draftTaskId && settings.taskType !== "edit" && (requestedDuration < 4 || requestedDuration > 30)) throw new Error("Seedance 2.5 支持的生成时长为 4～30 秒，请调整节点时长。");
    const duration = Math.max(4, Math.min(isV25 ? 30 : 15, requestedDuration));
    const rawReferences = [
        ...(input.images || []).map((url) => ({ url, kind: "image" })),
        ...(input.videos || []).map((url) => ({ url, kind: "video" })),
        ...(input.audios || []).map((url) => ({ url, kind: "audio" })),
    ];
    const references = draftTaskId ? [] : await Promise.all(rawReferences.map(async (item) => ({ ...item, url: settings.usePrivateAssets ? await preparePrivateAsset(item.url, item.kind, settings) : item.url })));
    const isEdit = isV25 && settings.taskType === "edit";
    const isAdaptiveTask = isV25 && ["extend", "edit"].includes(settings.taskType);
    const body = draftTaskId
        // Ark accepts only 1080p for an official Seedance 2.5 draft-task final.
        // Enforce it at the bridge boundary as well as in the canvas UI.
        ? { model, content: [{ type: "draft_task", draft_task: { id: draftTaskId } }], resolution: "1080p" }
        : {
              model,
              content: seedanceContent(input.prompt, references, params.mode),
              resolution: isV25 && settings.draft ? "480p" : requestedResolution,
              ratio: isAdaptiveTask ? "adaptive" : params.ratio || "16:9",
              duration: isEdit ? -1 : duration,
              generate_audio: params.generateAudio !== false,
              watermark: params.watermark === true,
              ...(isV25 ? {
                  omni_reference_task_type: settings.taskType || "reference",
                  draft: settings.draft === true,
                  output_format: settings.outputFormat === "mov" ? "mov" : "mp4",
                  seed: Number(settings.seed) || -1,
                  camera_fixed: settings.cameraFixed === true,
                  return_last_frame: settings.returnLastFrame === true,
              } : {}),
          };
    const created = await fetch(`${ARK_BASE_URL}/contents/generations/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
    });
    const createdBody = await created.json().catch(() => ({}));
    if (!created.ok) throw new Error(`方舟创建任务失败 (${created.status})：${createdBody.error?.message || createdBody.message || "未返回错误说明"}`);
    const taskId = createdBody.id;
    if (!taskId) throw new Error("方舟未返回任务 ID");
    for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const response = await fetch(`${ARK_BASE_URL}/contents/generations/tasks/${encodeURIComponent(taskId)}`, { headers: { authorization: `Bearer ${apiKey}` } });
        const task = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(`方舟查询任务失败 (${response.status})：${task.error?.message || task.message || "未返回错误说明"}`);
        const url = task.content?.video_url || task.video_url || task.url;
        if (url) {
            // Ark identifies a sample by the ID returned when the draft task is
            // created. The completed-task response does not reliably repeat it,
            // so preserve that creation ID for the canvas formal-generation flow.
            const resolvedDraftTaskId = draftTaskId || (isV25 && settings.draft ? taskId : task.draft_task_id);
            return { video_url: url, task_id: taskId, ...(resolvedDraftTaskId ? { draft_task_id: resolvedDraftTaskId } : {}) };
        }
        const status = String(task.status || "").toLowerCase();
        if (["failed", "cancelled", "canceled", "error"].includes(status)) throw new Error(task.error?.message || task.error || "Seedance 视频生成失败");
    }
}

async function handleSeedanceCosUpload(req, res) {
    try {
        const input = JSON.parse((await readBody(req)).toString("utf8"));
        if (input.kind !== "video" && input.kind !== "image" && input.kind !== "audio") throw new Error("不支持的 COS 素材类型");
        const url = await uploadToCos(required(input.dataUrl, "参考素材"), input.kind, input.seedance || {});
        sendJson(res, 200, { url });
    } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
}

async function handleSeedanceVideo(req, res) {
    try {
        const input = JSON.parse((await readBody(req)).toString("utf8"));
        const result = await generateSeedance(input);
        sendJson(res, 200, result);
    } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
}

async function forward(req, res, target) {
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    const upstream = await fetch(target, { method: req.method, headers: requestHeaders(req), body, redirect: "follow" });
    // Logged as soon as the status line arrives, so a long SSE stream still shows up immediately.
    res.writeHead(upstream.status, responseHeaders(upstream));
    if (!upstream.body) {
        res.end();
        return upstream.status;
    }
    // Streamed so that SSE responses (text generation) reach the browser chunk by chunk.
    const stream = Readable.fromWeb(upstream.body);
    res.on("close", () => stream.destroy());
    stream.pipe(res);
    return upstream.status;
}

export function createProxyServer() {
    const memoryTasks = createMemoryTasks();
    return createServer((req, res) => {
        if (req.method === "OPTIONS") {
            res.writeHead(204, CORS_HEADERS);
            res.end();
            return;
        }
        if (req.method === "POST" && req.url === "/seedance/cos-upload") {
            void handleSeedanceCosUpload(req, res);
            return;
        }
        if ((req.url || "").startsWith("/_tasks/")) {
            for (const [key, value] of Object.entries(CORS_HEADERS)) res.setHeader(key, value);
            void memoryTasks(req, res).catch(() => {
                if (!res.headersSent) sendJson(res, 500, { error: "后台内存任务处理失败；未自动重试。" });
                else res.destroy();
            });
            return;
        }
        if (req.method === "POST" && req.url === "/seedance/video") {
            void handleSeedanceVideo(req, res);
            return;
        }
        const target = readTarget(req.url || "/");
        if (!target) {
            sendJson(res, 200, { app: "infinite-canvas", proxy: pkg.name, version: pkg.version, memoryTasks: 1, usage: "/<full-target-url>" });
            return;
        }
        const startedAt = Date.now();
        const method = req.method || "GET";
        forward(req, res, target)
            .then((status) => logForward(method, target, status, startedAt))
            .catch((error) => {
                const reason = error instanceof Error ? error.message : String(error);
                logForward(method, target, `failed (${reason})`, startedAt);
                if (res.headersSent) {
                    res.destroy();
                    return;
                }
                sendJson(res, 502, { error: reason });
            });
    });
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
    console.log(`${pkg.name} v${pkg.version}\n\nUsage: npx ${pkg.name}@latest [--port 23210] [--host 127.0.0.1]\n\nForwards http://<host>:<port>/<full-target-url> to <full-target-url> with permissive CORS headers.`);
    process.exit(0);
}

const port = Number(readArg(args, "port", process.env.PORT || 23210));
const host = readArg(args, "host", process.env.HOST || "127.0.0.1");

createProxyServer().listen(port, host, () => {
    console.log(`${pkg.name} v${pkg.version} listening on http://${host}:${port}`);
    console.log(`Fill this address into Infinite Canvas → 配置 → 本地代理: http://${host}:${port}`);
});
