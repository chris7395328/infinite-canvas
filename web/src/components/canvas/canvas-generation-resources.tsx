import { useEffect, useMemo, useState } from "react";
import { App, DatePicker, Empty, Modal, Pagination, Select, Spin } from "antd";
import type { Dayjs } from "dayjs";
import dayjs from "dayjs";
import { Download, Plus } from "lucide-react";
import { saveAs } from "file-saver";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { loadGenerationResources, useGenerationResourceStore, type GenerationResource } from "@/stores/use-generation-resource-store";
import { collectExistingGenerationResources } from "@/services/generation-resources";
import { preserveNodeResources } from "@/services/generation-resources";
import { backgroundTasks, forgetBackgroundTask, type BackgroundTask } from "@/services/api/background-tasks";
import { recoverBackgroundResult } from "@/services/background-task-recovery";
import { resolveImageUrl, ensureImagePreview, previewUrlFor } from "@/services/image-storage";
import { resolveMediaUrl } from "@/services/file-storage";
import type { InsertAssetPayload } from "./asset-picker-modal";

const labels = { image: "图片", video: "视频", audio: "音频", text: "文字" };
const PAGE_SIZE = 20;

async function resourceUrl(resource: GenerationResource) {
    const url = resource.kind === "image" ? await resolveImageUrl(resource.storageKey, resource.content) : await resolveMediaUrl(resource.storageKey, resource.content);
    if (!url) throw new Error("素材文件缺失，无法预览或插入；未触发重新生成。");
    return url;
}

export function CanvasGenerationResources({ onInsert }: { onInsert: (payload: InsertAssetPayload) => void }) {
    const { message } = App.useApp();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const resources = useGenerationResourceStore((state) => state.resources);
    const projectsReady = useCanvasStore((state) => state.hydrated);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [kind, setKind] = useState("all");
    const [dates, setDates] = useState<[Dayjs | null, Dayjs | null] | null>(null);
    const [page, setPage] = useState(1);
    const [oldTasks, setOldTasks] = useState<BackgroundTask[]>([]);
    const [querying, setQuerying] = useState<string[]>([]);
    const [preview, setPreview] = useState<{ resource: GenerationResource; url: string } | null>(null);
    useEffect(() => {
        if (!projectsReady) return;
        let active = true;
        void loadGenerationResources().then(() => collectExistingGenerationResources(useCanvasStore.getState().projects)).catch((reason) => {
            if (active) setError(reason instanceof Error ? reason.message : "生成资源历史读取失败");
        }).finally(() => { if (active) setLoading(false); });
        void backgroundTasks(undefined, true).then((tasks) => { if (active) setOldTasks(tasks.filter((task) => task.superseded)); }).catch(() => { if (active) setError("旧任务凭据读取失败，请稍后重新打开资源页。"); });
        return () => { active = false; };
    }, [projectsReady]);
    const filtered = useMemo(() => resources.filter((entry) => {
        const time = dayjs(entry.createdAt);
        return (kind === "all" || kind === entry.kind) && (!dates?.[0] || !time.isBefore(dates[0], "day")) && (!dates?.[1] || !time.isAfter(dates[1], "day"));
    }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)), [resources, kind, dates]);
    const currentPage = Math.min(page, Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)));
    const run = (action: () => Promise<void>) => void action().catch((reason) => message.error(reason instanceof Error ? reason.message : "素材操作失败"));
    const insert = async (resource: GenerationResource) => {
        if (resource.kind === "text") onInsert({ kind: "text", content: resource.content, title: resource.title });
        else {
            const url = await resourceUrl(resource);
            if (resource.kind === "image") onInsert({ kind: "image", dataUrl: url, storageKey: resource.storageKey, title: resource.title });
            else onInsert({ kind: resource.kind, url, storageKey: resource.storageKey, title: resource.title, width: resource.width, height: resource.height });
        }
    };
    return <div className="flex h-full flex-col px-3 pb-3">
        <p className="mb-2 text-xs opacity-55">全部画布的生成历史 · 保存在当前浏览器</p>
        <Select size="small" aria-label="素材类别" value={kind} className="mb-2 w-full" onChange={(value) => { setKind(value); setPage(1); }} options={[{ value: "all", label: "全部类别" }, ...Object.entries(labels).map(([value, label]) => ({ value, label }))]} />
        <DatePicker.RangePicker size="small" className="mb-3 w-full" value={dates} onChange={(value) => { setDates(value); setPage(1); }} placeholder={["开始日期", "结束日期"]} allowClear />
        <div className="min-h-0 flex-1 overflow-y-auto">
            {error ? <p role="alert" className="text-sm">{error}</p> : null}
            {oldTasks.length ? <details className="mb-3 text-xs"><summary className="cursor-pointer py-1">待查询的旧任务（{oldTasks.length}）</summary>
                <p className="py-1 opacity-55">仅查询旧请求，结果收录资源页，不覆盖当前节点、不重新生成。</p>
                {oldTasks.map((task) => <button key={task.id} type="button" disabled={querying.includes(task.id)} className="block w-full truncate rounded px-1 py-2 text-left hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/10" onClick={() => run(async () => {
                    setQuerying((current) => [...current, task.id]);
                    try {
                        const saved = await recoverBackgroundResult(task, task.saved || task.snapshot, new AbortController().signal);
                        const project = useCanvasStore.getState().projects.find((entry) => entry.id === task.projectId);
                        await preserveNodeResources(project || { id: task.projectId, title: "原画布", updatedAt: new Date().toISOString() }, saved);
                        await forgetBackgroundTask(task.id);
                        setOldTasks((current) => current.filter((entry) => entry.id !== task.id));
                        message.success("旧结果已收入资源页");
                    } finally { setQuerying((current) => current.filter((id) => id !== task.id)); }
                })}>{querying.includes(task.id) ? "查询中… " : "查询原任务 · "}{task.snapshot.title || task.nodeId}</button>)}
            </details> : null}
            {loading ? <Spin className="my-4 w-full" /> : null}
            {!loading && !filtered.length ? <Empty description="暂无符合条件的生成资源" image={Empty.PRESENTED_IMAGE_SIMPLE} /> : null}
            {filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE).map((resource, index, items) => {
                const date = dayjs(resource.createdAt).format("YYYY-MM-DD");
                const showDate = index === 0 || dayjs(items[index - 1].createdAt).format("YYYY-MM-DD") !== date;
                return <div key={resource.id}>
                    {showDate ? <h3 className="sticky top-0 py-2 text-xs font-semibold" style={{ background: theme.toolbar.panel }}>{date}</h3> : null}
                    <div className="mb-3 overflow-hidden rounded-md border p-2" style={{ borderColor: theme.toolbar.border }}>
                        <button type="button" className="block w-full text-left" title="预览素材" onClick={() => run(async () => setPreview({ resource, url: resource.kind === "text" ? "" : await resourceUrl(resource) }))}>
                            <ResourceThumbnail resource={resource} />
                            <div className="mt-1.5 truncate text-xs font-medium">{resource.title}</div>
                        </button>
                        <div className="mt-1 truncate text-[11px] opacity-55">{labels[resource.kind]} · {resource.projectTitle} · {dayjs(resource.createdAt).format("HH:mm")}{resource.approximateDate ? "（项目日期）" : ""}</div>
                        <div className="mt-1 flex gap-2">
                            <button type="button" className="flex items-center gap-1 rounded px-1 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10" onClick={() => run(() => insert(resource))}><Plus className="size-3" />插入画布</button>
                            <button type="button" className="flex items-center gap-1 rounded px-1 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10" onClick={() => run(async () => {
                                const extension = resource.kind === "text" ? "txt" : resource.mimeType?.split("/")[1]?.split(";")[0] || ({ image: "png", video: "mp4", audio: "mp3", text: "txt" }[resource.kind]);
                                saveAs(resource.kind === "text" ? new Blob([resource.content], { type: "text/plain;charset=utf-8" }) : await resourceUrl(resource), `${resource.title.replace(/[<>:"/\\|?*]/g, "_").slice(0, 80)}.${extension}`);
                            })}><Download className="size-3" />下载</button>
                        </div>
                    </div>
                </div>;
            })}
        </div>
        <Pagination size="small" simple current={currentPage} pageSize={PAGE_SIZE} total={filtered.length} onChange={setPage} className="mt-2" />
        <Modal title={preview?.resource.title || "资源预览"} open={Boolean(preview)} onCancel={() => setPreview(null)} footer={null} destroyOnHidden width={900}>
            {preview?.resource.kind === "image" ? <img src={preview.url} alt={preview.resource.title} className="max-h-[70vh] w-full object-contain" /> : preview?.resource.kind === "video" ? <video src={preview.url} controls className="max-h-[70vh] w-full" /> : preview?.resource.kind === "audio" ? <audio src={preview.url} controls className="w-full" /> : <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap">{preview?.resource.content}</pre>}
            {preview?.resource.prompt ? <p className="mt-3 whitespace-pre-wrap text-xs opacity-60">{preview.resource.prompt}</p> : null}
        </Modal>
    </div>;
}

function ResourceThumbnail({ resource }: { resource: GenerationResource }) {
    const [url, setUrl] = useState("");
    useEffect(() => {
        if (resource.kind !== "image") return;
        let active = true;
        void (async () => {
            if (resource.storageKey) await ensureImagePreview(resource.storageKey);
            const image = previewUrlFor(resource.storageKey) || await resourceUrl(resource);
            if (active) setUrl(image);
        })().catch(() => {});
        return () => { active = false; };
    }, [resource]);
    return url ? <img src={url} loading="lazy" alt={resource.title} className="max-h-36 w-full object-contain" /> : <div className="line-clamp-3 whitespace-pre-wrap text-xs opacity-60">{resource.kind === "text" ? resource.content : `${labels[resource.kind]} · 点击预览`}</div>;
}
