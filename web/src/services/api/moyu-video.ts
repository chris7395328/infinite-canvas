import axios from "axios";
import { readFileAsDataUrl } from "@/lib/image-utils";
import { getMediaBlob } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { modelOptionName, normalizeLocalProxyUrl, withLocalProxy, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

type MediaOptions = { signal?: AbortSignal; videos?: ReferenceVideo[]; audios?: ReferenceAudio[] };
type MoyuTaskResponse = { id?: string; task_id?: string; code?: string; message?: string; data?: { task_id?: string } };
type MoyuPollResponse = {
    code?: string; message?: string;
    data?: { status?: string; fail_reason?: string; result_url?: string; video_url?: string;
        data?: { content?: { video_url?: string }; video_url?: string; error?: { message?: string } } };
};

export function isMoyuSeedance(config: AiConfig) {
    try {
        const host = new URL(config.baseUrl).hostname.toLowerCase();
        return config.apiFormat === "openai"
            && /(^|\.)moyu\.(info|cn)$/.test(host)
            && /^doubao-seedance-2-(0|5)/i.test(modelOptionName(config.model));
    } catch { return false; }
}
async function localMediaDataUrl(item: ReferenceVideo | ReferenceAudio, signal?: AbortSignal) {
    const blob = item.storageKey ? await getMediaBlob(item.storageKey) : null;
    if (blob) return readFileAsDataUrl(new File([blob], item.name, { type: item.type || blob.type }));
    if (item.url.startsWith("data:")) return item.url;
    if (!item.url) throw new Error("参考素材没有可读取的文件");
    const response = await fetch(withLocalProxy(item.url), { signal });
    if (!response.ok) throw new Error(`读取参考素材失败 (${response.status})`);
    const fetched = await response.blob();
    return readFileAsDataUrl(new File([fetched], item.name, { type: item.type || fetched.type }));
}

async function uploadMoyuCos(dataUrl: string, kind: "image" | "video" | "audio", config: AiConfig, signal?: AbortSignal) {
    if (!config.seedance.cosEnabled) throw new Error("魔芋参考素材必须上传 COS；请先开启 Seedance 设置中的 COS 上传");
    const bridge = normalizeLocalProxyUrl(config.seedance.bridgeUrl);
    if (!bridge) throw new Error("缺少本地 Bridge 地址，无法上传参考素材至 COS");
    const result = await axios.post<{ url?: string; error?: string }>(`${bridge}/seedance/cos-upload`,
        { dataUrl, kind, seedance: config.seedance }, { signal });
    if (!result.data.url) throw new Error(result.data.error || "COS 未返回参考素材 URL");
    return result.data.url;
}
export async function createMoyuSeedanceTask(config: AiConfig, prompt: string, images: ReferenceImage[], params: {
    seconds: string; resolution: string; ratio: string; mode: string; generateAudio: boolean;
}, options?: MediaOptions) {
    const is25 = /seedance-2-5/i.test(modelOptionName(config.model));
    const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt.trim() }];
    for (const [index, image] of images.entries()) {
        // Ordinary images accept data URLs directly; a local blob: URL is never sent to the upstream API.
        const source = /^https?:\/\//i.test(image.url || "") ? image.url! : await imageToDataUrl(image);
        const url = source.startsWith("data:") && config.seedance.cosEnabled
            ? await uploadMoyuCos(source, "image", config, options?.signal) : source;
        const role = params.mode === "frames" ? (index === 0 ? "first_frame" : "last_frame") : "reference_image";
        content.push({ type: "image_url", image_url: { url }, role });
    }
    for (const video of options?.videos || []) {
        const url = /^https?:\/\//i.test(video.url) || video.url.startsWith("asset://")
            ? video.url : await uploadMoyuCos(await localMediaDataUrl(video, options?.signal), "video", config, options?.signal);
        content.push({ type: "video_url", video_url: { url }, role: "reference_video" });
    }
    for (const audio of options?.audios || []) {
        const source = /^https?:\/\//i.test(audio.url) || audio.url.startsWith("asset://")
            ? audio.url : await localMediaDataUrl(audio, options?.signal);
        const url = source.startsWith("data:") && config.seedance.cosEnabled
            ? await uploadMoyuCos(source, "audio", config, options?.signal) : source;
        content.push({ type: "audio_url", audio_url: { url }, role: "reference_audio" });
    }
    const metadata: Record<string, unknown> = {
        content, duration: is25 && config.seedance.taskType === "edit" ? -1 : Number(params.seconds),
        ratio: is25 && ["edit", "extend"].includes(config.seedance.taskType) ? "adaptive" : params.ratio,
        resolution: params.resolution, generate_audio: params.generateAudio,
    };
    if (is25) {
        metadata.output_format = config.seedance.outputFormat === "mov" ? "mov" : "mp4";
        metadata.omni_reference_task_type = config.seedance.taskType || "auto";
    }
    // Do not fall back to the legacy /videos endpoint: the request might already have been billed.
    const url = withLocalProxy(`${config.baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "")}/v1/video/generations`);
    const response = await axios.post<MoyuTaskResponse>(url,
        { model: modelOptionName(config.model), prompt: prompt.trim(), metadata },
        { headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" }, signal: options?.signal });
    const id = response.data.task_id || response.data.id || response.data.data?.task_id;
    if (!id) throw new Error(`魔芋已响应但未返回任务 ID；请先在控制台核对已有任务，避免重复扣费。响应状态：${response.data.code || "unknown"}`);
    return String(id);
}

export async function pollMoyuSeedanceTask(config: AiConfig, id: string, signal?: AbortSignal) {
    const url = withLocalProxy(`${config.baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "")}/v1/video/generations/${encodeURIComponent(id)}`);
    const response = await axios.get<MoyuPollResponse>(url, {
        headers: { Authorization: `Bearer ${config.apiKey}` }, signal,
    });
    const payload = response.data;
    if (payload.code && payload.code !== "success" && payload.code !== "0")
        throw new Error(payload.message || `魔芋查询失败：${payload.code}`);
    const task = payload.data;
    if (!task) throw new Error("魔芋查询任务未返回 data");
    const status = String(task.status || "").toUpperCase();
    if (status === "FAILURE" || status === "FAILED" || status === "CANCELLED")
        return { status: "failed" as const, error: task.data?.error?.message || task.fail_reason || "魔芋视频生成失败" };
    const urlResult = task.data?.content?.video_url || task.data?.video_url || task.video_url || task.result_url;
    if (status === "SUCCESS" && urlResult) return { status: "completed" as const, url: urlResult };
    if (status === "SUCCESS") throw new Error("魔芋任务已成功，但查询响应没有返回视频 URL；请在控制台核对结果");
    return { status: "pending" as const };
}
