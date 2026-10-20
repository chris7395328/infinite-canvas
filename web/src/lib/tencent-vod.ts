export const TENCENT_VOD_BASE_URL = "https://vod.intl.tencentcloudapi.com";
export const TENCENT_VOD_VERSIONS = ["1.0-pro", "1.0-pro-fast", "1.0-pro-mini", "1.5-pro"];
export type TencentVodConfig = {
    secretId: string;
    secretKey: string;
    subAppId: string;
    groupId: string;
    usePrivateAssets: boolean;
    taskType: "reference" | "auto" | "edit" | "extend";
    seed: string;
    returnLastFrame: boolean;
    enhancePrompt: boolean;
};
export const defaultTencentVodConfig: TencentVodConfig = { secretId: "", secretKey: "", subAppId: "", groupId: "infinite-canvas", usePrivateAssets: true, taskType: "reference", seed: "-1", returnLastFrame: false, enhancePrompt: false };
