import { saveAs } from "file-saver";
import { createZip } from "@/lib/zip";
import { historyFileName } from "@/lib/generation-resource-history";
import { getImageBlob, resolveImageUrl } from "./image-storage";
import { getMediaBlob, resolveMediaUrl } from "./file-storage";
import { withLocalProxy } from "@/stores/use-config-store";
import type { GenerationResource } from "@/stores/use-generation-resource-store";
import type { InsertAssetPayload } from "@/components/canvas/asset-picker-modal";

export async function generationResourceUrl(resource: GenerationResource) {
    const url = resource.kind === "image" ? await resolveImageUrl(resource.storageKey, resource.content) : await resolveMediaUrl(resource.storageKey, resource.content);
    if (!url) throw new Error("素材文件缺失，无法预览或添加；未触发重新生成。");
    return url;
}

export async function generationResourceBlob(resource: GenerationResource) {
    if (resource.kind === "text") return new Blob([resource.content], { type: "text/plain;charset=utf-8" });
    if (resource.storageKey) {
        const blob = resource.kind === "image" ? await getImageBlob(resource.storageKey) : await getMediaBlob(resource.storageKey);
        if (!blob) throw new Error(`「${resource.title}」本地文件缺失，未重新生成。`);
        return blob;
    }
    const response = await fetch(withLocalProxy(await generationResourceUrl(resource)));
    if (!response.ok || /json|text\/html/i.test(response.headers.get("content-type") || "")) throw new Error(`「${resource.title}」下载失败（HTTP ${response.status}），未重新生成。`);
    return response.blob();
}

export async function downloadGenerationResources(resources: GenerationResource[]) {
    if (!resources.length) return;
    if (resources.length === 1) return saveAs(await generationResourceBlob(resources[0]), historyFileName(resources[0]));
    const files = [];
    for (let index = 0; index < resources.length; index++) files.push({ name: historyFileName(resources[index], index), data: await generationResourceBlob(resources[index]) });
    saveAs(await createZip(files), "生成历史.zip");
}

export async function generationResourcePayload(resource: GenerationResource, offset?: { x: number; y: number }): Promise<InsertAssetPayload> {
    if (resource.kind === "text") return { kind: "text", title: resource.title, content: resource.content, offset };
    const url = await generationResourceUrl(resource);
    return resource.kind === "image" ? { kind: "image", title: resource.title, dataUrl: url, storageKey: resource.storageKey, offset } : { kind: resource.kind, title: resource.title, url, storageKey: resource.storageKey, width: resource.width, height: resource.height, offset };
}
