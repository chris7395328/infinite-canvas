import { modelOptionName, resolveModelChannel, type AiConfig } from "@/stores/use-config-store";
import { useGenerationCostStore } from "@/stores/use-generation-cost-store";
import { normalizeModelPrice } from "@/lib/generation-cost";
import type { GenerationCostSnapshot } from "@/types/generation-cost";
import type { CanvasNodeData } from "@/types/canvas";

export function createGenerationCostSnapshot(config: AiConfig, projectId: string, nodeId: string, itemId?: string): GenerationCostSnapshot {
    const channel = resolveModelChannel(config, config.model);
    const model = channel.models.find((entry) => entry.name === modelOptionName(config.model));
    const musicDuration = config.geminiAudio?.musicDuration?.trim().match(/^(\d+(?:\.\d+)?)\s*(秒|s|seconds?|分钟|min(?:utes?)?)?$/i);
    const seconds = model?.capability === "video" ? Number(config.videoSeconds) : model?.capability === "audio" && musicDuration ? Number(musicDuration[1]) * (/分钟|min/i.test(musicDuration[2] || "") ? 60 : 1) : undefined;
    return { id: crypto.randomUUID(), projectId, nodeId, itemId, channelId: channel.id, channelName: channel.name, modelName: modelOptionName(config.model), capability: model?.capability || "image", price: normalizeModelPrice(model?.price), seconds: seconds && seconds > 0 ? seconds : undefined };
}

export async function recordReceivedGeneration(snapshot: GenerationCostSnapshot | undefined, result: { content?: string; url?: string; storageKey?: string }) {
    if (!snapshot?.submittedAt || !(result.content || result.url)?.trim() || (snapshot.capability !== "text" && !result.storageKey)) return;
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
