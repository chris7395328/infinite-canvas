import { readFileAsDataUrl } from "@/lib/image-utils";
import { normalizeLocalProxyUrl, useConfigStore, type AiConfig, type SeedanceConfig } from "@/stores/use-config-store";

const fields = ["cosBucket", "cosEndpoint", "cosSecretId", "cosSecretKey"] as const;
const complete = (value?: SeedanceConfig) => value?.cosEnabled && fields.every((key) => value[key]?.trim());

export function resolveScriptCos(config: AiConfig, sourceChannelId?: string): SeedanceConfig {
    const saved = useConfigStore.getState().config;
    if (sourceChannelId) {
        const settings = saved.channels.find((channel) => channel.id === sourceChannelId)?.seedance;
        if (!complete(settings)) throw new Error("指定来源渠道未配置完整COS，尚未上传或创建视频。");
        return settings!;
    }
    if (complete(config.seedance)) return config.seedance;
    const unique = new Map<string, SeedanceConfig>();
    for (const settings of [...saved.channels.map((channel) => channel.seedance), saved.seedance]) {
        if (complete(settings)) unique.set(JSON.stringify(fields.map((key) => settings![key].trim())), settings!);
    }
    if (unique.size !== 1) throw new Error(unique.size ? "找到多套COS配置，请在脚本COS_SOURCE_CHANNEL_ID指定来源渠道，或在当前渠道绑定COS；尚未上传或创建视频。" : "未找到完整COS配置，请配置现有新加坡COS，尚未上传或创建视频。");
    return unique.values().next().value!;
}

export function createScriptCosUpload(config: AiConfig, signal?: AbortSignal) {
    return async (file: string | Blob, kind: "image" | "video" | "audio", sourceChannelId?: string) => {
        if (!["image", "video", "audio"].includes(kind)) throw new Error("无效的COS素材类型。");
        const settings = resolveScriptCos(config, sourceChannelId);
        const proxy = normalizeLocalProxyUrl(useConfigStore.getState().config.proxyUrl);
        if (!useConfigStore.getState().config.proxyEnabled || !proxy) throw new Error("素材上传需要启用自己的本地代理。");
        const dataUrl = typeof file === "string" ? file : await readFileAsDataUrl(file);
        if (!dataUrl.startsWith("data:")) throw new Error("COS上传需要画布文件内容，不能把素材ID当作文件上传。");
        // Preparatory upload is not a generation POST, receipt, or billing event.
        const response = await globalThis.fetch(proxy + "/seedance/cos-upload", {
            method: "POST", signal, headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dataUrl, kind, seedance: {
                cosEnabled: settings.cosEnabled, cosBucket: settings.cosBucket, cosEndpoint: settings.cosEndpoint,
                cosSecretId: settings.cosSecretId, cosSecretKey: settings.cosSecretKey, cosPublicBaseUrl: settings.cosPublicBaseUrl, cosObjectPrefix: settings.cosObjectPrefix,
            } }),
        });
        const result = await response.json();
        if (!response.ok || !/^https?:\/\//i.test(result.url || "")) throw new Error(result.error || "COS上传未返回可用公网地址，尚未创建视频。");
        return result.url as string;
    };
}
