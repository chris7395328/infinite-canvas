import { afterAll, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";

const nativeCrypto = globalThis.crypto;
const nativeFetch = globalThis.fetch;
const descriptors = new Map(["crypto", "navigator", "indexedDB", "window", "localStorage"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, value });
const httpCrypto = { getRandomValues: nativeCrypto.getRandomValues.bind(nativeCrypto) };
define("crypto", httpCrypto);
define("navigator", {});
define("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
define("window", { localStorage, location: { href: "http://192.0.2.55:3001/", origin: "http://192.0.2.55:3001" }, dispatchEvent: () => true });
const stores = new Map<string, Map<string, any>>();
mock.module("localforage", () => ({ default: { config: () => {}, createInstance: ({ storeName }: { storeName: string }) => {
    const data = stores.get(storeName) || new Map(); stores.set(storeName, data);
    return { keys: async () => [...data.keys()], getItem: async (key: string) => structuredClone(data.get(key) ?? null), setItem: async (key: string, value: unknown) => { data.set(key, structuredClone(value)); }, removeItem: async (key: string) => { data.delete(key); }, iterate: async (callback: (value: any, key: string) => void) => { for (const [key, value] of data) callback(structuredClone(value), key); } };
} } }));
afterAll(() => {
    globalThis.fetch = nativeFetch;
    for (const [key, descriptor] of descriptors) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
});

const { randomUUID, sha256Hex, scriptCrypto } = await import("../src/lib/browser-crypto");
const { readLocalStorageUsage } = await import("../src/services/local-storage-usage");
const { defaultConfig, createModelChannel, useConfigStore } = await import("../src/stores/use-config-store");
const { createGenerationCostSnapshot } = await import("../src/services/generation-cost");
const { backgroundFetch, backgroundTasks } = await import("../src/services/api/background-tasks");
const { saveGenerationResource, removeGenerationResources, useGenerationResourceStore } = await import("../src/stores/use-generation-resource-store");
const { runModelPlugin } = await import("../src/services/api/model-plugin");
const { pastedImages, readClipboardImages } = await import("../src/services/clipboard");
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const proxy = "http://192.0.2.55:3001/canvas-proxy";
const config = { ...defaultConfig, proxyEnabled: true, proxyUrl: proxy, model: "relay::example-video", channels: [createModelChannel({ id: "relay", baseUrl: "https://upstream.example/v1", apiKey: "fixture-key", apiFormat: "openai", models: [{ name: "example-video", capability: "video" }] })] };

test("HTTP UUIDs retain the task-storage format and cryptographic randomness, never Math.random", () => {
    const old = Math.random;
    Math.random = () => { throw new Error("weak random forbidden"); };
    try { const values = Array.from({ length: 100 }, randomUUID); expect(values.every(value => uuidPattern.test(value))).toBe(true); expect(new Set(values).size).toBe(100); }
    finally { Math.random = old; }
    expect((globalThis.crypto as any).randomUUID).toBeUndefined();
    expect(globalThis.crypto.subtle).toBeUndefined();
});

test("HTTP SHA-256 equals native HTTPS SHA-256 for ASCII, Unicode and long values", async () => {
    for (const value of ["", "abc", "中文图片与音频🎵", "video:data:".repeat(20000)]) {
        const native = await nativeCrypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
        expect(await sha256Hex(value)).toBe(Buffer.from(native).toString("hex"));
    }
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("script-local SHA-256 supports byte offsets without changing native globals or pretending to support encryption", async () => {
    const local = scriptCrypto();
    const bytes = new TextEncoder().encode("--abc--").subarray(2, 5);
    expect(Buffer.from(await local.subtle.digest({ name: "sha-256" }, bytes)).toString("hex")).toBe(await sha256Hex("abc"));
    expect(local.randomUUID()).toMatch(uuidPattern);
    await expect(local.subtle.digest("SHA-512", bytes)).rejects.toThrow("仅支持SHA-256");
    expect(globalThis.crypto).toBe(httpCrypto as any);
});

test("saved model scripts can use bare crypto UUID/digest over HTTP without being rewritten", async () => {
    const result = await runModelPlugin<{ id: string; hash: number[] }>({ capability: "video", config, script: 'return {id:crypto.randomUUID(), hash:Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode("abc"))))};' });
    expect(result.id).toMatch(uuidPattern);
    expect(Buffer.from(result.hash).toString("hex")).toBe(await sha256Hex("abc"));
});

test("history IDs and deletion tombstones stay identical to HTTPS, without duplicate or resurrected entries", async () => {
    const identity = "video:fixture-http";
    const expectedId = Buffer.from(await nativeCrypto.subtle.digest("SHA-256", new TextEncoder().encode(identity))).toString("hex");
    const entry = { kind: "video" as const, projectId: "p", projectTitle: "项目", nodeId: "node", title: "结果", prompt: "prompt", model: config.model, createdAt: "2026-11-12T00:00:00Z", storageKey: identity, content: "blob:temporary" };
    await saveGenerationResource(entry); await saveGenerationResource(entry);
    expect(useGenerationResourceStore.getState().resources.map(item => item.id)).toEqual([expectedId]);
    await removeGenerationResources([expectedId]);
    define("crypto", nativeCrypto);
    try { await saveGenerationResource(entry); expect(useGenerationResourceStore.getState().resources).toHaveLength(0); }
    finally { define("crypto", httpCrypto); }
    expect(stores.get("generation_resource_deletions")!.has(expectedId)).toBe(true);
});

test("HTTP billing snapshots and background receipts submit once, save credentials before POST and retrieve by GET", async () => {
    useConfigStore.setState({ config });
    expect(createGenerationCostSnapshot(config, "p", "node").id).toMatch(uuidPattern);
    let posts = 0; const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input); calls.push(`${init?.method || "GET"} ${url}`);
        if (url === proxy + "/") return Response.json({ memoryTasks: 2 });
        const saved = [...stores.get("background_tasks")!.values()][0];
        expect(saved.id).toMatch(uuidPattern); expect(saved.key).toMatch(uuidPattern);
        expect(saved.id).not.toBe(saved.key);
        expect(url.startsWith(`${proxy}/_tasks/${saved.id}`)).toBe(true);
        if (init?.method === "POST") { posts++; expect(new Headers(init.headers).get("x-canvas-task-key")).toBe(saved.key); return Response.json({ state: "running" }); }
        return url.endsWith("/result") ? new Response("fixture-result", { headers: { "content-type": "video/mp4" } }) : Response.json({ state: "completed" });
    }) as typeof fetch;
    const result = await backgroundFetch(`${proxy}/https://upstream.example/v1/videos`, { method: "POST", body: "fixture" }, { projectId: "p", nodeId: "node", snapshot: () => ({ id: "node", type: "video", title: "视频", position: { x: 0, y: 0 }, width: 340, height: 120 }) }, "json-video");
    expect(await result.text()).toBe("fixture-result"); expect(posts).toBe(1);
    expect(calls.filter(value => value.startsWith("GET "))).toHaveLength(3);
    expect(await backgroundTasks("p")).toHaveLength(1);
});

function fixtureDatabase() {
    define("indexedDB", { open: () => {
        const request: any = {};
        queueMicrotask(() => {
            request.result = { version: 1, objectStoreNames: ["fixture"], close: () => {}, transaction: () => ({ objectStore: () => ({ openCursor: () => {
                const cursor: any = {}; const values = ["中文", new Blob(["abc"]), new Uint8Array([1, 2]).buffer]; let index = 0;
                const advance = () => queueMicrotask(() => { cursor.result = index < values.length ? { value: values[index++], continue: advance } : null; cursor.onsuccess(); });
                advance(); return cursor;
            } }) }) };
            request.onsuccess();
        });
        return request;
    } });
}

test("HTTP capacity statistics work without StorageManager and never fabricate a quota", async () => {
    fixtureDatabase(); define("navigator", {});
    const usage = await readLocalStorageUsage();
    expect(usage.contentBytes).toBe(11); expect(usage.databases[0].stores[0].records).toBe(3);
    expect(usage.usage).toBeUndefined(); expect(usage.quota).toBeUndefined();
});

test("denied/failed/invalid estimates do not hide IndexedDB content; valid HTTPS estimates are retained", async () => {
    fixtureDatabase();
    for (const estimate of [() => { throw new Error("denied"); }, async () => { throw new Error("denied"); }, async () => ({ usage: NaN, quota: 0 })]) {
        define("navigator", { storage: { estimate } });
        const usage = await readLocalStorageUsage(); expect(usage.contentBytes).toBe(11); expect(usage.quota).toBeUndefined();
    }
    define("navigator", { storage: { estimate: async () => ({ usage: 80, quota: 1000 }) } });
    expect(await readLocalStorageUsage()).toMatchObject({ usage: 80, quota: 1000, contentBytes: 11 });
});

test("HTTP clipboard buttons show actionable guidance while real paste event files remain readable", async () => {
    define("navigator", {});
    await expect(readClipboardImages()).rejects.toThrow(/Ctrl\+V/);
    const file = new File(["png"], "paste.png", { type: "image/png" });
    expect(pastedImages({ files: [file, new File(["text"], "text.txt", { type: "text/plain" })] } as any)).toEqual([file]);
    expect(pastedImages(null)).toEqual([]);
    define("navigator", { clipboard: { read: async () => [{ types: ["image/png"], getType: async () => file }] } });
    expect(await readClipboardImages()).toEqual([file]);
});

test("canvas leaves native paste enabled outside internal node copies and editors; workbenches bind paste events", () => {
    const canvas = readFileSync(new URL("../src/pages/canvas/project.tsx", import.meta.url), "utf8");
    expect(canvas).toContain('if (pasteCopiedNodes()) event.preventDefault();');
    expect(canvas).toContain('window.addEventListener("paste", pasteSystemClipboard)');
    expect(canvas).toContain("input,textarea,select,[contenteditable='true']");
    for (const page of ["image", "video"]) expect(readFileSync(new URL(`../src/pages/${page}/index.tsx`, import.meta.url), "utf8")).toContain('const files = pastedImages(event.clipboardData);');
});
