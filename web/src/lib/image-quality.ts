export type ImageQuality = "auto" | "low" | "medium" | "high" | "xhigh" | "max";

export type ImageQualityOption = {
    value: ImageQuality;
    labelKey: ImageQuality;
};

const DEFAULT_IMAGE_QUALITY_OPTIONS: ImageQualityOption[] = [
    { value: "auto", labelKey: "auto" },
    { value: "high", labelKey: "high" },
    { value: "medium", labelKey: "medium" },
    { value: "low", labelKey: "low" },
];

// https://developers.openai.com/api/docs/guides/image-generation#size-and-quality-options
const GPT_IMAGE_25_QUALITY_OPTIONS: ImageQualityOption[] = [
    { value: "auto", labelKey: "auto" },
    { value: "low", labelKey: "low" },
    { value: "medium", labelKey: "medium" },
    { value: "high", labelKey: "high" },
    { value: "xhigh", labelKey: "xhigh" },
    { value: "max", labelKey: "max" },
];

function bareModelName(model: string | undefined) {
    return (model || "").trim().toLowerCase().split("::").at(-1) || "";
}

/** OpenAI documents the same quality enum for the two GPT Image 2.5 variants. */
export function isGptImage25Model(model: string | undefined) {
    return /^gpt-image-2\.5-(?:flare|sunburst)$/.test(bareModelName(model));
}

export function getImageQualityOptions(model: string | undefined): ImageQualityOption[] {
    return isGptImage25Model(model) ? GPT_IMAGE_25_QUALITY_OPTIONS : DEFAULT_IMAGE_QUALITY_OPTIONS;
}

export function isImageQualitySupported(model: string | undefined, quality: string | undefined) {
    const value = (quality || "").trim().toLowerCase();
    return getImageQualityOptions(model).some((option) => option.value === value);
}

/** GPT Image 2.5 defaults to auto, the safe fallback for stale node metadata. */
export function normalizeImageQualityForModel(model: string | undefined, quality: string | undefined) {
    if (!isGptImage25Model(model)) return (quality || "").trim().toLowerCase();
    return isImageQualitySupported(model, quality) ? (quality || "").trim().toLowerCase() : "auto";
}
