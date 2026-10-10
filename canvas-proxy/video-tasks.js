import { setTimeout as pause } from "node:timers/promises";

const failure = (value) => value?.error?.message || value?.fail_reason || value?.message || "API 返回生成失败";
const unwrap = (value) => value?.data && typeof value.data === "object" && !Array.isArray(value.data) ? value.data : value;
const resultUrl = (value) => value?.content?.video_url || value?.video_url || value?.result_url || value?.url;

/** Poll only an already admitted task. Never resubmit a generation POST. */
export async function resolveVideoTask(protocol, initial, target, headers, task, read) {
    // Keep the existing script profile as an alias, without inspecting model IDs or hosts.
    if (protocol === "xing933") protocol = "json-video";
    let value = unwrap(initial);
    const id = value?.id || value?.task_id || value?.name;
    task.upstreamId = id;
    if (protocol !== "omni" && !id && !resultUrl(value)) throw new Error("API 未返回任务 ID 或视频结果，无法继续查询；未重新生成。");
    const base = new URL(target);
    const authenticated = (url) => new URL(url).origin === base.origin ? headers : {};
    let pollUrl;
    if (protocol === "openai" || protocol === "moyu") pollUrl = `${target.href.replace(/\/$/, "")}/${encodeURIComponent(id)}`;
    if (protocol === "json-video") pollUrl = `${target.href.replace(/\/videos\/generations\/?$/, "/videos")}/${encodeURIComponent(id)}`;
    if (protocol === "gemini") pollUrl = new URL(`../${String(id).replace(/^\//, "")}`, new URL("./", target)).href;
    for (;;) {
        task.controller.signal.throwIfAborted();
        const status = String(value?.status || value?.stage || "").toLowerCase();
        if (value?.error || value?.data?.error || ["failed", "failure", "cancelled", "canceled", "error", "incomplete", "expired"].includes(status)) throw new Error(`API 返回生成失败：${failure(value?.data?.error ? value.data : value)}`);
        if (protocol === "omni") {
            const output = value?.output_video || value?.steps?.filter((step) => step.type === "model_output").flatMap((step) => step.content || []).find((block) => block.type === "video");
            if (output?.data) return { data: output.data, mime: output.mime_type || "video/mp4" };
            if (!output?.uri) throw new Error("Omni 同步响应未返回视频，未重新提交。");
            const uri = new URL(output.uri);
            const fileId = uri.pathname.match(/\/files\/([^/:?]+)/)?.[1];
            if (uri.hostname !== "generativelanguage.googleapis.com" || !fileId || uri.origin !== base.origin) throw new Error("Omni 返回了无法识别的 Google Files URI。");
            const root = target.href.replace(/\/interactions(?:\?.*)?$/, "");
            const fileUrl = `${root}/files/${fileId}`;
            for (;;) {
                await pause(task.retryAfter || 10000, undefined, { signal: task.controller.signal });
                try {
                    const file = await read(fileUrl, headers);
                    if (file.state === "FAILED") throw new Error("API 返回文件处理失败：Google Files FAILED");
                    if (file.state === "ACTIVE") return { url: `${fileUrl}:download?alt=media`, headers, mime: output.mime_type || "video/mp4" };
                    task.warning = undefined;
                } catch (error) {
                    if (task.controller.signal.aborted || /内存预算|API 返回文件处理失败/.test(error.message)) throw error;
                    task.warning = "文件查询连接异常，后台继续查询原任务，未重新生成。";
                }
            }
        }
        const url = resultUrl(value) || resultUrl(value?.data) || value?.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
        if (url && (protocol !== "json-video" || ["completed", "succeeded", "success", "done", "finished"].includes(status))) return { url, headers: authenticated(url) };
        if (protocol === "openai" && ["completed", "succeeded", "success"].includes(status)) return { url: `${pollUrl}/content`, headers };
        if ((protocol === "gemini" && value?.done) || (protocol === "moyu" && status === "success")) throw new Error("API 返回成功但没有视频地址；未重新生成，请核对上游任务。");
        if (!pollUrl) throw new Error("无法确定原任务查询地址，未重新生成。");
        await pause(task.retryAfter || 10000, undefined, { signal: task.controller.signal });
        try {
            value = unwrap(await read(pollUrl, headers));
            task.warning = undefined;
        } catch (error) {
            if (task.controller.signal.aborted || /内存预算/.test(error.message)) throw error;
            task.warning = "任务查询连接异常，后台继续查询原任务，未重新生成。";
        }
    }
}
