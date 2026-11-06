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
};

const storage = localforage.createInstance({ name: "infinite-canvas", storeName: "generation_resources" });
export const useGenerationResourceStore = create<{ resources: GenerationResource[]; hydrated: boolean }>(() => ({ resources: [], hydrated: false }));
let loading: Promise<void> | undefined;

export function loadGenerationResources() {
    if (!loading) loading = (async () => {
        const resources: GenerationResource[] = [];
        await storage.iterate<GenerationResource, void>((value) => { resources.push(value); });
        useGenerationResourceStore.setState({ resources, hydrated: true });
    })().catch((error) => { loading = undefined; throw error; });
    return loading;
}

// Repeated receipt recovery/backfill must not produce another history item for the same saved result.
export async function saveGenerationResource(resource: Omit<GenerationResource, "id">, itemId = "") {
    await loadGenerationResources();
    const identity = resource.storageKey || JSON.stringify([resource.projectId, resource.nodeId, itemId, resource.content]);
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
    const id = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (useGenerationResourceStore.getState().resources.some((entry) => entry.id === id)) return;
    const entry = { ...resource, id, content: resource.storageKey ? "" : resource.content };
    await storage.setItem(id, entry);
    useGenerationResourceStore.setState((state) => ({ resources: [entry, ...state.resources.filter((value) => value.id !== id)] }));
}

export async function generationResourceKeys() {
    await loadGenerationResources();
    return useGenerationResourceStore.getState().resources.flatMap((entry) => entry.storageKey ? [entry.storageKey] : []);
}
