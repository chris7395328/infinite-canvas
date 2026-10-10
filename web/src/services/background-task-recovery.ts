import { acknowledgeBackgroundTask, waitBackgroundTask, type BackgroundTask } from "./api/background-tasks";
import { parseGeminiAudioResponse } from "./api/gemini-audio";
import { assertAudioBlob, audioPluginBlob, storeGeneratedAudio } from "./api/audio";
import { storeGeneratedVideo, videoPluginResult } from "./api/video";
import { getPluginTemplates, getVolcengineSeedanceScript, normalizePluginImages, runModelPlugin } from "./api/model-plugin";
import { resolveModelRequestConfig, useConfigStore } from "@/stores/use-config-store";
import { parseBackgroundText, parseGeminiImagePayload, parseImagePayload } from "./api/image";
import { uploadImage } from "./image-storage";
import { audioMetadata, imageMetadata, videoMetadata } from "@/lib/canvas/canvas-node-factory";
import type { CanvasNodeData, CanvasNodeImage, CanvasNodeText } from "@/types/canvas";

// Merge only this task's slot: parallel image/text tasks must not overwrite each other.
export function applyBackgroundResult(node: CanvasNodeData, task: BackgroundTask, saved: CanvasNodeData): CanvasNodeData {
    if (task.itemId && task.kind.endsWith("image")) {
        const image = saved.metadata?.images?.find((item) => item.id === task.itemId);
        if (!image) return node;
        const images = (node.metadata?.images || task.snapshot.metadata?.images || []).map((item) => item.id === image.id ? image : item);
        const primary = !node.metadata?.primaryImageId || node.metadata.primaryImageId === image.id;
        return { ...node, metadata: { ...node.metadata, ...(primary ? { ...imageMetadata({ url: image.content, storageKey: image.storageKey!, width: image.naturalWidth, height: image.naturalHeight, bytes: image.bytes, mimeType: image.mimeType }), primaryImageId: image.id } : {}), images, status: images.some((item) => item.status === "loading") ? "loading" : "success", errorDetails: undefined } };
    }
    if (task.itemId && task.kind.endsWith("text")) {
        const text = saved.metadata?.texts?.find((item) => item.id === task.itemId);
        if (!text) return node;
        const texts = (node.metadata?.texts || task.snapshot.metadata?.texts || []).map((item) => item.id === text.id ? text : item);
        const primaryId = node.metadata?.primaryTextId || text.id;
        return { ...node, metadata: { ...node.metadata, texts, primaryTextId: primaryId, content: texts.find((item) => item.id === primaryId)?.content || text.content, status: texts.some((item) => item.status === "loading") ? "loading" : "success", errorDetails: undefined } };
    }
    return { ...node, metadata: { ...node.metadata, ...saved.metadata, status: "success", errorDetails: undefined } };
}

export async function recoverBackgroundResult(task: BackgroundTask, node: CanvasNodeData, signal: AbortSignal) {
    if (task.saved) return applyBackgroundResult(node, task, task.saved);
    let pluginResult: unknown;
    if (task.plugin) {
        const plugin = task.plugin;
        const known = plugin.script === getVolcengineSeedanceScript() || getPluginTemplates()[plugin.capability].some((template) => template.script === plugin.script);
        if (!known) throw new Error("自定义脚本的原始响应已暂存，但不能安全地自动重跑任意脚本。需针对该脚本适配结果解析；未重新生成。");
        const config = useConfigStore.getState().config;
        pluginResult = await runModelPlugin({ ...plugin, config: resolveModelRequestConfig(config, task.snapshot.metadata?.model || config.model), signal, background: { projectId: task.projectId, nodeId: task.nodeId, itemId: task.itemId, snapshot: () => node, replay: true } });
    }
    const response = task.plugin ? undefined : await waitBackgroundTask(task, signal);
    let saved: CanvasNodeData;
    if (task.kind.endsWith("audio")) {
        const config = useConfigStore.getState().config;
        const resolved = resolveModelRequestConfig(config, task.snapshot.metadata?.model || config.model);
        let result = task.plugin ? await audioPluginBlob(pluginResult, node.metadata?.audioFormat || "mp3") : task.kind === "gemini-audio" ? await parseGeminiAudioResponse(await response!.json(), task.format || "audio/wav", { signal, baseUrl: resolved.baseUrl, apiKey: resolved.apiKey }) : await response!.blob();
        if (result instanceof Blob) {
            await assertAudioBlob(result);
            if (!result.type.startsWith("audio/")) result = new Blob([result], { type: task.format || "audio/mpeg" });
        }
        const audio = await storeGeneratedAudio(result);
        saved = { ...node, metadata: { ...node.metadata, ...audioMetadata(audio), errorDetails: undefined } };
    } else if (task.kind.endsWith("image")) {
        const payload = task.plugin ? undefined : await response!.json();
        const image = task.plugin ? { id: task.itemId || node.id, dataUrl: normalizePluginImages(pluginResult)[0] } : (task.kind === "gemini-image" ? parseGeminiImagePayload(payload) : parseImagePayload(payload))[0];
        if (!image?.dataUrl) throw new Error("后台结果未包含可识别的图片，未重新生成。");
        const uploaded = await uploadImage(image.dataUrl, { signal });
        const item: CanvasNodeImage = { id: task.itemId || image.id, status: "success", content: uploaded.url, storageKey: uploaded.storageKey, naturalWidth: uploaded.width, naturalHeight: uploaded.height, bytes: uploaded.bytes, mimeType: uploaded.mimeType };
        saved = { ...node, metadata: { ...node.metadata, ...imageMetadata(uploaded), ...(task.itemId ? { images: [item], primaryImageId: item.id } : {}), errorDetails: undefined } };
    } else if (task.kind.endsWith("video")) {
        const result = videoPluginResult(pluginResult);
        const video = await storeGeneratedVideo(result);
        if (!video.storageKey) throw new Error("视频已生成，但文件尚未成功保存到浏览器。后台结果仍保留，未重新生成。");
        saved = { ...node, metadata: { ...node.metadata, ...videoMetadata(video), ...(result.draftTaskId && node.metadata?.seedanceDraft ? { seedanceDraftTaskId: result.draftTaskId } : {}), errorDetails: undefined } };
    } else {
        const content = task.plugin ? String(pluginResult ?? "").trim() : await parseBackgroundText(response!, task.kind);
        if (!content) throw new Error("后台任务未返回文字内容，未重新生成。");
        const text: CanvasNodeText = { id: task.itemId || node.id, content, status: "success" };
        saved = { ...node, metadata: { ...node.metadata, content, status: "success", ...(task.itemId ? { texts: [text], primaryTextId: text.id } : {}), errorDetails: undefined } };
    }
    signal.throwIfAborted();
    await acknowledgeBackgroundTask(task, saved);
    return applyBackgroundResult(node, task, saved);
}
