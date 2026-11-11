// @canvas-video-profile seedance-series
// 编辑输入时长修订：video_duration为输入实际秒数，duration=0仅是编辑标记。
// Seedance系列新版 /v1/videos 协议；当前模型ID原样提交，不用于官方Ark协议。
const COS_SOURCE_CHANNEL_ID = ""; // 当前渠道优先，否则复用唯一完整COS；多套时填写来源渠道ID。
if (!apiKey.trim()) throw new Error("请填写当前平台API Key，尚未提交生成。");
const v25 = model === "seedance-2.5";
if (!["seedance-2.0", "seedance-2.0-fast", "seedance-2.0-mini", "seedance-2.5"].includes(model)) throw new Error("此模板仅适用文档中的seedance-2.0／fast／mini及seedance-2.5；请选择平台真实模型ID，不改写其他模型别名。");
const createUrl = http.url("/videos");
const endpoint = new URL(baseUrl);
const marker = createUrl.indexOf("/" + endpoint.origin + "/");
if (marker < 0) throw new Error("请启用本地代理，让本机／Docker后台等待；尚未提交生成。");
const identity = await globalThis.fetch(createUrl.slice(0, marker) + "/", { signal, cache: "no-store" });
if (!identity.ok || (await identity.json()).seedanceSeries !== 1) throw new Error("请先更新并重启本机后台（Docker需新版proxy），以支持本平台鉴权下载与正片查询；尚未提交生成。");
const draftId = seedance.draft === false ? String(seedance.draftTaskId || "").trim() : "";
let url = createUrl;
let body;
const draft = !draftId && v25 && seedance.draft === true;
if (draftId) {
    if (!v25 || !seedance.draftQuote || !Number.isFinite(seedance.draftQuoteExpiresAt) || seedance.draftQuoteExpiresAt * 1000 <= Date.now()) throw new Error("样片转正片需要有效报价，请重新点击正式生成确认报价；尚未提交生成。");
    url = http.url("/final-conversions/" + encodeURIComponent(draftId));
    body = { quote: seedance.draftQuote };
} else {
    if (!prompt.trim() || prompt.length > 60000) throw new Error("提示词须为1～60000字符，尚未上传素材或提交生成。");
    const taskType = seedance.taskType || "reference";
    if (!["auto", "reference", "edit"].includes(taskType)) throw new Error("新版文档没有延长视频模式，请选择全参考、自动或2.5视频编辑。");
    const edit = taskType === "edit";
    if (edit && (!v25 || videos.length !== 1 || audios.length || seedance.draft === true)) throw new Error("2.5编辑必须连接恰好一段4～30秒视频，可附加图片，不支持音频或样片；尚未提交生成。");
    for (const [kind, files] of [["image", images], ["video", videos], ["audio", audios]]) {
        for (const file of files) {
            const mime = typeof file === "string" ? file.match(/^data:([^;,]+)/i)?.[1] : file.type;
            if (mime && /^(image|video|audio)\//i.test(mime) && !mime.toLowerCase().startsWith(kind + "/")) throw new Error(kind + "参考实际文件类型为" + mime + "，素材类别不匹配；请重新连接正确类型节点，尚未上传或创建视频。");
        }
    }
    const duration = edit ? 0 : Number(params.seconds ?? -1);
    const videoDuration = edit ? Number(params.video_duration ?? seedance.videoDuration) : undefined;
    if (edit && (!Number.isFinite(videoDuration) || videoDuration <= 0)) throw new Error("2.5编辑需要输入视频实际时长video_duration（秒，支持小数）；请填写节点参数或由新版画布读取视频时长，尚未上传素材或提交生成。");
    const max = v25 ? 30 : 15;
    if (!Number.isInteger(duration) || !edit && duration !== -1 && (duration < 4 || duration > max)) throw new Error("此模型仅支持4～" + max + "秒整数或-1智能时长；编辑固定为0。");
    if (!v25 && seedance.draft) throw new Error("2.0系列不支持样片模式。");
    const resolution = draft ? "480p" : String(params.resolution || "720p").toLowerCase();
    if (!(model === "seedance-2.0-fast" || model === "seedance-2.0-mini" ? ["480p", "720p"] : ["480p", "720p", "1080p"]).includes(resolution)) throw new Error("该模型不支持所选分辨率，请按节点档位选择。");
    if (images.length > (v25 ? 30 : 9) || videos.length > (v25 ? 10 : 3) || audios.length > (v25 ? 10 : 3) || images.length + videos.length + audios.length > (v25 ? 50 : 15)) throw new Error("参考素材数量超出此模型文档限制。");
    const frames = !edit && params.mode === "frames" && images.length > 0;
    if (frames && (images.length > 2 || videos.length || audios.length)) throw new Error("首帧／首尾帧只支持1～2张图，不能混用参考视频或音频；请切换全参考。");
    const ratio = edit || !params.ratio || params.ratio === "auto" ? "adaptive" : params.ratio;
    if (!["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"].includes(ratio)) throw new Error("不支持的画幅比例。");
    // 文档要求的规格交上游复核；不擅自转码、裁剪、合并、去重或重新排序。
    async function material(file, kind) {
        if (typeof file === "string" && /^asset_[A-Za-z0-9_-]+$/.test(file)) return file;
        if (typeof file === "string" && file.startsWith("asset://")) throw new Error("新版只接受本平台asset_素材ID，不接受asset://或其他私域库ID。");
        const value = typeof file === "string" && /^https?:\/\//i.test(file) ? file : await uploadToCos(file, kind, COS_SOURCE_CHANNEL_ID || undefined);
        const address = new URL(value);
        if (address.protocol !== "https:" || address.username || address.password || address.hash || value.length > 2048 || /^(localhost|\[::1\])$/i.test(address.hostname) || /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address.hostname)) throw new Error("参考素材须为可匿名下载的公网HTTPS直链或本平台asset_素材ID；COS链接无效，尚未提交生成。");
        return value;
    }
    async function ordered(files, kind) {
        const result = [];
        for (const file of files) result.push(await material(file, kind));
        return result;
    }
    body = { model, prompt, duration, resolution, aspect_ratio: ratio, generate_audio: params.generateAudio !== false, search_enabled: seedance.searchEnabled !== false, count: 1 };
    if (v25) body.draft = draft;
    if (edit) { body.mode = "videoEdit2video"; body.video_duration = videoDuration; }
    else if (frames) body.mode = "frames2video";
    // Automatic/reference mode is omitted; do not send the literal "auto" or undocumented Ark fields.
    if (images.length) body.reference_images = await ordered(images, "image");
    if (videos.length) body.reference_videos = await ordered(videos, "video");
    if (audios.length) body.reference_audios = await ordered(audios, "audio");
}
// Exactly one paid POST. Docker polls the same ID every10s and downloads /content with Bearer auth.
let response;
try {
    response = await fetch(url, { method: "POST", signal, headers: { Authorization: "Bearer " + apiKey.trim(), "Content-Type": "application/json", ...(draftId ? { "Idempotency-Key": crypto.randomUUID() } : {}), "x-canvas-video-protocol": "seedance-series" }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(await response.text());
} catch (error) {
    if (signal?.aborted || error?.name === "AbortError") throw error;
    // Keep a safe request summary, never credentials, quote tokens, prompts or signed media URLs.
    const summary = draftId ? { model, mode: "final-conversion" } : { model, mode: body.mode || "平台自动选择", duration: body.duration, video_duration: body.video_duration, aspect_ratio: body.aspect_ratio, resolution: body.resolution, draft: body.draft, generate_audio: body.generate_audio, search_enabled: body.search_enabled, reference_images: body.reference_images?.length || 0, reference_videos: body.reference_videos?.length || 0, reference_audios: body.reference_audios?.length || 0, video_file_types: videos.map(file => typeof file === "string" ? "URL或素材ID" : file.type || "未知") };
    throw new Error(String(error?.message || error).replaceAll(apiKey.trim(), "[已隐藏]") + "；实际提交参数（不含密钥／提示词／素材URL）：" + JSON.stringify(summary) + "。未重新提交生成。");
}
const blob = await response.blob();
if (!blob.size || /json|text\//i.test(blob.type)) throw new Error("后台尚未返回视频文件，请查询原任务，不要重新生成。");
const upstreamId = response.headers.get("x-canvas-upstream-id");
if (draft && !upstreamId) throw new Error("样片已保存但缺少平台任务ID，请查询原任务，未重新提交。");
return { blob, ...(draft ? { draftTaskId: upstreamId } : {}) };
