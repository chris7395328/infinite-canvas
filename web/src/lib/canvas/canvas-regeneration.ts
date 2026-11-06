import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

export function regenerateInPlace(node: CanvasNodeData | undefined, mode: string) {
    return Boolean(node && node.type === mode && ["image", "video", "audio", "text"].includes(mode) && (!node.metadata?.content || node.metadata.model));
}

export function resetGenerationResult(metadata: CanvasNodeMetadata = {}) {
    const next = { ...metadata };
    for (const key of ["content", "storageKey", "naturalWidth", "naturalHeight", "bytes", "mimeType", "durationMs", "images", "texts", "primaryImageId", "primaryTextId", "videoTaskId", "videoTaskProvider", "generationRecovery", "generationCost", "seedanceDraftTaskId", "errorDetails"] as const) delete next[key];
    return next;
}
