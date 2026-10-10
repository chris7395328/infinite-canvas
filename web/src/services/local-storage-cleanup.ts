import localforage from "localforage";

import { collectMediaStorageKeys, cleanupMediaFiles } from "@/services/file-storage";
import { collectImageStorageKeys, cleanupImageFiles } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { backgroundTasks } from "@/services/api/background-tasks";

const imageLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" });
const videoLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "video_generation_logs" });

export type LocalStorageCleanupResult = {
    files: number;
    historyRecords: number;
    bytes: number;
};

/**
 * Remove generated files which no longer appear in any canvas or My Assets.
 * Generation-log entries referring to those discarded files are removed too,
 * so workbench history never points at a missing local Blob.
 */
export async function cleanupUnreferencedHistoryFiles(): Promise<LocalStorageCleanupResult> {
    const liveData = {
        projects: useCanvasStore.getState().projects,
        assets: useAssetStore.getState().assets,
        background: await backgroundTasks(),
    };
    const imageKeys = collectImageStorageKeys(liveData);
    const mediaKeys = collectMediaStorageKeys(liveData);
    const liveKeys = new Set([...imageKeys, ...mediaKeys]);
    const historyRecords = (await Promise.all([cleanupHistoryStore(imageLogStore, liveKeys), cleanupHistoryStore(videoLogStore, liveKeys)])).reduce((total, count) => total + count, 0);
    const [images, media] = await Promise.all([cleanupImageFiles(imageKeys), cleanupMediaFiles(mediaKeys)]);
    return { files: images.files + media.files, historyRecords, bytes: images.bytes + media.bytes };
}

async function cleanupHistoryStore(store: typeof imageLogStore, liveKeys: Set<string>) {
    const staleIds: string[] = [];
    await store.iterate((value, key) => {
        const keys = new Set<string>();
        collectImageStorageKeys(value, keys);
        collectMediaStorageKeys(value, keys);
        if (Array.from(keys).some((storageKey) => !liveKeys.has(storageKey))) staleIds.push(String(key));
    });
    await Promise.all(staleIds.map((id) => store.removeItem(id)));
    return staleIds.length;
}
