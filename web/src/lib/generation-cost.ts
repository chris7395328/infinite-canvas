import type { GenerationCostRecord, ModelPrice } from "@/types/generation-cost";

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

export function filterCostRecords(records: GenerationCostRecord[], start?: number, endExclusive?: number) {
    return records.filter((record) => {
        const time = Date.parse(record.submittedAt);
        return (start === undefined || time >= start) && (endExclusive === undefined || time < endExclusive);
    });
}
