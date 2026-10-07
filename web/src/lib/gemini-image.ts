// Official GenerateContent image options, independent of OpenAI quality/size.
// https://ai.google.dev/gemini-api/docs/generate-content/image-generation
const standardRatios = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
export function geminiImageCapabilities(model: string) {
    const name = model.toLowerCase().split("::").pop()!.replace(/^models\//, "");
    if (!/^gemini-/.test(name) || !/(image|nano-banana)/.test(name)) return null;
    const banana21 = name.startsWith("gemini-nano-banana-2.1");
    const lite = name.includes("flash-lite-image");
    const flash31 = name.includes("3.1-flash-image");
    const pro = /gemini-3(?:\.1)?-pro-image/.test(name);
    return {
        supportsSize: banana21 || flash31 || pro || lite,
        sizes: flash31 ? ["512", "1K", "2K", "4K"] : banana21 || pro ? ["1K", "2K", "4K"] : ["1K"],
        ratios: banana21 || flash31 ? [...standardRatios, "1:4", "4:1", "1:8", "8:1"] : standardRatios,
        thinking: banana21 ? ["minimal", "medium", "high"] : flash31 || lite ? ["minimal", "high"] : [],
        defaultThinking: banana21 ? "medium" : "minimal",
    };
}

export type GeminiImageSettings = { geminiImageSize?: string; geminiAspectRatio?: string; geminiThinkingLevel?: string };
export function normalizeGeminiImageSettings(model: string, config: GeminiImageSettings) {
    const capabilities = geminiImageCapabilities(model);
    return {
        geminiImageSize: capabilities?.sizes.includes(config.geminiImageSize || "") ? config.geminiImageSize! : "1K",
        geminiAspectRatio: capabilities?.ratios.includes(config.geminiAspectRatio || "") ? config.geminiAspectRatio! : "auto",
        geminiThinkingLevel: capabilities?.thinking.includes(config.geminiThinkingLevel || "") ? config.geminiThinkingLevel! : "auto",
    };
}

export function geminiImageGenerationConfig(model: string, config: GeminiImageSettings) {
    const capabilities = geminiImageCapabilities(model);
    const settings = normalizeGeminiImageSettings(model, config);
    const legacy = model.toLowerCase().includes("gemini-2.5-flash-image");
    return {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: {
            ...(!legacy && capabilities?.supportsSize ? { imageSize: settings.geminiImageSize } : {}),
            ...(settings.geminiAspectRatio !== "auto" ? { aspectRatio: settings.geminiAspectRatio } : {}),
        },
        ...(capabilities?.thinking.length && settings.geminiThinkingLevel !== "auto" ? { thinkingConfig: { thinkingLevel: settings.geminiThinkingLevel.toUpperCase() } } : {}),
    };
}
