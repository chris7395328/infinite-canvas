import dayjs from "dayjs";
import type { GenerationResource } from "@/stores/use-generation-resource-store";

export type HistoryFilter = { projectId?: string; kind?: string; from?: string; to?: string };

export function filterGenerationHistory(resources: GenerationResource[], filter: HistoryFilter) {
    return resources.filter((entry) => {
        const date = dayjs(entry.createdAt).format("YYYY-MM-DD");
        return (!filter.projectId || entry.projectId === filter.projectId) && (!filter.kind || filter.kind === "all" || entry.kind === filter.kind) && (!filter.from || date >= filter.from) && (!filter.to || date <= filter.to);
    }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
}

export function groupGenerationHistory(resources: GenerationResource[]) {
    const groups = new Map<string, GenerationResource[]>();
    for (const entry of resources) {
        const date = dayjs(entry.createdAt).format("YYYY-MM-DD");
        groups.set(date, [...(groups.get(date) || []), entry]);
    }
    return [...groups].map(([date, items]) => ({ date, items }));
}

export function historyFileName(resource: GenerationResource, index?: number) {
    const mime = resource.mimeType?.split(";")[0];
    const extension = ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg", "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg", "audio/flac": "flac", "audio/aac": "aac" } as Record<string, string>)[mime || ""] || ({ image: "png", video: "mp4", audio: "mp3", text: "txt" }[resource.kind]);
    const title = resource.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "").slice(0, 80) || "生成素材";
    return `${index === undefined ? "" : String(index + 1).padStart(3, "0") + "-"}${title}.${extension}`;
}
