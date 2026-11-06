// Explicit script opt-in, never infer a third-party protocol from a host or model alias.
export function isSeedance25AssetsScript(script?: string) {
    return /^\s*\/\/\s*@canvas-video-profile\s+seedance-2\.5-assets\s*$/m.test(script || "");
}
