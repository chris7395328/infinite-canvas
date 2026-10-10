import axios, { type AxiosRequestConfig } from "axios";
import localforage from "localforage";
import { normalizeLocalProxyUrl, useConfigStore } from "@/stores/use-config-store";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";
import { flushCanvasStore, useCanvasStore } from "@/stores/canvas/use-canvas-store";

export type BackgroundPlugin = { capability: "audio" | "image" | "text" | "video"; script: string; prompt?: string; images?: string[]; videos?: File[]; audios?: File[]; messages?: unknown[]; params?: Record<string, unknown>; index: number };
export type BackgroundContext = { projectId: string; nodeId: string; itemId?: string; snapshot: () => CanvasNodeData | undefined; connections?: () => CanvasConnection[]; plugin?: BackgroundPlugin; replay?: boolean };
export type BackgroundKind = "gemini-audio" | "openai-audio" | "gemini-image" | "openai-image" | "gemini-text" | "openai-text" | "plugin-audio" | "plugin-image" | "plugin-text" | "plugin-video";
export type BackgroundTask = {
    id: string; key: string; base: string; projectId: string; nodeId: string; itemId?: string;
    kind: BackgroundKind; format?: string; snapshot: CanvasNodeData; connections?: CanvasConnection[]; saved?: CanvasNodeData; released?: boolean; plugin?: BackgroundPlugin;
};
const journal = localforage.createInstance({ name: "infinite-canvas", storeName: "background_tasks" });
export async function backgroundTasks(projectId?: string) {
    const items: BackgroundTask[] = [];
    await journal.iterate<BackgroundTask, void>((item) => { if (!projectId || item.projectId === projectId) items.push(item); });
    return items;
}
export const forgetBackgroundTask = (id: string) => journal.removeItem(id);
const address = (task: BackgroundTask) => `${task.base}/_tasks/${task.id}`;
const taskHeaders = (task: BackgroundTask) => ({ "x-canvas-task-key": task.key });

async function checked(response: Response) {
    if (response.ok) return response;
    const text = await response.text();
    let message = text;
    try { const data = JSON.parse(text); message = typeof data.error === "string" ? data.error : data.error?.message || data.message || text; } catch { /* Preserve the error text. */ }
    throw new Error(message || `后台任务请求失败（${response.status}），未重新生成。`);
}

function sleep(signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        signal?.throwIfAborted();
        const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
        const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, 3000);
        signal?.addEventListener("abort", abort, { once: true });
    });
}

export async function waitBackgroundTask(task: BackgroundTask, signal?: AbortSignal) {
    for (;;) {
        const status = await (await checked(await fetch(address(task), { headers: taskHeaders(task), signal, cache: "no-store" }))).json() as { state: string; error?: string };
        if (status.state === "failed") throw new Error(status.error || "后台任务失败，未自动重新生成。");
        if (status.state === "completed") return checked(await fetch(`${address(task)}/result`, { headers: taskHeaders(task), signal, cache: "no-store" }));
        if (!["uploading", "running"].includes(status.state)) throw new Error("代理未提供有效任务状态，请同时更新 app 和 proxy 容器；未重新生成。");
        await sleep(signal);
    }
}

export async function backgroundFetch(url: string, init: RequestInit, context: BackgroundContext | undefined, kind: BackgroundKind, format?: string) {
    const config = useConfigStore.getState().config;
    if (context?.replay) {
        const receipt = (await backgroundTasks(context.projectId)).find((task) => task.nodeId === context.nodeId && task.itemId === context.itemId && task.plugin?.index === context.plugin?.index);
        if (!receipt) throw new Error("原脚本的这一步尚未提交或凭据已丢失；为避免重复计费，已停止，未发起新的生成请求。");
        return waitBackgroundTask(receipt, init.signal || undefined);
    }
    if (!context || !config.proxyEnabled) return fetch(url, init);
    const base = normalizeLocalProxyUrl(config.proxyUrl);
    if (!base) throw new Error("后台生成需要配置本地代理地址。");
    const absoluteBase = new URL(base, window.location.href).href.replace(/\/$/, "");
    const identity = await (await checked(await fetch(`${absoluteBase}/`, { signal: init.signal, cache: "no-store" }))).json();
    if (identity.memoryTasks !== 1) throw new Error("当前代理不支持内存任务，请同时更新 app 和 proxy 容器。尚未提交生成。");
    const absoluteUrl = new URL(url, window.location.href).href;
    if (!absoluteUrl.startsWith(`${absoluteBase}/`)) throw new Error("后台生成请求必须经过当前配置的本地代理。");
    const path = absoluteUrl.slice(absoluteBase.length + 1);
    const target = path === "seedance/video" ? "/seedance/video" : path;
    if (target !== "/seedance/video" && !/^https?:\/\//i.test(target)) throw new Error("后台生成的上游地址无效。");
    const headers = new Headers(init.headers);
    if (init.body instanceof FormData) headers.delete("content-type");
    const request = new Request(absoluteUrl, { ...init, headers });
    const body = await request.arrayBuffer();
    // Native calls persist only receipts/snapshots. Scripts also keep browser-side inputs, never injected keys/headers.
    await journal.keys();
    const snapshot = context.snapshot();
    if (!snapshot) throw new Error("生成节点尚未保存，未提交后台任务。");
    const task: BackgroundTask = { id: crypto.randomUUID(), key: crypto.randomUUID(), base: absoluteBase, projectId: context.projectId, nodeId: context.nodeId, itemId: context.itemId, kind, format, snapshot, connections: context.connections?.(), plugin: context.plugin };
    await journal.setItem(task.id, task);
    window.dispatchEvent(new CustomEvent("canvas-background-task", { detail: { projectId: context.projectId, nodeId: context.nodeId } }));
    const outgoing = new Headers(request.headers);
    outgoing.set("x-canvas-task-key", task.key);
    outgoing.set("x-canvas-target-url", target);
    // No fallback POST if submission is uncertain: recovery only performs GETs.
    await checked(await fetch(address(task), { method: "POST", headers: outgoing, body, signal: init.signal }));
    return waitBackgroundTask(task, init.signal || undefined);
}

export async function backgroundPost<T>(url: string, body: unknown, options: AxiosRequestConfig, context: BackgroundContext | undefined, kind: BackgroundKind, format?: string): Promise<{ data: T }> {
    if (!context || !useConfigStore.getState().config.proxyEnabled) return axios.post<T>(url, body, options);
    const target = axios.getUri({ url, params: options.params });
    const rawBody = body instanceof FormData || body instanceof Blob || body instanceof ArrayBuffer || body instanceof URLSearchParams || typeof body === "string" ? body : JSON.stringify(body);
    const response = await checked(await backgroundFetch(target, { method: "POST", headers: options.headers as HeadersInit, body: rawBody, signal: options.signal as AbortSignal | undefined }, context, kind, format));
    return { data: (options.responseType === "blob" ? await response.blob() : options.responseType === "arraybuffer" ? await response.arrayBuffer() : options.responseType === "text" ? await response.text() : await response.json()) as T };
}

export async function acknowledgeBackgroundTask(task: BackgroundTask, saved: CanvasNodeData) {
    return serializeTask(task.id, async () => {
        if (discarded.has(task.id)) return;
        // Media and a durable browser receipt must exist before releasing server RAM.
        await journal.setItem(task.id, { ...task, saved });
        const response = await fetch(address(task), { method: "DELETE", headers: taskHeaders(task) });
        if (!response.ok && response.status !== 404) await checked(response);
        await journal.setItem(task.id, { ...task, saved, released: true });
    });
}

export async function acknowledgeSavedBackgroundTasks(projectId: string, nodes: CanvasNodeData[]) {
    for (const task of await backgroundTasks(projectId)) {
        if (acknowledging.has(task.id)) continue;
        const node = nodes.find((item) => item.id === task.nodeId);
        if (!node) continue;
        const item = task.itemId ? (node.metadata?.images?.find((image) => image.id === task.itemId) || node.metadata?.texts?.find((text) => text.id === task.itemId)) : node.metadata;
        if (item?.status !== "success" || !item.content) continue;
        if (!task.kind.endsWith("text") && !("storageKey" in item && item.storageKey)) continue;
        acknowledging.add(task.id);
        try {
            if (!task.released) await acknowledgeBackgroundTask(task, task.saved || node);
            const persisted = useCanvasStore.getState().projects.find((project) => project.id === projectId)?.nodes.find((entry) => entry.id === node.id);
            const persistedItem = task.itemId ? (persisted?.metadata?.images?.find((entry) => entry.id === task.itemId) || persisted?.metadata?.texts?.find((entry) => entry.id === task.itemId)) : persisted?.metadata;
            if (persistedItem?.status === "success" && persistedItem.content) {
                await flushCanvasStore();
                await forgetBackgroundTask(task.id);
            }
        } finally { acknowledging.delete(task.id); }
    }
}

const acknowledging = new Set<string>();
const discarded = new Set<string>();
const taskWrites = new Map<string, Promise<unknown>>();
function serializeTask<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const next = (taskWrites.get(id) || Promise.resolve()).catch(() => undefined).then(operation);
    taskWrites.set(id, next);
    void next.finally(() => { if (taskWrites.get(id) === next) taskWrites.delete(id); }).catch(() => undefined);
    return next;
}

export async function discardBackgroundTasks(projectId: string, nodeIds: Set<string>) {
    for (const task of await backgroundTasks(projectId)) if (nodeIds.has(task.nodeId)) {
        discarded.add(task.id);
        await serializeTask(task.id, async () => {
            await forgetBackgroundTask(task.id);
            await checked(await fetch(address(task), { method: "DELETE", headers: taskHeaders(task) }).then((response) => response.status === 404 ? new Response(null, { status: 204 }) : response));
        });
    }
}
