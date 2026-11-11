import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { App, Checkbox, DatePicker, Empty, Modal, Pagination, Spin } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { ChevronLeft, ChevronRight, Clock3, Copy, Download, FileText, Image as ImageIcon, Music2, Plus, Trash2, Video, X } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useCopyText } from "@/hooks/use-copy-text";
import { filterGenerationHistory, groupGenerationHistory } from "@/lib/generation-resource-history";
import { useThemeStore } from "@/stores/use-theme-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { loadGenerationResources, removeGenerationResources, useGenerationResourceStore, type GenerationResource } from "@/stores/use-generation-resource-store";
import { collectExistingGenerationResources, preserveNodeResources } from "@/services/generation-resources";
import { downloadGenerationResources, generationResourcePayload, generationResourceUrl } from "@/services/generation-resource-files";
import { backgroundTasks, forgetBackgroundTask, type BackgroundTask } from "@/services/api/background-tasks";
import { recoverBackgroundResult } from "@/services/background-task-recovery";
import { ensureImagePreview, previewUrlFor, resolveImageUrl } from "@/services/image-storage";
import { resolveMediaUrl } from "@/services/file-storage";
import type { InsertAssetPayload } from "./asset-picker-modal";

const labels = { image: "图片", video: "视频", audio: "音频", text: "文字" };
const icons = { image: ImageIcon, video: Video, audio: Music2, text: FileText };
const PAGE_SIZE = 48;
const flatButton = "inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm transition hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-white/10";

export function CanvasGenerationHistoryModal({ open, onClose, onInsert }: { open: boolean; onClose: () => void; onInsert: (payload: InsertAssetPayload) => void | Promise<void> }) {
    const { id: projectId } = useParams();
    const { message, modal } = App.useApp();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const resources = useGenerationResourceStore((state) => state.resources);
    const projectsReady = useCanvasStore((state) => state.hydrated);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [scope, setScope] = useState("project");
    const [kind, setKind] = useState("all");
    const [dates, setDates] = useState<[Dayjs | null, Dayjs | null] | null>(null);
    const [page, setPage] = useState(1);
    const [selected, setSelected] = useState(new Set<string>());
    const [detailId, setDetailId] = useState<string | null>(null);
    const [busy, setBusy] = useState("");
    const operation = useRef(false);
    const [oldTasks, setOldTasks] = useState<BackgroundTask[]>([]);
    const querying = useRef(new Map<string, AbortController>());
    const [queryingIds, setQueryingIds] = useState<string[]>([]);

    useEffect(() => {
        if (!open || !projectsReady) return;
        let active = true;
        setLoading(true);
        setError("");
        void loadGenerationResources().then(() => collectExistingGenerationResources(useCanvasStore.getState().projects)).catch((reason) => {
            if (active) setError(reason instanceof Error ? reason.message : "生成历史读取失败");
        }).finally(() => { if (active) setLoading(false); });
        void backgroundTasks(undefined, true).then((tasks) => { if (active) setOldTasks(tasks.filter((task) => task.superseded)); }).catch(() => { if (active) setError("旧任务凭据读取失败，请重新打开历史。"); });
        return () => {
            active = false;
            querying.current.forEach((controller) => controller.abort());
            querying.current.clear();
        };
    }, [open, projectsReady]);
    useEffect(() => { setPage(1); setSelected(new Set()); }, [scope, kind, dates, projectId]);
    useEffect(() => { if (!open) { setDetailId(null); setSelected(new Set()); setQueryingIds([]); } }, [open]);

    const scoped = useMemo(() => filterGenerationHistory(resources, { projectId: scope === "project" ? projectId : undefined, from: dates?.[0]?.format("YYYY-MM-DD"), to: dates?.[1]?.format("YYYY-MM-DD") }), [resources, scope, projectId, dates]);
    const filtered = useMemo(() => scoped.filter((entry) => kind === "all" || kind === entry.kind), [scoped, kind]);
    const selectedItems = filtered.filter((entry) => selected.has(entry.id));
    const currentPage = Math.min(page, Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)));
    const groups = groupGenerationHistory(filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE));
    const detail = resources.find((entry) => entry.id === detailId);
    const detailIndex = filtered.findIndex((entry) => entry.id === detailId);
    const visibleOldTasks = oldTasks.filter((task) => scope === "all" || task.projectId === projectId);
    const toggle = (ids: string[], checked: boolean) => setSelected((current) => {
        const next = new Set(current);
        ids.forEach((id) => checked ? next.add(id) : next.delete(id));
        return next;
    });
    const execute = async (name: string, action: () => Promise<void>) => {
        if (operation.current) return;
        operation.current = true;
        setBusy(name);
        try { await action(); }
        catch (reason) { message.error(reason instanceof Error ? reason.message : "素材操作失败"); throw reason; }
        finally { operation.current = false; setBusy(""); }
    };
    const perform = (name: string, action: () => Promise<void>) => { void execute(name, action).catch(() => {}); };
    const insert = (items: GenerationResource[]) => perform("insert", async () => {
        // Preflight every selected file before changing the canvas. No API generation calls are made.
        const payloads: InsertAssetPayload[] = [];
        for (let index = 0; index < items.length; index++) payloads.push(await generationResourcePayload(items[index], { x: (index % 3) * 720, y: Math.floor(index / 3) * 720 }));
        let added = 0;
        try { for (const payload of payloads) { await onInsert(payload); added++; } }
        catch (reason) { throw new Error(`已添加${added}项，其余未完成：${reason instanceof Error ? reason.message : String(reason)}`); }
        message.success(`已添加${added}项到当前画布`);
    });
    const download = (items: GenerationResource[]) => perform("download", async () => { await downloadGenerationResources(items); });
    const remove = (items: GenerationResource[]) => {
        if (!items.length) return;
        modal.confirm({
            zIndex: 1300,
            title: `删除${items.length}条生成历史？`, content: "只删除历史记录，不删除画布节点、仍在使用的素材，也不取消上游任务。删除后不会因项目扫描再次出现。",
            okText: "删除历史", cancelText: "取消", okButtonProps: { danger: true },
            onOk: () => execute("delete", async () => {
                await removeGenerationResources(items.map((entry) => entry.id));
                toggle(items.map((entry) => entry.id), false);
                if (items.some((entry) => entry.id === detailId)) setDetailId(null);
                message.success("已删除历史记录，画布素材未改动");
            }),
        });
    };
    const queryOldTask = async (task: BackgroundTask) => {
        if (querying.current.has(task.id)) return;
        const controller = new AbortController();
        querying.current.set(task.id, controller);
        setQueryingIds([...querying.current.keys()]);
        try {
            const saved = await recoverBackgroundResult(task, task.saved || task.snapshot, controller.signal);
            const project = useCanvasStore.getState().projects.find((entry) => entry.id === task.projectId);
            await preserveNodeResources(project || { id: task.projectId, title: "原画布", updatedAt: new Date().toISOString() }, saved);
            await forgetBackgroundTask(task.id);
            setOldTasks((current) => current.filter((entry) => entry.id !== task.id));
            message.success("旧结果已收入生成历史，未覆盖当前节点");
        } catch (reason) {
            if (!controller.signal.aborted) message.error(reason instanceof Error ? reason.message : "原任务查询失败");
        } finally { querying.current.delete(task.id); setQueryingIds([...querying.current.keys()]); }
    };

    return <>
        <Modal open={open} onCancel={onClose} title={null} footer={null} closable={false} centered destroyOnHidden width="min(1540px, calc(100vw - 40px))" styles={{ container: { padding: 0, borderRadius: 22, overflow: "hidden", background: theme.node.panel, color: theme.node.text }, body: { padding: 0 } }}>
            <div className="flex min-h-0" style={{ height: "min(86dvh, 980px)" }} data-canvas-no-zoom>
                <aside className="hidden w-48 shrink-0 flex-col border-r px-3 py-6 md:flex" style={{ borderColor: theme.toolbar.border }}>
                    <h2 className="mb-6 px-3 text-base font-semibold">资源库</h2>
                    <div className="flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium" style={{ background: theme.toolbar.activeBg }}><Clock3 className="size-5" />生成历史</div>
                    <p className="mt-4 px-3 text-xs leading-6 opacity-45">当前浏览器的生成素材<br />不受后台24小时暂存清理影响</p>
                    {visibleOldTasks.length ? <details className="mt-auto overflow-auto px-2 pt-6 text-xs"><summary className="cursor-pointer">未领取旧任务 · {visibleOldTasks.length}</summary>
                        <p className="py-2 leading-5 opacity-50">只查询旧请求，不重新生成、不覆盖当前节点。</p>
                        {visibleOldTasks.map((task) => <button key={task.id} type="button" disabled={queryingIds.includes(task.id)} className={flatButton + " w-full truncate !justify-start !px-1 !text-xs"} onClick={() => void queryOldTask(task)}>{queryingIds.includes(task.id) ? "查询中…" : "查询 · "}{task.snapshot.title || task.nodeId}</button>)}
                    </details> : null}
                </aside>
                <section className="flex min-w-0 flex-1 flex-col">
                    <header className="shrink-0 px-5 pb-4 pt-5 sm:px-7">
                        <div className="flex items-center gap-5">
                            <h2 className="mr-2 font-semibold md:hidden">生成历史</h2>
                            {[{ value: "project", label: "本项目" }, { value: "all", label: "全部项目" }].map((entry) => <button key={entry.value} type="button" aria-pressed={scope === entry.value} onClick={() => setScope(entry.value)} className="py-2 text-sm font-medium transition-opacity" style={{ opacity: scope === entry.value ? 1 : 0.45 }}>{entry.label}</button>)}
                            <button type="button" className={flatButton + " ml-auto !p-2"} aria-label="关闭生成历史" onClick={onClose}><X className="size-5" /></button>
                        </div>
                        <div className="mt-4 flex flex-wrap items-center gap-2">
                            {[{ value: "all", label: "全部" }, ...Object.entries(labels).map(([value, label]) => ({ value, label }))].map((entry) => <button key={entry.value} type="button" className={flatButton + " !gap-1.5 !rounded-full !px-3 !py-1.5"} aria-pressed={kind === entry.value} style={{ background: kind === entry.value ? theme.toolbar.activeBg : undefined, opacity: kind === entry.value ? 1 : 0.6 }} onClick={() => setKind(entry.value)}>{entry.label}<span className="text-xs opacity-50">{entry.value === "all" ? scoped.length : scoped.filter((item) => item.kind === entry.value).length}</span></button>)}
                            <DatePicker.RangePicker size="small" className="w-full sm:ml-auto sm:w-60" value={dates} onChange={setDates} placeholder={["开始日期", "结束日期"]} allowClear />
                        </div>
                    </header>
                    <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 sm:px-7">
                        {error ? <p role="alert" className="pb-3 text-sm">{error}</p> : null}
                        {loading ? <div className="py-8 text-center"><Spin /></div> : null}
                        {!loading && !filtered.length ? <Empty description="暂无符合条件的生成历史" image={Empty.PRESENTED_IMAGE_SIMPLE} /> : null}
                        {groups.map(({ date, items }) => {
                            const dayItems = filtered.filter((entry) => dayjs(entry.createdAt).format("YYYY-MM-DD") === date);
                            const checked = dayItems.filter((entry) => selected.has(entry.id)).length;
                            return <section key={date} className="mb-7">
                                <div className="mb-3 flex items-center gap-3 py-1 text-sm opacity-65"><h3>{date}</h3><Checkbox aria-label={`选择${date}的全部素材`} checked={checked === dayItems.length} indeterminate={checked > 0 && checked < dayItems.length} onChange={(event) => toggle(dayItems.map((entry) => entry.id), event.target.checked)} /><span className="text-xs opacity-50">{dayItems.length}项</span></div>
                                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
                                    {items.map((resource) => <HistoryCard key={resource.id} resource={resource} selected={selected.has(resource.id)} disabled={Boolean(busy)} onSelect={(checked) => toggle([resource.id], checked)} onPreview={() => setDetailId(resource.id)} onInsert={() => insert([resource])} onDownload={() => download([resource])} onRemove={() => remove([resource])} />)}
                                </div>
                            </section>;
                        })}
                    </div>
                    {selectedItems.length ? <div className="flex shrink-0 flex-wrap items-center gap-2 border-t px-5 py-3 sm:px-7" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }}>
                        <div className="mr-auto flex min-w-0 items-center gap-2"><div className="hidden -space-x-2 sm:flex">{selectedItems.slice(0, 4).map((resource) => <div key={resource.id} className="size-10 overflow-hidden rounded-lg border" style={{ borderColor: theme.toolbar.border }}><HistoryMedia resource={resource} active={false} /></div>)}</div><span className="whitespace-nowrap text-sm">已选 {selectedItems.length} 项</span></div>
                        <button type="button" className={flatButton} disabled={Boolean(busy)} onClick={() => setSelected(new Set())}>取消</button>
                        <button type="button" className={flatButton} disabled={Boolean(busy)} onClick={() => toggle(filtered.map((entry) => entry.id), selectedItems.length !== filtered.length)}>{selectedItems.length === filtered.length ? "取消全选" : "全选筛选结果"}</button>
                        <button type="button" className={flatButton + " text-red-500"} disabled={Boolean(busy)} onClick={() => remove(selectedItems)}><Trash2 className="size-4" />删除历史</button>
                        <button type="button" className={flatButton} disabled={Boolean(busy)} onClick={() => download(selectedItems)}><Download className="size-4" />{busy === "download" ? "打包中…" : "下载"}</button>
                        <button type="button" className={flatButton} disabled={Boolean(busy)} onClick={() => insert(selectedItems)}><Plus className="size-4" />{busy === "insert" ? "添加中…" : "添加到当前画布"}</button>
                    </div> : null}
                    {filtered.length > PAGE_SIZE ? <div className="flex justify-end border-t px-6 py-3" style={{ borderColor: theme.toolbar.border }}><Pagination size="small" current={currentPage} pageSize={PAGE_SIZE} total={filtered.length} onChange={setPage} showSizeChanger={false} /></div> : null}
                </section>
            </div>
        </Modal>
        <HistoryDetail resource={open ? detail : undefined} busy={Boolean(busy)} onClose={() => setDetailId(null)} onPrevious={detailIndex > 0 ? () => setDetailId(filtered[detailIndex - 1].id) : undefined} onNext={detailIndex >= 0 && detailIndex < filtered.length - 1 ? () => setDetailId(filtered[detailIndex + 1].id) : undefined} onInsert={() => detail && insert([detail])} onDownload={() => detail && download([detail])} onRemove={() => detail && remove([detail])} />
    </>;
}

function HistoryCard({ resource, selected, disabled, onSelect, onPreview, onInsert, onDownload, onRemove }: { resource: GenerationResource; selected: boolean; disabled: boolean; onSelect: (checked: boolean) => void; onPreview: () => void; onInsert: () => void; onDownload: () => void; onRemove: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [hovered, setHovered] = useState(false);
    return <div className="group relative aspect-square overflow-hidden rounded-2xl border-2" style={{ borderColor: selected ? theme.node.activeStroke : "transparent", background: theme.canvas.background }} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
        <button type="button" className="absolute inset-0 size-full text-left focus-visible:outline focus-visible:outline-2" aria-label={`查看${labels[resource.kind]}详情：${resource.title}`} onClick={() => { setHovered(false); onPreview(); }}><HistoryMedia resource={resource} active={hovered} /><span className="sr-only">{resource.title}</span></button>
        <div className="absolute left-2 top-2 z-10 rounded-md bg-black/45 p-1"><Checkbox checked={selected} disabled={disabled} onChange={(event) => onSelect(event.target.checked)} aria-label={`选择${resource.title}`} /></div>
        <span className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/65 px-1.5 py-0.5 text-[10px] text-white transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">{resource.durationMs ? `${(resource.durationMs / 1000).toFixed(1)}s` : labels[resource.kind]}</span>
        <div className="pointer-events-none absolute inset-x-2 bottom-2 flex justify-center gap-1 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
            {[{ label: "添加到当前画布", Icon: Plus, action: onInsert }, { label: "下载", Icon: Download, action: onDownload }, { label: "删除历史", Icon: Trash2, action: onRemove }].map(({ label, Icon, action }) => <button key={label} type="button" title={label} aria-label={label} disabled={disabled} onClick={action} className="flex h-9 min-w-0 flex-1 items-center justify-center rounded-lg bg-black/75 text-white backdrop-blur-sm transition hover:bg-black/90 disabled:opacity-40"><Icon className={label === "删除历史" ? "size-4 text-red-400" : "size-4"} /></button>)}
        </div>
    </div>;
}

function HistoryMedia({ resource, active }: { resource: GenerationResource; active: boolean }) {
    const host = useRef<HTMLDivElement>(null);
    const video = useRef<HTMLVideoElement>(null);
    const [visible, setVisible] = useState(false);
    const [url, setUrl] = useState("");
    const [failed, setFailed] = useState(false);
    const Icon = icons[resource.kind];
    useEffect(() => {
        const element = host.current;
        if (!element) return;
        const observer = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) { setVisible(true); observer.disconnect(); } });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);
    useEffect(() => {
        if (!visible || resource.kind === "text" || resource.kind === "audio") return;
        let alive = true;
        void (async () => {
            if (resource.kind === "image" && resource.storageKey) await ensureImagePreview(resource.storageKey);
            const value = resource.kind === "image" && resource.mimeType !== "image/gif" && previewUrlFor(resource.storageKey) || await generationResourceUrl(resource);
            if (alive) setUrl(value);
        })().catch(() => { if (alive) setFailed(true); });
        return () => { alive = false; };
    }, [visible, resource]);
    useEffect(() => {
        const element = video.current;
        if (!element) return;
        if (active) void element.play().catch(() => {});
        else { element.pause(); if (element.readyState >= 1) { try { element.currentTime = 0; } catch { /* Non-seekable media can still be downloaded. */ } } }
        return () => element.pause();
    }, [active, url]);
    return <div ref={host} className="flex size-full items-center justify-center overflow-hidden">
        {url && !failed ? resource.kind === "video" ? <video ref={video} src={url} muted loop playsInline preload="metadata" onError={() => setFailed(true)} className="size-full object-cover" /> : <img src={url} alt={resource.title} loading="lazy" onError={() => setFailed(true)} className="size-full object-cover" /> : resource.kind === "text" ? <p className="line-clamp-6 p-4 text-xs leading-6 opacity-70">{resource.content}</p> : <div className="flex flex-col items-center gap-2 px-3 text-center opacity-50"><Icon className="size-8" /><span className="line-clamp-2 text-xs">{failed ? "预览不可用，点击查看详情" : resource.kind === "audio" ? resource.title : "正在载入"}</span></div>}
    </div>;
}

function HistoryDetail({ resource, busy, onClose, onPrevious, onNext, onInsert, onDownload, onRemove }: { resource?: GenerationResource; busy: boolean; onClose: () => void; onPrevious?: () => void; onNext?: () => void; onInsert: () => void; onDownload: () => void; onRemove: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const copyText = useCopyText();
    const [url, setUrl] = useState("");
    const [error, setError] = useState("");
    useEffect(() => {
        setUrl(""); setError("");
        if (!resource || resource.kind === "text") return;
        let alive = true;
        void generationResourceUrl(resource).then((value) => { if (alive) setUrl(value); }).catch((reason) => { if (alive) setError(reason instanceof Error ? reason.message : "素材读取失败"); });
        return () => { alive = false; };
    }, [resource]);
    return <Modal open={Boolean(resource)} onCancel={onClose} title={null} footer={null} closable={false} centered destroyOnHidden zIndex={1100} width="min(1680px, calc(100vw - 32px))" styles={{ container: { padding: 0, borderRadius: 22, overflow: "hidden", background: theme.node.panel, color: theme.node.text }, body: { padding: 0 } }}>
        {resource ? <div className="flex flex-col overflow-auto md:flex-row" style={{ height: "min(90dvh, 1040px)" }} data-canvas-no-zoom>
            <div className="relative flex min-h-64 min-w-0 flex-1 items-center justify-center overflow-hidden p-3" style={{ background: theme.canvas.background }}>
                {error ? <p role="alert" className="p-6 text-sm">{error}</p> : resource.kind === "text" ? <pre className="max-h-full w-full overflow-auto whitespace-pre-wrap p-6 text-sm leading-7">{resource.content}</pre> : !url ? <Spin /> : resource.kind === "image" ? <img src={url} alt={resource.title} className="max-h-full w-full object-contain" /> : resource.kind === "video" ? <video key={resource.id} src={url} controls playsInline className="max-h-full w-full" onError={() => setError("视频无法在此浏览器预览，可尝试下载原文件；未重新生成。")} /> : <div className="w-full max-w-lg px-5"><Music2 className="mx-auto mb-8 size-16 opacity-40" /><audio key={resource.id} src={url} controls className="w-full" onError={() => setError("音频预览失败，可尝试下载原文件。")} /></div>}
                {[{ label: "上一条", action: onPrevious, Icon: ChevronLeft, position: "left-3" }, { label: "下一条", action: onNext, Icon: ChevronRight, position: "right-3" }].map(({ label, action, Icon, position }) => <button key={label} type="button" disabled={!action} aria-label={label} onClick={action} className={`absolute top-1/2 ${position} -translate-y-1/2 rounded-full bg-black/50 p-2 text-white backdrop-blur disabled:invisible`}><Icon className="size-5" /></button>)}
            </div>
            <aside className="flex shrink-0 flex-col border-t p-6 md:w-[350px] md:border-l md:border-t-0 lg:w-[390px]" style={{ borderColor: theme.toolbar.border }}>
                <div className="mb-6 flex items-center justify-between"><h2 className="text-lg font-semibold">{labels[resource.kind]}详情</h2><button type="button" className={flatButton + " !p-1"} aria-label="关闭素材详情" onClick={onClose}><X className="size-5" /></button></div>
                <div className="min-h-0 flex-1 overflow-y-auto text-sm">
                    <h3 className="mb-5 break-words font-medium">{resource.title}</h3>
                    <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-3 text-xs leading-5">
                        <dt className="opacity-45">所属项目</dt><dd className="break-words text-right">{resource.projectTitle}</dd>
                        <dt className="opacity-45">创建于</dt><dd className="text-right">{dayjs(resource.createdAt).format("YYYY-MM-DD HH:mm:ss")}{resource.approximateDate ? <span className="block opacity-45">旧记录，使用项目日期</span> : null}</dd>
                        <dt className="opacity-45">模型</dt><dd className="break-all text-right">{resource.model}</dd>
                        {resource.channel ? <><dt className="opacity-45">渠道</dt><dd className="text-right">{resource.channel}</dd></> : null}
                        {resource.width && resource.height ? <><dt className="opacity-45">尺寸</dt><dd className="text-right">{resource.width} × {resource.height}</dd></> : null}
                        {resource.durationMs ? <><dt className="opacity-45">素材时长</dt><dd className="text-right">{(resource.durationMs / 1000).toFixed(2)} 秒</dd></> : null}
                        {resource.bytes ? <><dt className="opacity-45">文件大小</dt><dd className="text-right">{(resource.bytes / 1024 / 1024).toFixed(2)} MiB</dd></> : null}
                        {resource.mimeType ? <><dt className="opacity-45">格式</dt><dd className="break-all text-right">{resource.mimeType}</dd></> : null}
                    </dl>
                    <div className="mb-3 mt-7 flex items-center justify-between"><h3 className="opacity-50">生成信息</h3><button type="button" className={flatButton + " !p-1"} aria-label="复制生成信息" onClick={() => copyText(JSON.stringify({ prompt: resource.prompt, model: resource.model, parameters: resource.parameters, project: resource.projectTitle, createdAt: resource.createdAt }, null, 2), "已复制生成信息")}><Copy className="size-4" /></button></div>
                    <p className="whitespace-pre-wrap break-words leading-7">{resource.prompt || "旧记录未保存提示词"}</p>
                    {resource.parameters && Object.keys(resource.parameters).length ? <div className="mt-4 flex flex-wrap gap-2">{Object.entries(resource.parameters).map(([key, value]) => <span key={key} className="rounded-md border px-2 py-1 text-xs" style={{ borderColor: theme.toolbar.border }}>{key} · {String(value)}</span>)}</div> : null}
                    {resource.references?.length ? <div className="mt-6"><h3 className="mb-3 opacity-50">参考素材 · {resource.references.length}</h3><div className="flex flex-wrap gap-2">{resource.references.map((reference, index) => <HistoryReference key={index} reference={reference} index={index} />)}</div></div> : null}
                </div>
                <div className="mt-5 flex flex-wrap gap-2 border-t pt-4" style={{ borderColor: theme.toolbar.border }}>
                    <button type="button" className={flatButton + " w-full"} disabled={busy} onClick={onInsert}><Plus className="size-4" />添加到当前画布</button>
                    <button type="button" className={flatButton + " flex-1"} disabled={busy} onClick={onDownload}><Download className="size-4" />下载</button>
                    <button type="button" className={flatButton + " flex-1 text-red-500"} disabled={busy} onClick={onRemove}><Trash2 className="size-4" />删除历史</button>
                </div>
            </aside>
        </div> : null}
    </Modal>;
}

function HistoryReference({ reference, index }: { reference: string; index: number }) {
    const [url, setUrl] = useState("");
    const image = reference.startsWith("image:");
    useEffect(() => {
        let alive = true;
        const resolve = image ? resolveImageUrl(reference) : /^(video:|audio:)/.test(reference) ? resolveMediaUrl(reference) : Promise.resolve(reference);
        void resolve.then((value) => { if (alive) setUrl(value); }).catch(() => {});
        return () => { alive = false; };
    }, [reference, image]);
    return <a href={url || undefined} target="_blank" rel="noreferrer" title={`参考素材${index + 1}`} className="flex size-14 items-center justify-center overflow-hidden rounded-lg border border-current/15 text-xs opacity-70">{image && url ? <img src={url} alt={`参考图${index + 1}`} className="size-full object-cover" /> : reference.startsWith("video:") ? <Video className="size-5" /> : reference.startsWith("audio:") ? <Music2 className="size-5" /> : <span>参考{index + 1}</span>}</a>;
}
