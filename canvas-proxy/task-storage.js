import { mkdir, readdir, readFile, writeFile, rename, stat, unlink } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { resolve, join } from "node:path";
import { pipeline } from "node:stream/promises";

const validId = /^[a-f0-9-]{36}$/;
const retention = 24 * 60 * 60 * 1000;

/** Only responses and receipt metadata are stored, never request headers/body/API keys. */
export function createTaskStorage(directory) {
    const root = resolve(directory);
    const ready = mkdir(root, { recursive: true, mode: 0o700 });
    const writes = new Map();
    const path = (id, suffix) => {
        if (!validId.test(id)) throw new Error("无效持久化任务ID");
        return join(root, id + suffix);
    };
    const queue = (id, operation) => {
        const next = (writes.get(id) || Promise.resolve()).catch(() => {}).then(operation);
        writes.set(id, next);
        void next.finally(() => { if (writes.get(id) === next) writes.delete(id); }).catch(() => {});
        return next;
    };
    const metadata = task => ({
        version: 1, id: task.id, key: task.key, state: task.state, createdAt: task.createdAt,
        finishedAt: task.finishedAt, status: task.status, contentType: task.contentType,
        upstreamId: task.upstreamId, error: task.error, warning: task.warning,
    });
    async function saveMetadata(value) {
        await ready;
        await writeFile(path(value.id, ".json.part"), JSON.stringify(value), { mode: 0o600 });
        await rename(path(value.id, ".json.part"), path(value.id, ".json"));
    }
    const remove = id => queue(id, async () => {
        await ready;
        for (const suffix of [".json", ".bin", ".payload.part", ".json.part"]) {
            await unlink(path(id, suffix)).catch(error => { if (error.code !== "ENOENT") throw error; });
        }
    });
    return {
        save(task) {
            const value = metadata(task);
            return queue(task.id, () => saveMetadata(value));
        },
        async collect(task, stream) {
            await ready;
            await pipeline(stream, createWriteStream(path(task.id, ".payload.part"), { mode: 0o600 }), { signal: task.controller.signal });
            return (await stat(path(task.id, ".payload.part"))).size;
        },
        async read(task) { return readFile(path(task.id, ".payload.part")); },
        complete(task) {
            const value = { ...metadata(task), state: "completed", finishedAt: Date.now(), warning: undefined };
            return queue(task.id, async () => {
                await rename(path(task.id, ".payload.part"), path(task.id, ".bin"));
                await saveMetadata(value);
                return value.finishedAt;
            });
        },
        async result(task) {
            const info = await stat(path(task.id, ".bin"));
            return { size: info.size, stream: () => createReadStream(path(task.id, ".bin")) };
        },
        remove,
        async load() {
            await ready;
            const items = [];
            const names = await readdir(root);
            for (const name of names.filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
                const id = name.slice(0, -5);
                const value = JSON.parse(await readFile(path(id, ".json"), "utf8"));
                if (value.version !== 1 || value.id !== id || !/^[a-f0-9]{64}$/.test(value.key)) throw new Error("任务存储元数据损坏，拒绝覆盖：" + id);
                if (value.finishedAt && Date.now() - value.finishedAt >= retention) { await remove(id); continue; }
                // A crash after publishing the payload but before publishing metadata
                // must not discard a finished file or reissue its paid request.
                if (value.state !== "completed") {
                    let published;
                    try { published = await stat(path(id, ".bin")); }
                    catch (error) { if (error.code !== "ENOENT") throw error; }
                    if (published) {
                        value.state = "completed";
                        value.status = 200;
                        value.contentType = "application/octet-stream";
                        value.finishedAt = published.mtimeMs;
                        value.error = undefined;
                        await saveMetadata(value);
                    }
                }
                if (value.finishedAt && Date.now() - value.finishedAt >= retention) { await remove(id); continue; }
                if (value.state === "completed") {
                    try { await stat(path(id, ".bin")); }
                    catch { value.state = "failed"; value.error = "持久化结果文件缺失，未重新生成。"; }
                } else if (value.state !== "failed") {
                    value.state = "failed";
                    value.finishedAt = Date.now();
                    value.error = "容器重启时上游请求尚未完成，结果不确定；" + (value.upstreamId ? "已保留原任务ID，请向中转站查询原任务。" : "未收到上游任务ID，请核对中转站记录。") + "未自动重新生成。";
                    await saveMetadata(value);
                }
                // Incomplete payloads cannot be served as a completed file.
                if (value.state !== "completed") await unlink(path(id, ".payload.part")).catch(error => { if (error.code !== "ENOENT") throw error; });
                items.push(value);
            }
            // Remove interrupted atomic-write leftovers which have no authoritative receipt.
            const known = new Set(items.map(item => item.id));
            for (const name of names.filter(name => /^[a-f0-9-]{36}\.(bin|payload\.part|json\.part)$/.test(name))) {
                const id = name.slice(0, 36);
                if (!known.has(id)) await remove(id);
            }
            return items;
        },
    };
}
