import axios from "axios";
import { withLocalProxy, type AiConfig } from "@/stores/use-config-store";

type MoyuPollResponse = {
    code?: string; message?: string;
    data?: { status?: string; fail_reason?: string; result_url?: string; video_url?: string;
        data?: { content?: { video_url?: string }; video_url?: string; error?: { message?: string } } };
};

// Query-only support for task IDs already saved by older builds. New calls use model scripts.
export async function pollMoyuSeedanceTask(config: AiConfig, id: string, signal?: AbortSignal) {
    const url = withLocalProxy(`${config.baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "")}/v1/video/generations/${encodeURIComponent(id)}`);
    const response = await axios.get<MoyuPollResponse>(url, {
        headers: { Authorization: `Bearer ${config.apiKey}` }, signal,
    });
    const payload = response.data;
    if (payload.code && payload.code !== "success" && payload.code !== "0")
        throw new Error(payload.message || `魔芋查询失败：${payload.code}`);
    const task = payload.data;
    if (!task) throw new Error("魔芋查询任务未返回 data");
    const status = String(task.status || "").toUpperCase();
    if (status === "FAILURE" || status === "FAILED" || status === "CANCELLED")
        return { status: "failed" as const, error: task.data?.error?.message || task.fail_reason || "魔芋视频生成失败" };
    const urlResult = task.data?.content?.video_url || task.data?.video_url || task.video_url || task.result_url;
    if (status === "SUCCESS" && urlResult) return { status: "completed" as const, url: urlResult };
    if (status === "SUCCESS") throw new Error("魔芋任务已成功，但查询响应没有返回视频 URL；请在控制台核对结果");
    return { status: "pending" as const };
}
