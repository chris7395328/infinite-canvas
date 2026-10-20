import type { GenerationCostRecord, ModelPrice, ResolutionPrice } from "@/types/generation-cost";

export function normalizePriceResolution(value: string, capability: string): string | undefined {
    const raw = String(value || "").trim().toLowerCase().replace(/\s/g, "").replace("×", "x");
    if (raw === "auto") return "auto";
    if (capability === "video") {
        const aliases: Record<string, string> = { "2k": "1440p", "4k": "2160p", "8k": "4320p" };
        if (aliases[raw]) return aliases[raw];
        if (/^[1-9]\d*p?$/.test(raw)) return `${raw.replace(/p$/, "")}p`;
    }
    if (capability === "image") {
        if (/^[1-9]\d*(?:x[1-9]\d*)?$/.test(raw)) return raw;
        if (/^[1-9]\d*k$/.test(raw)) return raw.toUpperCase();
    }
    return undefined;
}

export function normalizeResolutionPrices(values: ResolutionPrice[] | undefined, capability: string): ResolutionPrice[] {
    if (!["image", "video"].includes(capability) || !Array.isArray(values)) return [];
    const seen = new Set<string>();
    return values.flatMap((entry) => {
        const resolution = normalizePriceResolution(entry?.resolution, capability);
        const price = normalizeModelPrice(entry);
        if (!resolution || !price || seen.has(resolution) || capability === "image" && price.unit !== "request") return [];
        seen.add(resolution);
        return [{ ...price, resolution }];
    });
}

export function resolveResolutionPrice(model: { price?: ModelPrice; resolutionPrices?: ResolutionPrice[]; capability: string }, resolution?: string, size?: string): ModelPrice | undefined {
    const prices = normalizeResolutionPrices(model.resolutionPrices, model.capability);
    const exact = size && prices.find((entry) => entry.resolution === normalizePriceResolution(size, model.capability));
    const selected = exact || prices.find((entry) => entry.resolution === resolution);
    return normalizeModelPrice(selected || model.price);
}

export function normalizeModelPrice(value?: ModelPrice): ModelPrice | undefined {
    if (!value || !["request", "second"].includes(value.unit)) return undefined;
    const amount = String(value.amount).trim();
    if (!/^\d+(\.\d{1,6})?$/.test(amount) || !Number.isSafeInteger(Math.round(Number(amount) * 1e6))) return undefined;
    return { unit: value.unit, amount: String(Number(amount)) };
}

// Keep totals in millionths of a yuan rather than summing floating-point prices.
export function generationCostMicros(record: GenerationCostRecord): number | undefined {
    const price = normalizeModelPrice(record.price);
    if (!price) return undefined;
    const unit = Math.round(Number(price.amount) * 1e6);
    if (price.unit === "request") return unit;
    if (!record.seconds || !Number.isFinite(record.seconds) || record.seconds <= 0) return undefined;
    const total = Math.round(unit * record.seconds);
    return Number.isSafeInteger(total) ? total : undefined;
}

export function formatCost(micros: number) {
    return (micros / 1e6).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

export function filterCostRecords(records: GenerationCostRecord[], start?: number, endExclusive?: number, capability?: GenerationCostRecord["capability"]) {
    return records.filter((record) => {
        const time = Date.parse(record.submittedAt);
        return (!capability || record.capability === capability) && (start === undefined || time >= start) && (endExclusive === undefined || time < endExclusive);
    });
}
