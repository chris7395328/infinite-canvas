import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { providerError } from "./provider-error.js";

const ENDPOINT = "https://vod.intl.tencentcloudapi.com/";
const VERSIONS = ["1.0-pro", "1.0-pro-fast", "1.0-pro-mini", "1.5-pro"];
const required = (value, label) => { if (!String(value || "").trim()) throw new Error(`缺少 ${label}`); return String(value).trim(); };

// Tencent's official SDK performs TC3 signing afresh for every API request.
// Keep its raw response so HTTP errors retain provider messages and Request IDs.
export async function createVodCaller(settings, signal) {
    const { HttpConnection } = await import("tencentcloud-sdk-nodejs-common/tencentcloud/common/http/http_connection.js");
    const secretId = required(settings.secretId, "VOD SecretId");
    const secretKey = required(settings.secretKey, "VOD SecretKey");
    return async (action, body) => {
        const response = await HttpConnection.doRequestWithSign3({ method: "POST", url: ENDPOINT, service: "vod", action, version: "2018-07-17", region: "", secretId, secretKey, data: body, timeout: 0, signal });
        const text = await response.text();
        let data;
        try { data = JSON.parse(text); } catch { data = text; }
        if (!response.ok || data?.Response?.Error || typeof data !== "object" || !data?.Response) {
            const detail = typeof data === "string" ? (!/^\s*</.test(data) ? data : "返回了非JSON错误页面") : providerError(data, "未返回有效VOD响应");
            const safe = String(detail).replaceAll(secretKey, "[已隐藏]").replaceAll(secretId, "[已隐藏]");
            const error = new Error(`VOD ${action} 失败（HTTP ${response.status}）：${safe}`);
            error.retryable = response.status === 429 || response.status >= 500 || /^(RequestLimitExceeded|InternalError|ResourceUnavailable)/.test(data?.Response?.Error?.Code || "");
            const retry = response.headers.get("retry-after");
            error.retryAfter = retry ? Math.max(10000, /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : 10000;
            throw error;
        }
        return data.Response;
    };
}

export function vodRequest(input) {
    const settings = input.tencentVod || {};
    const subAppId = Number(settings.subAppId);
    if (!Number.isSafeInteger(subAppId) || subAppId <= 0) throw new Error("请填写有效的 VOD SubAppId");
    if (!VERSIONS.includes(input.model)) throw new Error("请选择文档中的 VOD 模型版本：" + VERSIONS.join("、"));
    const pro15 = input.model === "1.5-pro";
    const params = input.params || {};
    const duration = Number(params.seconds);
    if (!Number.isFinite(duration) || duration !== -1 && (duration < 4 || duration > (pro15 ? 30 : 15))) throw new Error(`VOD ${input.model} 支持4～${pro15 ? 30 : 15}秒，或-1自动时长`);
    const resolution = ({ "720p": "720P", "1080p": "1080P", "1440p": "2K", "2160p": "4K", "2k": "2K", "4k": "4K" })[String(params.resolution || "720p").toLowerCase()];
    if (!resolution) throw new Error("VOD文档列出的分辨率为720P、1080P、2K、4K；具体模型权限以上游为准");
    let ratio = params.ratio === "auto" || !params.ratio ? "adaptive" : params.ratio;
    const taskType = settings.taskType || "reference";
    if (!["reference", "auto", "edit", "extend"].includes(taskType)) throw new Error("无效的VOD任务类型");
    if (!pro15 && ["edit", "extend"].includes(taskType)) throw new Error("视频编辑／延长请选1.5-pro");
    if (["edit", "extend"].includes(taskType)) ratio = "adaptive";
    if (!["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"].includes(ratio)) throw new Error("不支持的VOD画面比例");
    const references = input.references || [];
    if (!Array.isArray(references) || references.some((item) => !["image", "video", "audio"].includes(item.kind) || typeof item.source !== "string")) throw new Error("无效的VOD参考素材");
    const counts = Object.fromEntries(["image", "video", "audio"].map((kind) => [kind, references.filter((item) => item.kind === kind).length]));
    if (counts.image > (pro15 ? 30 : 9) || counts.video > (pro15 ? 10 : 3) || counts.audio > (pro15 ? 10 : 3) || references.length > (pro15 ? 50 : 12)) throw new Error(pro15 ? "1.5-pro最多30张图、10段视频、10段音频，合计50份" : "1.0-pro系列最多9张图、3段视频、3段音频，合计12份");
    if (counts.audio && !counts.image && !counts.video) throw new Error("参考音频必须搭配图片或视频");
    if (["edit", "extend"].includes(taskType) && !counts.video) throw new Error("视频编辑／延长必须连接参考视频节点");
    const frames = params.mode === "frames" && counts.image > 0;
    if (frames && (counts.image > 2 || counts.video || counts.audio)) throw new Error("首尾帧仅支持一张首帧或两张首尾帧，不能混用其他参考素材，请切换全参考");
    const additional = { ...(pro15 ? { omni_reference_task_type: taskType } : {}), ...(settings.returnLastFrame ? { return_last_frame: true } : {}) };
    const wand = { ReturnVegaUsage: true, EnhancePromptMode: settings.enhancePrompt ? "enable" : "disable" };
    const body = { SubAppId: subAppId, ModelName: "wand-vega-video", ModelVersion: input.model, Prompt: required(input.prompt, "提示词"), OutputConfig: { StorageMode: "Temporary", Duration: taskType === "edit" ? -1 : duration, Resolution: resolution, AspectRatio: ratio, AudioGeneration: params.generateAudio === false ? "Disabled" : "Enabled", LogoAdd: params.watermark ? "Enabled" : "Disabled" }, ExtInfo: JSON.stringify({ AdditionalParameters: JSON.stringify(additional), WandVegaParameters: JSON.stringify(wand) }), SessionId: randomUUID() };
    if (settings.seed !== "" && settings.seed !== undefined && Number(settings.seed) !== -1) {
        if (!Number.isSafeInteger(Number(settings.seed))) throw new Error("Seed必须为整数");
        body.Seed = Number(settings.seed);
    }
    return { body, references, frames, settings, subAppId };
}

export async function generateTencentVod(input, { signal, uploadToCos, onTask = async () => {}, onWarning = () => {}, call, wait = pause } = {}) {
    const { body, references, frames, settings, subAppId } = vodRequest(input);
    call ||= await createVodCaller(settings, signal);
    async function query(id, field) {
        let interval = 10000;
        for (;;) {
            await wait(interval, undefined, { signal });
            signal?.throwIfAborted();
            let result;
            try { result = await call("DescribeTaskDetail", { SubAppId: subAppId, TaskId: id }); }
            catch (error) {
                if (signal?.aborted) throw error;
                if (error.retryable === false) throw error;
                interval = error.retryAfter || 10000;
                onWarning(`VOD原任务查询暂时失败，后台继续等待：${error.message}`);
                continue;
            }
            interval = 10000;
            onWarning(undefined);
            const task = result[field];
            if (task?.ErrCode || task?.ErrCodeExt || ["FAIL", "FAILED", "CANCELLED", "CANCELED"].includes(task?.Status || result.Status)) throw new Error(`VOD任务失败：${[task?.ErrCodeExt || task?.ErrCode, task?.Message || result.Message, result.RequestId && `Request ID: ${result.RequestId}`].filter(Boolean).join("；")}`);
            if (result.Status === "FINISH" || task?.Status === "FINISH") {
                if (!task?.Output) throw new Error(`VOD任务已结束但缺少${field}结果；原任务${id}，未重新生成`);
                return task.Output;
            }
        }
    }
    const files = [];
    const cache = new Map();
    const groupId = settings.groupId?.trim() || "infinite-canvas";
    let imageIndex = 0;
    for (const item of references) {
        signal?.throwIfAborted();
        let url = cache.get(item.kind + ":" + item.source);
        if (!url) {
            url = item.source;
            if (url.startsWith("data:")) url = await uploadToCos(url, item.kind, input.cos || {}, signal);
            if (!/^https?:\/\//i.test(url) && !/^asset:\/\/asset-[^/\s]+\/?$/.test(url)) throw new Error("参考素材必须为COS公网直链或本VOD应用的asset ID");
            if (settings.usePrivateAssets !== false && !url.startsWith("asset://")) {
                const created = await call("CreateAigcMaterial", { SubAppId: subAppId, FileInfo: { Type: "Url", Url: url }, AssetType: item.kind[0].toUpperCase() + item.kind.slice(1), GroupId: groupId, AssetName: `canvas-${item.kind}-${randomUUID()}`, IsRealPerson: "False", GroupName: "Infinite Canvas", SessionId: randomUUID() });
                if (!created.TaskId) throw new Error("VOD素材入库未返回TaskId，尚未提交视频生成");
                const output = await query(created.TaskId, "CreateAigcMaterialTask");
                if (!output.AssetId) throw new Error("VOD素材入库未返回AssetId，尚未提交视频生成");
                url = `asset://${output.AssetId}`;
            }
            cache.set(item.kind + ":" + item.source, url);
        }
        const usage = frames && item.kind === "image" ? imageIndex++ === 0 ? "FirstFrame" : "LastFrame" : "Reference";
        files.push({ Type: "Url", Category: item.kind[0].toUpperCase() + item.kind.slice(1), Url: url, Usage: usage });
    }
    if (files.length) body.FileInfos = files;
    // Every creation call is sent once. A transport failure is uncertain, not a reason to POST again.
    const created = await call("CreateAigcVideoTask", body);
    if (!created.TaskId) throw new Error("VOD未返回视频TaskId；提交结果不确定，禁止自动重新生成");
    await onTask(created.TaskId);
    const output = await query(created.TaskId, "AigcVideoTask");
    const video = output.FileInfos?.find((file) => file.FileUrl && !file.UsageType && (/^(video\/)?(mp4|mov|webm)$/i.test(file.FileType || "") || /\.(mp4|mov)(?:\?|$)/i.test(file.FileUrl)));
    if (!video) throw new Error(`VOD任务已完成但未返回可下载视频；TaskId: ${created.TaskId}，未重新生成`);
    const url = new URL(video.FileUrl);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("VOD返回了无效视频地址");
    return { url: video.FileUrl, headers: {}, mime: /\.mov(?:\?|$)/i.test(video.FileUrl) ? "video/quicktime" : "video/mp4" };
}
