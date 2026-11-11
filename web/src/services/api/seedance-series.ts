import { buildApiUrl, resolveModelRequestConfig, resolveModelScript, type AiConfig } from "@/stores/use-config-store";
import { seedanceSeriesCapabilities } from "@/lib/script-video-profile";

export type SeedanceFinalQuote = { quote: string; amount: string; expiresAt: number };

// Quote preparation is not a generation submission and must not create a billing receipt.
export async function estimateSeedanceFinal(config: AiConfig, draftId: string): Promise<SeedanceFinalQuote> {
    if (!seedanceSeriesCapabilities(resolveModelScript(config, config.model), config.model)?.v25 || !draftId) throw new Error("只有此平台2.5样片可获取转正片报价。");
    const channel = resolveModelRequestConfig(config, config.model);
    const response = await fetch(buildApiUrl(channel.baseUrl, `/final-conversions/${encodeURIComponent(draftId)}/estimate`), {
        method: "POST", headers: { Authorization: `Bearer ${channel.apiKey}`, Accept: "application/json", "Content-Type": "application/json" }, body: "{}",
    });
    const raw = await response.text();
    let value;
    try { value = JSON.parse(raw); } catch { value = {}; }
    if (!response.ok || value.error) {
        const detail = typeof value.error === "string" ? value.error : value.error?.message || value.message || (!/^\s*</.test(raw) && raw) || "未取得报价";
        throw new Error(`转正片报价失败（HTTP ${response.status}）：${String(detail).replaceAll(channel.apiKey, "[已隐藏]")}。未创建正片。`);
    }
    if (typeof value.quote !== "string" || !value.quote || !["string", "number"].includes(typeof value.amount) || !String(value.amount).trim() || !Number.isFinite(Number(value.amount)) || Number(value.amount) < 0 || value.currency !== "CNY" || !Number.isFinite(value.expires_at) || value.expires_at * 1000 <= Date.now()) throw new Error("报价缺少有效凭证、人民币金额或已过期；未创建正片，请重新获取。");
    return { quote: value.quote, amount: String(value.amount), expiresAt: value.expires_at };
}
