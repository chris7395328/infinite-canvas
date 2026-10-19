import localforage from "localforage";
import { create } from "zustand";
import type { GenerationCostRecord, GenerationCostSnapshot } from "@/types/generation-cost";

const ledger = localforage.createInstance({ name: "infinite-canvas", storeName: "generation_costs" });
let writes: Promise<unknown> = Promise.resolve();

type CostStore = {
    records: GenerationCostRecord[];
    loading: boolean;
    error: string;
    load: () => Promise<void>;
    write: (snapshot: GenerationCostSnapshot, status: GenerationCostRecord["status"]) => Promise<void>;
};

export const useGenerationCostStore = create<CostStore>((set, get) => ({
    records: [], loading: false, error: "",
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
