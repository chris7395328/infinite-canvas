// Explicit script opt-in, never infer a third-party protocol from a host or model alias.
export function isSeedance25AssetsScript(script?: string) {
    return /^\s*\/\/\s*@canvas-video-profile\s+seedance-2\.5-assets\s*$/m.test(script || "");
}

export function isSeedanceSeriesScript(script?: string) {
    return /^\s*\/\/\s*@canvas-video-profile\s+seedance-series\s*$/m.test(script || "");
}

export function isSeedanceDraftScript(script?: string) {
    return isSeedance25AssetsScript(script) || isSeedanceSeriesScript(script);
}

// These are this opt-in protocol's documented IDs, not aliases for the generic video route.
export function seedanceSeriesCapabilities(script: string | undefined, model: string) {
    if (!isSeedanceSeriesScript(script)) return undefined;
    const name = model.split("::").at(-1);
    if (!["seedance-2.0", "seedance-2.0-fast", "seedance-2.0-mini", "seedance-2.5"].includes(name || "")) return undefined;
    const v25 = name === "seedance-2.5";
    return { v25, maxSeconds: v25 ? 30 : 15, resolutions: name === "seedance-2.0-fast" || name === "seedance-2.0-mini" ? ["480", "720"] : ["480", "720", "1080"] };
}
