import { useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Columns3, Group, LayoutGrid, Ungroup } from "lucide-react";
import { Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { nodeBounds } from "@/lib/canvas/canvas-node-geometry";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeData, ViewportTransform } from "@/types/canvas";

export const SELECTION_PAD = 14;
const MIN_SELECTION_SIZE = 72;
type ResizeCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
type SelectionBounds = { left: number; top: number; right: number; bottom: number };
type SelectionLayout = "grid" | "column";

export function CanvasSelectionToolbar({
    nodes,
    viewport,
    showToolbar,
    canGroup,
    canUngroup,
    onGroup,
    onUngroup,
    onResizeStart,
    onResize,
    onResizeEnd,
    onArrange,
    onConnectStart,
}: {
    nodes: CanvasNodeData[];
    viewport: ViewportTransform;
    showToolbar: boolean;
    canGroup: boolean;
    canUngroup: boolean;
    onGroup: () => void;
    onUngroup: () => void;
    onResizeStart: (nodes: CanvasNodeData[]) => void;
    onResize: (start: SelectionBounds, next: SelectionBounds) => void;
    onResizeEnd: () => void;
    onArrange: (layout: SelectionLayout) => void;
    onConnectStart: (event: ReactMouseEvent<HTMLDivElement>, handleType: "source" | "target") => void;
}) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [arrangeOpen, setArrangeOpen] = useState(false);
    if (nodes.length < 2) return null;

    const bounds = nodeBounds(nodes);
    const left = viewport.x + bounds.left * viewport.k - SELECTION_PAD;
    const top = viewport.y + bounds.top * viewport.k - SELECTION_PAD;
    const width = (bounds.right - bounds.left) * viewport.k + SELECTION_PAD * 2;
    const height = (bounds.bottom - bounds.top) * viewport.k + SELECTION_PAD * 2;
    const showActions = showToolbar;
    const startResize = (event: ReactPointerEvent<HTMLButtonElement>, corner: ResizeCorner) => {
        event.preventDefault();
        event.stopPropagation();
        const start = nodeBounds(nodes);
        const startX = event.clientX;
        const startY = event.clientY;
        onResizeStart(nodes);
        const controller = new AbortController();
        const move = (moveEvent: PointerEvent) => {
            const dx = (moveEvent.clientX - startX) / viewport.k;
            const dy = (moveEvent.clientY - startY) / viewport.k;
            const startWidth = Math.max(1, start.right - start.left);
            const startHeight = Math.max(1, start.bottom - start.top);
            const horizontalDelta = corner.includes("left") ? -dx : dx;
            const verticalDelta = corner.includes("top") ? -dy : dy;
            const horizontalChange = horizontalDelta / startWidth;
            const verticalChange = verticalDelta / startHeight;
            const scale = Math.max(
                Math.min(1, MIN_SELECTION_SIZE / Math.min(startWidth, startHeight)),
                1 + (Math.abs(horizontalChange) >= Math.abs(verticalChange) ? horizontalChange : verticalChange),
            );
            const nextWidth = startWidth * scale;
            const nextHeight = startHeight * scale;
            const next = {
                left: corner.includes("left") ? start.right - nextWidth : start.left,
                right: corner.includes("left") ? start.right : start.left + nextWidth,
                top: corner.includes("top") ? start.bottom - nextHeight : start.top,
                bottom: corner.includes("top") ? start.bottom : start.top + nextHeight,
            };
            onResize(start, next);
        };
        const end = () => {
            controller.abort();
            onResizeEnd();
        };
        window.addEventListener("pointermove", move, { signal: controller.signal });
        window.addEventListener("pointerup", end, { signal: controller.signal, once: true });
        window.addEventListener("pointercancel", end, { signal: controller.signal, once: true });
    };

    return (
        <>
            <svg className="pointer-events-none absolute z-[65] overflow-visible" style={{ left, top, width, height }}>
                <rect
                    x={1}
                    y={1}
                    width={Math.max(width - 2, 0)}
                    height={Math.max(height - 2, 0)}
                    rx={16}
                    ry={16}
                    fill={theme.canvas.selectionFill}
                    stroke={theme.canvas.selectionStroke}
                    strokeOpacity={0.55}
                    strokeWidth={1.5}
                    strokeDasharray="7 5"
                    strokeLinecap="round"
                />
            </svg>
            {showToolbar ? (
                <>
                    <SelectionResizeHandle corner="top-left" left={left} top={top} onPointerDown={startResize} />
                    <SelectionResizeHandle corner="top-right" left={left + width} top={top} onPointerDown={startResize} />
                    <SelectionResizeHandle corner="bottom-left" left={left} top={top + height} onPointerDown={startResize} />
                    <SelectionResizeHandle corner="bottom-right" left={left + width} top={top + height} onPointerDown={startResize} />
                    <SelectionConnectionHandle side="left" left={left} top={top + height / 2} onMouseDown={onConnectStart} />
                    <SelectionConnectionHandle side="right" left={left + width} top={top + height / 2} onMouseDown={onConnectStart} />
                </>
            ) : null}
            {showActions ? (
                <div
                    className="absolute z-[70] flex h-12 -translate-x-1/2 -translate-y-full items-center overflow-visible rounded-[18px] border border-black/10 bg-white text-[15px] text-[#242529] shadow-[0_8px_28px_rgba(15,23,42,.12)]"
                    style={{ left: left + width / 2, top: top - 8 }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                >
                    {canGroup ? <SelectionAction title={t("canvas.nodeToolbar.groupTitle")} label={t("canvas.nodeToolbar.group")} icon={<Group className="size-4" />} onClick={onGroup} /> : null}
                    {canUngroup ? <SelectionAction title={t("canvas.nodeToolbar.ungroupTitle")} label={t("canvas.nodeToolbar.ungroup")} icon={<Ungroup className="size-4" />} onClick={onUngroup} /> : null}
                    <div className="relative">
                        <SelectionAction title={t("canvas.nodeToolbar.arrangeTitle")} label={t("canvas.nodeToolbar.arrange")} icon={<LayoutGrid className="size-4" />} onClick={() => setArrangeOpen((value) => !value)} />
                        {arrangeOpen ? (
                            <div className="absolute left-1/2 top-full z-[75] mt-2 w-36 -translate-x-1/2 rounded-xl border border-black/10 bg-white p-1.5 shadow-[0_8px_28px_rgba(15,23,42,.16)]">
                                <ArrangeAction label={t("canvas.nodeToolbar.arrangeGrid")} icon={<LayoutGrid className="size-4" />} onClick={() => { onArrange("grid"); setArrangeOpen(false); }} />
                                <ArrangeAction label={t("canvas.nodeToolbar.arrangeColumn")} icon={<Columns3 className="size-4" />} onClick={() => { onArrange("column"); setArrangeOpen(false); }} />
                            </div>
                        ) : null}
                    </div>
                </div>
            ) : null}
        </>
    );
}

function SelectionResizeHandle({ corner, left, top, onPointerDown }: { corner: ResizeCorner; left: number; top: number; onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>, corner: ResizeCorner) => void }) {
    const cursor = corner === "top-left" || corner === "bottom-right" ? "cursor-nwse-resize" : "cursor-nesw-resize";
    return <button type="button" className={`absolute z-[70] size-3 -translate-x-1/2 -translate-y-1/2 rounded-sm border-2 border-stone-700 bg-white shadow-sm ${cursor}`} style={{ left, top }} onPointerDown={(event) => onPointerDown(event, corner)} aria-label="Resize selection" />;
}

function SelectionConnectionHandle({ side, left, top, onMouseDown }: { side: "left" | "right"; left: number; top: number; onMouseDown: (event: ReactMouseEvent<HTMLDivElement>, handleType: "source" | "target") => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    return (
        <div className="absolute z-[70] flex size-12 -translate-x-1/2 -translate-y-1/2 cursor-crosshair items-center justify-center" style={{ left, top }} onMouseDown={(event) => onMouseDown(event, side === "left" ? "target" : "source")}>
            <div className="size-3 rounded-full border-2 transition-all hover:scale-125" style={{ background: theme.node.panel, borderColor: theme.node.muted }} />
        </div>
    );
}

function ArrangeAction({ label, icon, onClick }: { label: string; icon: ReactNode; onClick: () => void }) {
    return <button type="button" className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-xs text-[#242529] hover:bg-[#f0f0f1]" onClick={onClick}>{icon}{label}</button>;
}

function SelectionAction({ title, label, icon, onClick }: { title: string; label: string; icon: ReactNode; onClick: () => void }) {
    return (
        <Tooltip title={title} placement="top" mouseEnterDelay={0.2} color="#ffffff" styles={{ root: { color: "#242529", boxShadow: "0 8px 24px rgba(15,23,42,.16)", fontSize: 13, fontWeight: 500 } }}>
            <button type="button" className="group relative flex h-12 items-center whitespace-nowrap px-1.5" onClick={onClick} aria-label={title}>
                <span className="flex h-9 items-center gap-2 rounded-lg px-2.5 transition group-hover:bg-[#f0f0f1]">
                    {icon}
                    <span>{label}</span>
                </span>
            </button>
        </Tooltip>
    );
}
