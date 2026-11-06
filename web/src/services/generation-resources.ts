import type { CanvasNodeData } from "@/types/canvas";
import type { GenerationCostSnapshot } from "@/types/generation-cost";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { saveGenerationResource, type GenerationResourceKind } from "@/stores/use-generation-resource-store";

export type ReceivedResource = { content?: string; url?: string; storageKey?: string; mimeType?: string; width?: number; height?: number; naturalWidth?: number; naturalHeight?: number; bytes?: number; durationMs?: number };

export async function recordGenerationResource(snapshot: GenerationCostSnapshot, result: ReceivedResource) {
    const project = useCanvasStore.getState().projects.find((entry) => entry.id === snapshot.projectId);
    const node = project?.nodes.find((entry) => entry.id === snapshot.nodeId);
    await saveGenerationResource({
        kind: snapshot.capability, projectId: snapshot.projectId, projectTitle: project?.title || "未命名画布", nodeId: snapshot.nodeId,
        title: node?.title || snapshot.modelName, prompt: snapshot.prompt || node?.metadata?.prompt || "", model: snapshot.modelName,
        createdAt: new Date().toISOString(), content: result.url || result.content || "", storageKey: result.storageKey,
        mimeType: result.mimeType, width: result.width || result.naturalWidth, height: result.height || result.naturalHeight, bytes: result.bytes, durationMs: result.durationMs,
    }, snapshot.itemId);
}

/** Preserve extant results before overwriting; old projects do not have an exact per-result completion date. */
export async function preserveNodeResources(project: Pick<CanvasProject, "id" | "title" | "updatedAt">, node: CanvasNodeData) {
    const metadata = node.metadata;
    if (!metadata?.model || !["image", "video", "audio", "text"].includes(node.type)) return;
    const base = { kind: node.type as GenerationResourceKind, projectId: project.id, projectTitle: project.title, nodeId: node.id, title: node.title,
        prompt: metadata.prompt || "", model: metadata.model, createdAt: project.updatedAt, approximateDate: true };
    if (node.type === "image" && metadata.images?.length) {
        for (const image of metadata.images) if (image.status === "success" && image.content) await saveGenerationResource({ ...base, content: image.content, storageKey: image.storageKey, width: image.naturalWidth, height: image.naturalHeight, bytes: image.bytes, mimeType: image.mimeType }, image.id);
    } else if (node.type === "text" && metadata.texts?.length) {
        for (const text of metadata.texts) if (text.status === "success" && text.content) await saveGenerationResource({ ...base, content: text.content }, text.id);
    } else if (metadata.status === "success" && metadata.content) {
        await saveGenerationResource({ ...base, content: metadata.content, storageKey: metadata.storageKey, width: metadata.naturalWidth, height: metadata.naturalHeight, bytes: metadata.bytes, mimeType: metadata.mimeType, durationMs: metadata.durationMs });
    }
}

export async function collectExistingGenerationResources(projects: CanvasProject[]) {
    for (const project of projects) for (const node of project.nodes) await preserveNodeResources(project, node);
}
