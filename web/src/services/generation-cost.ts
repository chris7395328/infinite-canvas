import { isVolcengineSeedance25, modelOptionName, resolveModelChannel, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import { useGenerationCostStore } from "@/stores/use-generation-cost-store";
import { normalizePriceResolution, resolveResolutionPrice } from "@/lib/generation-cost";
import { geminiImageCapabilities, normalizeGeminiImageSettings } from "@/lib/gemini-image";
import { inferMediaScale, parseVideoResolution } from "@/lib/media-size";
import type { GenerationCostSnapshot } from "@/types/generation-cost";
import type { CanvasNodeData } from "@/types/canvas";
import { isSeedanceDraftScript } from "@/lib/script-video-profile";
import { recordGenerationResource, type ReceivedResource } from "./generation-resources";

export function createGenerationCostSnapshot(config: AiConfig, projectId: string, nodeId: string, itemId?: string): GenerationCostSnapshot {
    const channel = resolveModelChannel(config, config.model);
    const model = channel.models.find((entry) => entry.name === modelOptionName(config.model));
    const musicDuration = config.geminiAudio?.musicDuration?.trim().match(/^(\d+(?:\.\d+)?)\s*(秒|s|seconds?|分钟|min(?:utes?)?)?$/i);
    const seconds = model?.capability === "video" ? Number(config.videoSeconds) : model?.capability === "audio" && musicDuration ? Number(musicDuration[1]) * (/分钟|min/i.test(musicDuration[2] || "") ? 60 : 1) : undefined;
    const capability = model?.capability || "image";
    const geminiImage = capability === "image" && geminiImageCapabilities(config.model);
    const draft = capability === "video" && (!model?.script || isSeedanceDraftScript(model.script)) && isVolcengineSeedance25(config) && resolveModelRequestConfig(config, config.model).seedance.draft;
    const resolution = capability === "video" ? normalizePriceResolution(draft ? "480" : /k$/i.test(config.vquality) ? config.vquality : parseVideoResolution(config.vquality), "video")
        : capability === "image" ? normalizePriceResolution(geminiImage ? normalizeGeminiImageSettings(config.model, config).geminiImageSize : inferMediaScale(config.size), "image") : undefined;
    const size = capability === "image" && !geminiImage ? config.size : undefined;
    const parameters = Object.fromEntries(Object.entries({ 尺寸: size, 分辨率: resolution, 质量: capability === "image" && !geminiImage ? config.quality : undefined, 画幅: capability === "video" ? config.size : geminiImage ? config.geminiAspectRatio : undefined, 时长秒: capability === "video" ? config.videoSeconds : undefined, ...(capability === "image" && !geminiImage && config.gptImage ? { 输出格式: config.gptImage.format, 构图复杂度: config.gptImage.complexity, 动画帧数: config.gptImage.format === "gif" ? config.gptImage.frameCount : undefined, 每帧毫秒: config.gptImage.format === "gif" ? config.gptImage.frameDurationMs : undefined } : {}) }).filter(([, value]) => value !== undefined)) as Record<string, string>;
    return { id: crypto.randomUUID(), projectId, nodeId, itemId, channelId: channel.id, channelName: channel.name, modelName: modelOptionName(config.model), capability, resolution, size, parameters, price: model ? resolveResolutionPrice(model, resolution, size) : undefined, seconds: seconds && seconds > 0 ? seconds : undefined };
}

export async function recordReceivedGeneration(snapshot: GenerationCostSnapshot | undefined, result: ReceivedResource) {
    if (!snapshot?.submittedAt || !(result.content || result.url)?.trim() || (snapshot.capability !== "text" && !result.storageKey)) return;
    await recordGenerationResource(snapshot, result);
    await useGenerationCostStore.getState().write(snapshot, "success");
}

export async function recordGenerationSubmitted(snapshot?: GenerationCostSnapshot) {
    if (snapshot) {
        snapshot.submittedAt ||= new Date().toISOString();
        await useGenerationCostStore.getState().write(snapshot, "pending");
    }
}

export async function cancelFailedGenerationCosts(projectId: string, nodes: CanvasNodeData[], previousNodes?: CanvasNodeData[]) {
    const store = useGenerationCostStore.getState();
    const pending = store.records.filter((record) => record.projectId === projectId && record.status === "pending");
    if (!pending.length) return;
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const previousById = previousNodes ? new Map(previousNodes.map((node) => [node.id, node])) : undefined;
    for (const record of pending) {
        const node = nodeById.get(record.nodeId);
        const previous = previousById?.get(record.nodeId);
        const previousResult = record.itemId ? previous?.metadata?.images?.find((item) => item.id === record.itemId) || previous?.metadata?.texts?.find((item) => item.id === record.itemId) : previous?.metadata;
        if (previousById && previousResult?.status !== "loading" && previous?.metadata?.status !== "loading") continue;
        const result = record.itemId ? node?.metadata?.images?.find((item) => item.id === record.itemId) || node?.metadata?.texts?.find((item) => item.id === record.itemId) : node?.metadata;
        if (result?.status === "error" || result?.status === "idle" || node?.metadata?.status === "error" || record.itemId && !result && node?.metadata?.status === "success") await store.write(record, "cancelled");
    }
}

export async function cancelGenerationCosts(projectId: string, nodeId: string, itemId?: string) {
    const store = useGenerationCostStore.getState();
    for (const record of store.records) if (record.projectId === projectId && record.nodeId === nodeId && (!itemId || record.itemId === itemId) && record.status === "pending") await store.write(record, "cancelled");
}
