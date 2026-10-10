import axios from "axios";
import { geminiAudioCapabilities, normalizeGeminiAudio, type GeminiAudioSettings } from "@/lib/gemini-audio";
import { dataUrlToFile, readFileAsDataUrl } from "@/lib/image-utils";
import { imageToDataUrl } from "@/services/image-storage";
import { resolveModelRequestConfig, withLocalProxy, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";

export type GeminiAudioResult = { blob: Blob; audioText?: string; audioInteractionId?: string };
type AudioBlock = { type?: string; data?: string; uri?: string; mime_type?: string; text?: string };
type Interaction = { id?: string; status?: string; error?: { message?: string }; steps?: Array<{ type?: string; content?: AudioBlock[] }> };
export type GeminiVoice = { id: string; display_name?: string; description?: string; type?: string; language_code?: string; gender?: string; pitch?: string; accent?: string; context?: string; sample_audio?: { mime_type?: string; data?: string } };

function geminiAudioConfig(config: AiConfig) {
    const resolved = resolveModelRequestConfig(config, config.model || config.audioModel);
    if (resolved.apiFormat !== "gemini") throw new Error("此模型需要 Gemini 官方协议，请在渠道设置中选择 Gemini 格式。");
    if (!resolved.apiKey.trim() || !resolved.baseUrl.trim()) throw new Error("请先填写 Gemini 渠道地址和 API Key。");
    return { ...resolved, model: resolved.model.replace(/^models\//, "") };
}

function endpoint(config: AiConfig, path: string) {
    const base = config.baseUrl.trim().replace(/\/+$/, "");
    return withLocalProxy(`${/\/v1(?:beta)?$/i.test(base) ? base : `${base}/v1beta`}/${path}`);
}

function headers(config: AiConfig) {
    return { "x-goog-api-key": config.apiKey, "Content-Type": "application/json" };
}

function speechInput(prompt: string, settings: ReturnType<typeof normalizeGeminiAudio>) {
    const annotate = (text: string, speaker?: string, style?: string) => ({ type: "text", text, annotations: [{ type: "speech_metadata", ...(speaker ? { speaker } : {}), ...(style?.trim() ? { style: style.trim() } : {}) }] });
    if (settings.mode === "single") return [annotate(prompt, undefined, settings.style)];
    if (settings.speaker === settings.secondSpeaker) throw new Error("两位说话人的名称不能相同。");
    if ([settings.voice, settings.secondVoice].some((voice) => /^voice(?:key)?_/.test(voice))) throw new Error("官方双人单次合成仅支持预设音色；自定义音色请分别使用单人节点生成。");
    // Every non-empty line is a turn. Optional brackets override that turn's delivery style.
    return prompt.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
        const match = line.match(/^\s*([^：:\[\]]+?)(?:\[([^\]]+)\])?\s*[：:]\s*([\s\S]+)$/);
        const speaker = match?.[1].trim();
        if (!match || (speaker !== settings.speaker && speaker !== settings.secondSpeaker)) throw new Error(`双人对话请每行使用「${settings.speaker}：台词」或「${settings.secondSpeaker}：台词」，可写「${settings.speaker}[轻声]：台词」。`);
        return annotate(match[3], speaker, match[2] ?? (speaker === settings.speaker ? settings.style : settings.secondStyle));
    });
}

export function buildGeminiAudioBody(model: string, prompt: string, value?: GeminiAudioSettings) {
    const caps = geminiAudioCapabilities(model);
    const settings = normalizeGeminiAudio(model, value);
    if (!caps) throw new Error("当前 Gemini 音频模型尚未适配，请选择已支持的 3.8 TTS 或 Lyria 模型。");
    if (caps.kind === "tts") {
        const sampleRate = Number(settings.sampleRate);
        if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new Error("采样率必须为正整数（Hz）。");
        const voice = (speaker: string, voice: string) => ({ speaker, voice, ...(settings.language?.trim() ? { language: settings.language.trim() } : {}) });
        return {
            model, store: false,
            input: [{ type: "user_input", content: speechInput(prompt, settings) }],
            response_format: { type: "audio", mime_type: `audio/${settings.encoding}`, sample_rate: sampleRate },
            generation_config: { speech_config: settings.mode === "dialogue" ? { speakers: [voice(settings.speaker, settings.voice), voice(settings.secondSpeaker, settings.secondVoice)] } : [{ voice: settings.voice, ...(settings.language?.trim() ? { language: settings.language.trim() } : {}) }] },
        };
    }
    const directions = [
        settings.musicMode === "instrumental" ? "纯器乐，不要人声或歌词。" : settings.musicMode === "vocals" ? "生成人声歌曲。" : "",
        settings.musicStyle && `曲风：${settings.musicStyle}`, settings.musicMood && `情绪：${settings.musicMood}`,
        settings.musicInstruments && `乐器：${settings.musicInstruments}`, settings.musicTempo && `速度（BPM）：${settings.musicTempo}`,
        settings.musicKey && `调性：${settings.musicKey}`, !caps.clip && settings.musicDuration && `期望时长：${settings.musicDuration}`,
    ].filter(Boolean).join("\n");
    const lyrics = settings.musicMode !== "instrumental" && settings.musicLyrics?.trim() ? `\n\n以下为指定歌词（与音乐指令分开）：\n${settings.musicLyrics}` : "";
    return { model, store: false, input: `${prompt}${directions ? `\n\n音乐指令：\n${directions}` : ""}${lyrics}`, ...(settings.musicFormat === "wav" ? { response_format: { type: "audio" } } : {}) };
}

export async function requestGeminiAudio(config: AiConfig, prompt: string, options?: { signal?: AbortSignal; images?: ReferenceImage[] }): Promise<GeminiAudioResult> {
    const resolved = geminiAudioConfig(config);
    const caps = geminiAudioCapabilities(resolved.model);
    const body: Record<string, unknown> = buildGeminiAudioBody(resolved.model, prompt, config.geminiAudio);
    if (caps?.kind === "music" && options?.images?.length) {
        body.input = [{ type: "text", text: body.input }, ...await Promise.all(options.images.map(async (image) => {
            const dataUrl = await imageToDataUrl(image, { signal: options.signal });
            const match = dataUrl.match(/^data:([^;,]+);base64,([\s\S]+)$/);
            if (!match) throw new Error("参考图片读取失败，请重新连接图片素材。");
            return { type: "image", mime_type: match[1], data: match[2] };
        }))];
    }
    const { data } = await axios.post<Interaction>(endpoint(resolved, "interactions"), body, { headers: headers(resolved), signal: options?.signal });
    if (data.error || (data.status && data.status !== "completed")) throw new Error(data.error?.message || `音频任务未完成：${data.status}。`);
    const blocks = (data.steps || []).filter((step) => step.type === "model_output").flatMap((step) => step.content || []);
    const audio = blocks.filter((block) => block.type === "audio").at(-1);
    if (!audio?.data && !audio?.uri) throw new Error("Google 未返回音频，可能被安全策略拦截。请查看提示词或更换后重试。");
    const fallbackMime = caps?.kind === "tts" ? `audio/${normalizeGeminiAudio(resolved.model, config.geminiAudio).encoding}` : normalizeGeminiAudio(resolved.model, config.geminiAudio).musicFormat === "wav" ? "audio/wav" : "audio/mpeg";
    let blob: Blob;
    if (audio.data) {
        options?.signal?.throwIfAborted();
        blob = dataUrlToFile({ dataUrl: `data:${audio.mime_type || fallbackMime};base64,${audio.data}` });
    }
    else {
        const authenticated = new URL(audio.uri!).origin === new URL(resolved.baseUrl).origin;
        const response = await fetch(withLocalProxy(audio.uri!), { ...(authenticated ? { headers: headers(resolved) } : {}), signal: options?.signal });
        if (!response.ok) throw new Error(`音频下载失败（${response.status}）。`);
        blob = await response.blob();
    }
    if (!blob.size || !blob.type.startsWith("audio/")) throw new Error("Google返回的文件不是有效音频，请查看模型响应后重试。");
    return { blob, audioText: blocks.filter((block) => block.type === "text").map((block) => block.text || "").join("\n"), audioInteractionId: data.id };
}

export async function listGeminiVoices(config: AiConfig, filters: { search?: string; language_code?: string; type?: string; gender?: string; pitch?: string; accent?: string; context?: string; page_token?: string } = {}, signal?: AbortSignal) {
    const resolved = geminiAudioConfig(config);
    const params = Object.fromEntries(Object.entries(filters).filter(([, value]) => value).map(([key, value]) => [key, key === "search" || key === "page_token" ? value : [value]]));
    const { data } = await axios.get<{ voices?: GeminiVoice[]; next_page_token?: string }>(endpoint(resolved, "voices"), { headers: headers(resolved), params, paramsSerializer: { indexes: null }, signal });
    return data;
}

export async function createGeminiVoice(config: AiConfig, options: { name: string; description?: string; language?: string; source?: Blob; consent?: Blob }, signal?: AbortSignal) {
    const resolved = geminiAudioConfig(config);
    const audioData = async (file: Blob) => ({ mime_type: file.type || "audio/wav", data: (await readFileAsDataUrl(file)).split(",")[1] });
    const replicated = Boolean(options.source);
    if (!options.name.trim() || (!replicated && !options.description?.trim()) || (replicated && !options.consent)) throw new Error("请填写音色名称及描述，复刻还需参考音频和本人授权录音。");
    const { data } = await axios.post<GeminiVoice>(endpoint(resolved, "voices"), {
        store: true,
        voice: { model: resolved.model, type: replicated ? "replicated" : "prompted", display_name: options.name.trim(), ...(options.language?.trim() ? { language_code: options.language.trim() } : {}), ...(replicated ? { replicated: { source_audio: await audioData(options.source!), consent_audio: await audioData(options.consent!) } } : { prompted: { input: options.description!.trim() } }) },
    }, { headers: headers(resolved), signal });
    if (!data.id) throw new Error("Google 未返回音色 ID，请检查音色创建结果。");
    return data;
}
