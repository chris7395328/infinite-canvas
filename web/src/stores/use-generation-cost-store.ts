import localforage from "localforage";
import { create } from "zustand";
import type { GenerationCostRecord, GenerationCostSnapshot } from "@/types/generation-cost";
import type { ModelChannel } from "@/stores/use-config-store";
import { generationCostMicros, repriceCostRecord } from "@/lib/generation-cost";

const ledger = localforage.createInstance({ name: "infinite-canvas", storeName: "generation_costs" });
let writes: Promise<unknown> = Promise.resolve();

type CostStore = {
    records: GenerationCostRecord[];
    loading: boolean;
    error: string;
    repricing: boolean;
    load: () => Promise<void>;
    write: (snapshot: GenerationCostSnapshot, status: GenerationCostRecord["status"]) => Promise<void>;
    reprice: (channels: ModelChannel[]) => Promise<{ updated: number; skipped: number; unpriced: number }>;
};

export const useGenerationCostStore = create<CostStore>((set, get) => ({
    records: [], loading: false, error: "", repricing: false,
    reprice: (channels) => {
        if (get().repricing) return Promise.reject(new Error("正在重新统计，请稍候。"));
        set({ repricing: true, error: "" });
        // Freeze the confirmed current rates, not credentials/scripts or later UI changes.
        const rates = channels.map((channel) => ({ id: channel.id, models: channel.models.map((model) => ({ name: model.name, capability: model.capability, price: model.price && { ...model.price }, resolutionPrices: model.resolutionPrices?.map((price) => ({ ...price })) })) }));
        const operation = writes.catch(() => undefined).then(async () => {
            const all = new Map(get().records.map((record) => [record.id, record]));
            await ledger.iterate<GenerationCostRecord, void>((record) => { all.set(record.id, record); });
            const summary = { updated: 0, skipped: 0, unpriced: 0 };
            const repricedAt = new Date().toISOString();
            for (const record of all.values()) {
                const next = repriceCostRecord(record, rates, repricedAt);
                if (!next) { summary.skipped++; continue; }
                await ledger.setItem(next.id, next);
                all.set(next.id, next);
                summary.updated++;
                if (next.status !== "cancelled" && generationCostMicros(next) === undefined) summary.unpriced++;
            }
            set({ records: [...all.values()].sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)) });
            return summary;
        });
        writes = operation.catch((reason) => { set({ error: `重新统计未全部完成：${reason instanceof Error ? reason.message : String(reason)}。已保存部分可刷新查看，重新统计不会重复生成或新增费用记录。` }); });
        return operation.finally(() => set({ repricing: false }));
    },
    load: async () => {
        set({ loading: true });
        try {
            await writes;
            const records: GenerationCostRecord[] = [];
            await ledger.iterate<GenerationCostRecord, void>((record) => { records.push(record); });
            const merged = new Map([...get().records, ...records].map((record) => [record.id, record]));
            set({ records: [...merged.values()].sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)) });
        } catch (reason) { set({ error: `读取费用记录失败：${reason instanceof Error ? reason.message : String(reason)}` }); }
        finally { set({ loading: false }); }
    },
    write: (snapshot, status) => {
        const operation = writes.catch(() => undefined).then(async () => {
            const existing = await ledger.getItem<GenerationCostRecord>(snapshot.id) || get().records.find((item) => item.id === snapshot.id);
            // Submission/recovery may run again; never regress a received success or duplicate a request.
            if (existing && (status === "pending" || existing.status === status || existing.status === "success" && status === "cancelled")) return;
            const record: GenerationCostRecord = { ...snapshot, ...existing, status, submittedAt: existing?.submittedAt || snapshot.submittedAt || new Date().toISOString(), ...(status === "success" ? { receivedAt: existing?.receivedAt || new Date().toISOString() } : {}) };
            set((state) => ({ records: [record, ...state.records.filter((item) => item.id !== record.id)] }));
            await ledger.setItem(record.id, record);
        });
        // A bookkeeping failure must not turn a saved generation into a generation failure.
        writes = operation.catch((reason) => { set({ error: `费用记录保存失败：${reason instanceof Error ? reason.message : String(reason)}。生成结果已保留，请勿重新生成。` }); });
        return writes as Promise<void>;
    },
}));
