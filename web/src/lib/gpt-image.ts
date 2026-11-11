export type GptImageSettings = {
    format?: "png" | "jpeg" | "webp" | "gif" | "svg";
    complexity?: "auto" | "low" | "medium" | "high";
    compression?: string;
    frameCount?: string;
    frameDurationMs?: string;
    moderation?: "auto" | "low";
    svgModel?: string;
    svgReasoning?: string;
    markupNodeId?: string;
};

const bare = (model: string) => model.trim().split("::").at(-1) || "";
export const isGptImage26Model = (model = "") => /^gpt-image-2\.6-(sunburst|flare)$/.test(bare(model));
export const supportsGptMarkup = (model = "") => isGptImage26Model(model) || /^gpt-image-2\.5-(sunburst|flare)(?:-2026-09-08)?$/.test(bare(model));
export const gptImageMime = (format: string) => ({ png: "image/png", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml" }[format] || "image/png");
export const imageFileExtension = (mime = "") => ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg" }[mime.split(";")[0]] || "png");

/** Only the documented2.6 models receive new fields; Gemini/other providers keep their own schema. */
export function gptImageRequestFields(model: string, settings: GptImageSettings = {}, options: { edit?: boolean; count?: number; transparent?: boolean } = {}) {
    if (!isGptImage26Model(model)) return { output_format: "png" };
    const count = options.count ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error("GPT Image单次请求数量须为1～10整数。");
    const format = settings.format || "png";
    if (!["png", "jpeg", "webp", "gif", "svg"].includes(format)) throw new Error("不支持的GPT Image输出格式。");
    if (options.transparent && !["png", "webp"].includes(format)) throw new Error("透明背景仅支持PNG或WebP，请更改格式或关闭透明背景。");
    if (format === "svg" && (options.edit || count !== 1)) throw new Error("SVG仅支持纯文字生成且每次1张；不支持参考图或编辑。");
    const result: Record<string, unknown> = { output_format: format };
    if (settings.complexity && settings.complexity !== "auto") {
        if (!["low", "medium", "high"].includes(settings.complexity)) throw new Error("复杂度仅支持低／中／高。");
        result.complexity = settings.complexity;
    }
    if (settings.moderation) result.moderation = settings.moderation === "low" ? "low" : "auto";
    if (["jpeg", "webp"].includes(format) && settings.compression?.trim()) {
        const compression = Number(settings.compression);
        if (!Number.isInteger(compression) || compression < 0 || compression > 100) throw new Error("压缩质量须为0～100整数。");
        result.output_compression = compression;
    }
    if (format === "gif") {
        const frames = Number(settings.frameCount || 9);
        const duration = Number(settings.frameDurationMs || 200);
        if (!Number.isInteger(frames) || frames < 2 || frames > 16) throw new Error("GIF帧数须为2～16整数。");
        if (!Number.isFinite(duration) || duration < 20) throw new Error("GIF每帧间隔至少20毫秒。");
        result.frame_count = frames;
        result.frame_duration_ms = duration;
    }
    if (format === "svg" && settings.svgModel?.trim()) {
        const effort = settings.svgReasoning;
        if (effort && !["auto", "none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(effort)) throw new Error("不支持的SVG创作模型推理档位。");
        result.svg = { model: settings.svgModel.trim(), ...(effort && effort !== "auto" ? { reasoning: { effort } } : {}) };
    }
    return result;
}

export function imagePayloadMime(base64: string, format = "png") {
    if (base64.startsWith("R0lGOD")) return "image/gif";
    if (base64.startsWith("iVBORw0KGgo")) return "image/png";
    if (base64.startsWith("/9j/")) return "image/jpeg";
    if (base64.startsWith("UklGR")) return "image/webp";
    try { if (/<svg[\s>]/i.test(atob(base64.slice(0, 256)))) return "image/svg+xml"; } catch { /* use the response/request's format */ }
    return gptImageMime(format);
}
