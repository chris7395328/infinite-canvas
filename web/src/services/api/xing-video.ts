import axios from "axios";
import { inferVideoRatio } from "@/lib/media-size";
import { imageToDataUrl } from "@/services/image-storage";
import { boolConfig, buildApiUrl, modelOptionName, useConfigStore, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import { backgroundPost, type BackgroundContext } from "./background-tasks";
import { localMediaDataUrl, uploadMoyuCos } from "./moyu-video";

export function isXingSeedance933(config: AiConfig) {
    try { return new URL(config.baseUrl).hostname.toLowerCase() === "xingapi.top" && modelOptionName(config.model) === "seedance-933"; }
    catch { return false; }
}

function publicUrl(value: string) {
    try {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password || /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[|0\.)/i.test(url.hostname) || !url.hostname.includes(".")) return false;
        return true;
    } catch { return false; }
}

export async function createXingSeedanceTask(config: AiConfig, prompt: string, images: ReferenceImage[], options?: { signal?: AbortSignal; background?: BackgroundContext; videos?: ReferenceVideo[]; audios?: ReferenceAudio[] }) {
    const videos = options?.videos || [], audios = options?.audios || [];
    if (!prompt.trim()) throw new Error("933 需要非空提示词。");
    if (images.length > 9 || videos.length > 3 || audios.length > 3) throw new Error("933 最多允许 9 张参考图、3 段参考视频、3 段参考音频。");
    const duration = Number(config.videoSeconds);
    if (!Number.isInteger(duration) || duration < 4 || duration > 15) throw new Error("933 时长必须是 4～15 秒整数。");
    if (!["720", "720p"].includes(config.vquality)) throw new Error("933 当前渠道仅支持 720p，请调整节点画质。");
    const ratio = inferVideoRatio(config.size);
    if (!["16:9", "9:16"].includes(ratio)) throw new Error("933 请选择 16:9 或 9:16。");
    const source = async (url: string | undefined, data: () => Promise<string>, kind: "image" | "video" | "audio") => {
        if (url && publicUrl(url)) return url;
        const uploaded = await uploadMoyuCos(await data(), kind, config, options?.signal);
        if (!publicUrl(uploaded)) throw new Error("933 参考素材需要可公开访问的 HTTPS 文件直链，请检查 COS 公网地址。");
        return uploaded;
    };
    // Upload only on explicit generation, never when connecting canvas nodes.
    const body = {
        model: "seedance-933", prompt: prompt.trim(), duration, ratio, resolution: "720p", n: 1,
        generate_audio: boolConfig(config.videoGenerateAudio, true),
        ...(images.length ? { images: await Promise.all(images.map((item) => source(item.url, () => imageToDataUrl(item), "image"))) } : {}),
        ...(videos.length ? { videos: await Promise.all(videos.map((item) => source(item.url, () => localMediaDataUrl(item, options?.signal), "video"))) } : {}),
        ...(audios.length ? { audios: await Promise.all(audios.map((item) => source(item.url, () => localMediaDataUrl(item, options?.signal), "audio"))) } : {}),
    };
    const headers = { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() };
    const url = buildApiUrl(config.baseUrl, "/videos/generations");
    if (options?.background && useConfigStore.getState().config.proxyEnabled) return (await backgroundPost<Blob>(url, body, { headers, responseType: "blob", signal: options.signal }, options.background, "xing933-video")).data;
    const response = (await axios.post(url, body, { headers, signal: options?.signal })).data;
    const value = response.data || response;
    if (value.error || !value.id && !value.task_id) throw new Error(value.error?.message || value.message || "933 未返回任务 ID，未重新提交；请核对上游是否受理。");
    return String(value.id || value.task_id);
}
