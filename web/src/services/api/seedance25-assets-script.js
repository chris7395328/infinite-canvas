// @canvas-video-profile seedance-2.5-assets
// 此脚本用于所给 /v1/videos + /v1/video-assets/action 文档，不按域名猜测协议。
// 模型名、API地址和Key全部读取当前选择，不在脚本里填写密钥。
const COS_SOURCE_CHANNEL_ID = ""; // 留空：当前渠道优先，否则复用唯一一套已有COS。
const ASSET_GROUP_ID = ""; // 真人素材必须填写在本平台完成认证后取得的GroupId。
const PROJECT_NAME = "default";

if (!apiKey.trim() || !model.trim()) throw new Error("请先选择模型并填写当前平台API Key，尚未提交生成。");
const endpoint = new URL(baseUrl);
if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error("无效的平台地址。");
const createUrl = http.url("/videos");
const marker = createUrl.indexOf("/" + endpoint.origin + "/");
if (marker < 0) throw new Error("请启用本地代理；视频必须在本机／Docker后台等待，尚未提交生成。");
const proxy = createUrl.slice(0, marker);
const identity = await globalThis.fetch(proxy + "/", { signal, cache: "no-store" });
if (!identity.ok || (await identity.json()).taskResultMetadata !== 1) throw new Error("请先更新并重启本机后台（Docker需新版proxy），以保留草稿平台任务ID；尚未提交生成。");

const draftId = seedance.draft === false ? String(seedance.draftTaskId || "").trim() : "";
const draft = !draftId && seedance.draft === true;
let body;
if (draftId) {
    // 只用平台草稿ID续作，不读／上传参考素材，不重复附带继承参数。
    body = { model, content: [{ type: "draft_task", draft_task: { id: draftId } }], draft: false, resolution: "1080p" };
} else {
    const taskType = seedance.taskType || "reference";
    if (!["auto", "reference", "edit", "extend"].includes(taskType)) throw new Error("无效的任务类型。");
    const duration = Number(params.seconds ?? -1);
    if (!Number.isInteger(duration) || duration !== -1 && (duration < 4 || duration > 30)) throw new Error("此模型仅支持4～30秒整数或-1自动时长，尚未提交生成。");
    const resolution = draft ? "480p" : String(params.resolution || "720p").toLowerCase();
    if (!["480p", "720p", "1080p"].includes(resolution)) throw new Error("此渠道只公布480p、720p、1080p，不支持2K／4K，尚未提交生成。");
    if (images.length > 30 || videos.length > 10 || audios.length > 10) throw new Error("此模型最多30张参考图、10段参考视频、10段参考音频；单类视频／音频总时长须不超过30秒。");
    const frames = params.mode === "frames" && images.length > 0;
    if (frames && (images.length > 2 || videos.length || audios.length)) throw new Error("首尾帧只能一张首帧或两张首尾帧，不能混用参考视频／音频，请切换全参考。");
    if (["edit", "extend"].includes(taskType) && !videos.length) throw new Error("编辑／延长任务必须连接参考视频节点，尚未上传或创建任务。");
    const ratio = frames || ["edit", "extend"].includes(taskType) ? "adaptive" : !params.ratio || params.ratio === "auto" ? "adaptive" : params.ratio;
    if (!["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"].includes(ratio)) throw new Error("不支持的画面比例。");
    const content = prompt.trim() ? [{ type: "text", text: prompt }] : [];
    const refs = [["image", images], ["video", videos], ["audio", audios]].flatMap(([kind, files]) => files.map((file, index) => ({ kind, file, index })));
    if (!content.length && !refs.length) throw new Error("请填写提示词或连接参考素材，尚未提交生成。");
    const auth = { Authorization: "Bearer " + apiKey.trim(), "Content-Type": "application/json", Accept: "application/json" };
    let retryAfter = 10000;
    async function action(name, payload) {
        const path = "/video-assets/action?" + new URLSearchParams({ model, Action: name, Version: "2024-01-01" });
        let response;
        try { response = await globalThis.fetch(http.url(path), { method: "POST", headers: auth, signal, body: JSON.stringify(payload) }); }
        catch (error) { error.retryable = true; throw error; }
        const retry = response.headers.get("retry-after");
        retryAfter = retry ? Math.max(10000, /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now() || 10000) : 10000;
        const raw = await response.text();
        let data;
        try { data = JSON.parse(raw); } catch { data = {}; }
        const error = data.ResponseMetadata?.Error || data.error;
        if (!response.ok || error || !data.Result) {
            const detail = typeof error === "string" ? error : [error?.Code || error?.code, error?.Message || error?.message, data.message].filter(Boolean).join("；");
            const requestId = data.ResponseMetadata?.RequestId || data.request_id;
            const safeDetail = (detail || (!/^\s*</.test(raw) && raw) || "未返回有效素材结果").replaceAll(apiKey.trim(), "[已隐藏]");
            const failure = new Error(name + "失败（HTTP " + response.status + "）：" + safeDetail + (requestId ? "；Request ID: " + requestId : "") + "；尚未创建视频。");
            failure.retryable = response.status === 429 || response.status >= 500;
            throw failure;
        }
        return data.Result;
    }
    async function active(id) {
        for (;;) {
            signal?.throwIfAborted();
            let asset;
            try { asset = await action("GetAsset", { Id: id, ProjectName: PROJECT_NAME }); }
            catch (error) { if (signal?.aborted || !error.retryable) throw error; await sleep(retryAfter); continue; }
            const status = String(asset.Status || "").toLowerCase();
            if (status === "active") return;
            if (status !== "processing") throw new Error("素材" + id + "状态为" + (asset.Status || "未知") + "，不可生成；请核对素材详情及真人认证，尚未创建视频。");
            await sleep(retryAfter);
        }
    }
    let groupId = ASSET_GROUP_ID.trim();
    if (refs.some((ref) => typeof ref.file !== "string" || !ref.file.startsWith("asset://"))) {
        if (!groupId) {
            // 只缓存平台素材组ID；密钥只用于本机计算缓存命名，不写入存储。
            const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint.href + "\n" + model + "\n" + apiKey));
            const cacheKey = "infinite-canvas:asset-group:" + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
            groupId = globalThis.localStorage.getItem(cacheKey) || "";
            if (!groupId) {
                const group = await action("CreateAssetGroup", { Name: "Infinite Canvas", Description: "画布普通参考素材；真人须另行认证", GroupType: "AIGC", ProjectName: PROJECT_NAME });
                if (!group.Id) throw new Error("素材组未返回Result.Id，尚未创建视频。");
                groupId = group.Id;
                globalThis.localStorage.setItem(cacheKey, groupId);
            }
        }
    }
    for (const ref of refs) {
        let id;
        if (typeof ref.file === "string" && ref.file.startsWith("asset://")) {
            id = ref.file.slice("asset://".length);
            if (!id || /[\s/]/.test(id)) throw new Error("无效的本平台asset://素材ID。");
        } else {
            const url = typeof ref.file === "string" && /^https?:\/\//i.test(ref.file) ? ref.file : await uploadToCos(ref.file, ref.kind, COS_SOURCE_CHANNEL_ID || undefined);
            const asset = await action("CreateAsset", { GroupId: groupId, URL: url, Name: "canvas-" + ref.kind + "-" + (ref.index + 1), AssetType: ref.kind[0].toUpperCase() + ref.kind.slice(1), ProjectName: PROJECT_NAME });
            if (!asset.Id) throw new Error("素材入库未返回Result.Id，尚未创建视频。");
            id = asset.Id;
        }
        await active(id);
        const role = frames ? ref.index === 0 ? "first_frame" : "last_frame" : "reference_" + ref.kind;
        content.push({ type: ref.kind + "_url", [ref.kind + "_url"]: { url: "asset://" + id }, role });
    }
    body = { model, content, duration: taskType === "edit" ? -1 : duration, resolution, ratio, draft, generate_audio: params.generateAudio !== false, watermark: params.watermark === true, output_format: seedance.outputFormat === "mov" ? "mov" : "mp4" };
    if (refs.length && !frames) body.omni_reference_task_type = taskType;
    if (!draft && seedance.returnLastFrame) body.return_last_frame = true;
}
// 只有这一步创建生成回执并预记费；素材操作不记作视频生成。
// 一次POST；后台每10秒查询同一平台ID并下载公开成片，刷新不重跑JS或重发POST。
const response = await fetch(createUrl, { method: "POST", signal, headers: { Authorization: "Bearer " + apiKey.trim(), "Content-Type": "application/json", "x-canvas-video-protocol": "json-video", "x-canvas-video-public-result": "1" }, body: JSON.stringify(body) });
if (!response.ok) throw new Error(await response.text());
const blob = await response.blob();
if (!blob.size || /json|text\//i.test(blob.type)) throw new Error("后台尚未返回有效视频，请查询原任务，不要盲目重新生成。");
const upstreamId = response.headers.get("x-canvas-upstream-id");
if (draft && !upstreamId) throw new Error("已取得草稿文件但缺少平台任务ID，后台结果仍保留；请查询原任务，未重新生成。");
return { blob, ...(draft ? { draftTaskId: upstreamId } : {}) };
