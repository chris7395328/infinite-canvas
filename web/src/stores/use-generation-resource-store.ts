import { create } from "zustand";
import localforage from "localforage";

export type GenerationResourceKind = "image" | "video" | "audio" | "text";
export type GenerationResource = {
    id: string;
    kind: GenerationResourceKind;
    projectId: string;
    projectTitle: string;
    nodeId: string;
    title: string;
    prompt: string;
    model: string;
    createdAt: string;
    approximateDate?: boolean;
    storageKey?: string;
    content: string;
    mimeType?: string;
    width?: number;
    height?: number;
    bytes?: number;
    durationMs?: number;
    channel?: string;
    parameters?: Record<string, string | number | boolean>;
    references?: string[];
};

const storage = localforage.createInstance({ name: "infinite-canvas", storeName: "generation_resources" });
const deletions = localforage.createInstance({ name: "infinite-canvas", storeName: "generation_resource_deletions" });
const deleted = new Set<string>();
export const useGenerationResourceStore = create<{ resources: GenerationResource[]; hydrated: boolean }>(() => ({ resources: [], hydrated: false }));
let loading: Promise<void> | undefined;
let mutations: Promise<unknown> = Promise.resolve();
function mutate<T>(action: () => Promise<T>) {
    const next = mutations.catch(() => undefined).then(action);
    mutations = next;
    return next;
}

export function loadGenerationResources() {
    if (!loading) loading = (async () => {
        const resources: GenerationResource[] = [];
        await deletions.iterate<{ id: string }, void>((value) => { deleted.add(value.id); });
        await storage.iterate<GenerationResource, void>((value) => { resources.push(value); });
        useGenerationResourceStore.setState({ resources: resources.filter((entry) => !deleted.has(entry.id)), hydrated: true });
    })().catch((error) => { loading = undefined; throw error; });
    return loading;
}

// Repeated receipt recovery/backfill must not produce another history item for the same saved result.
export async function saveGenerationResource(resource: Omit<GenerationResource, "id">, itemId = "") {
    await loadGenerationResources();
    const identity = resource.storageKey || JSON.stringify([resource.projectId, resource.nodeId, itemId, resource.content]);
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
    const id = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
    await mutate(async () => {
        if (deleted.has(id) || useGenerationResourceStore.getState().resources.some((entry) => entry.id === id)) return;
        const entry = { ...resource, id, content: resource.storageKey ? "" : resource.content };
        await storage.setItem(id, entry);
        useGenerationResourceStore.setState((state) => ({ resources: [entry, ...state.resources.filter((value) => value.id !== id)] }));
    });
}

/** Delete history only. A durable marker prevents project backfill/receipt recovery from resurrecting it. */
export async function removeGenerationResources(ids: Iterable<string>) {
    await loadGenerationResources();
    await mutate(async () => {
        for (const id of new Set(ids)) {
            await deletions.setItem(id, { id });
            deleted.add(id);
            useGenerationResourceStore.setState((state) => ({ resources: state.resources.filter((entry) => entry.id !== id) }));
            await storage.removeItem(id);
        }
    });
}

export async function generationResourceKeys() {
    await loadGenerationResources();
    return useGenerationResourceStore.getState().resources.flatMap((entry) => [...(entry.storageKey ? [entry.storageKey] : []), ...(entry.references || []).filter((value) => /^(image:|video:|audio:)/.test(value))]);
}
