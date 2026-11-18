import { useEffect, useRef, useState, type PointerEvent } from "react";
import { InputNumber, Modal, Spin, theme } from "antd";
import { useTranslation } from "react-i18next";

import { audioFrameAt, audioWaveform } from "@/lib/audio-editing";
import { loadCanvasAudio } from "@/services/audio-editing";
import { AudioWaveform } from "./audio-waveform";

export function CanvasAudioCropDialog({ content, storageKey, title, onClose, onConfirm }: {
    content: string;
    storageKey?: string;
    title: string;
    onClose: () => void;
    onConfirm: (audio: AudioBuffer, start: number, end: number) => Promise<void>;
}) {
    const { t } = useTranslation();
    const { token } = theme.useToken();
    const [clip, setClip] = useState<{ audio: AudioBuffer; peaks: number[] } | null>(null);
    const [range, setRange] = useState<[number, number]>([0, 0]);
    const [error, setError] = useState("");
    const [saving, setSaving] = useState(false);
    const savingRef = useRef(false);
    const drag = useRef<{ pointerId: number; anchor: number; previous: [number, number] } | null>(null);
    const decodeError = t("canvas.audioEditing.decodeFailed");

    useEffect(() => {
        const controller = new AbortController();
        void loadCanvasAudio(content, storageKey, controller.signal).then((audio) => {
            if (controller.signal.aborted) return;
            setClip({ audio, peaks: audioWaveform(audio) });
            setRange([0, audio.length]);
        }).catch(() => {
            if (!controller.signal.aborted) setError(decodeError);
        });
        return () => controller.abort();
    }, [content, storageKey, decodeError]);

    const audio = clip?.audio;
    const [start, end] = range;
    const secondsAt = (frame: number) => audio ? frame / audio.sampleRate : 0;
    const frameAtPointer = (event: PointerEvent<HTMLDivElement>) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        return audioFrameAt((event.clientX - bounds.left) / Math.max(bounds.width, 1), audio?.length || 0);
    };
    const updateRange = (anchor: number, frame: number) => setRange([Math.min(anchor, frame), Math.max(anchor, frame)]);
    const endDrag = (event: PointerEvent<HTMLDivElement>) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        drag.current = null;
    };

    const confirm = async () => {
        if (!audio || end <= start || drag.current || savingRef.current) return;
        savingRef.current = true;
        setSaving(true);
        setError("");
        try {
            await onConfirm(audio, start, end);
        } catch {
            setError(t("canvas.audioEditing.cropFailed"));
        } finally {
            savingRef.current = false;
            setSaving(false);
        }
    };

    return (
        <Modal open centered width={720} title={t("canvas.audioEditing.title")} okText={t("canvas.audioEditing.confirm")} cancelText={t("common.cancel")} confirmLoading={saving} closable={!saving} keyboard={!saving} mask={{ closable: false }} okButtonProps={{ disabled: !audio || end <= start }} cancelButtonProps={{ disabled: saving }} onCancel={() => { if (!savingRef.current) onClose(); }} onOk={() => void confirm()}>
            <div className="space-y-3" data-canvas-shortcuts-ignore>
                <p className="truncate text-sm font-medium" title={title}>{title}</p>
                {clip ? (
                    <>
                        <p className="text-xs opacity-70">{t("canvas.audioEditing.hint")}</p>
                        <div
                            className="relative h-32 touch-none select-none overflow-hidden rounded-lg border"
                            style={{ background: token.colorFillQuaternary, borderColor: token.colorBorder, cursor: saving ? "default" : "crosshair", color: token.colorTextSecondary }}
                            onPointerDown={(event) => {
                                if (event.button !== 0 || !event.isPrimary || saving || drag.current) return;
                                event.preventDefault();
                                const frame = frameAtPointer(event);
                                const bound = (event.target as HTMLElement).dataset.audioBound;
                                const anchor = bound === "start" ? end : bound === "end" ? start : frame;
                                drag.current = { pointerId: event.pointerId, anchor, previous: range };
                                event.currentTarget.setPointerCapture(event.pointerId);
                                if (!bound) updateRange(anchor, frame);
                            }}
                            onPointerMove={(event) => { if (drag.current?.pointerId === event.pointerId) updateRange(drag.current.anchor, frameAtPointer(event)); }}
                            onPointerUp={(event) => {
                                if (drag.current?.pointerId === event.pointerId) updateRange(drag.current.anchor, frameAtPointer(event));
                                endDrag(event);
                            }}
                            onPointerCancel={(event) => {
                                if (drag.current?.pointerId === event.pointerId) setRange(drag.current.previous);
                                endDrag(event);
                            }}
                            onLostPointerCapture={endDrag}
                        >
                            <AudioWaveform peaks={clip.peaks} className="pointer-events-none absolute inset-0 size-full" />
                            <div className="pointer-events-none absolute inset-y-0" style={{ left: `${100 * start / clip.audio.length}%`, width: `${100 * (end - start) / clip.audio.length}%`, background: token.colorPrimaryBg, opacity: 0.6 }} />
                            {(["start", "end"] as const).map((bound) => (
                                <div key={bound} data-audio-bound={bound} className="absolute inset-y-0 w-2 cursor-ew-resize"
                                    style={{ left: `clamp(0px, calc(${100 * (bound === "start" ? start : end) / clip.audio.length}% - 4px), calc(100% - 8px))`, background: token.colorPrimary }} />
                            ))}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
                            {(["start", "end"] as const).map((bound) => (
                                <label key={bound} className="flex items-center gap-2">
                                    {t(`canvas.audioEditing.${bound}`)}
                                    <InputNumber min={0} max={clip.audio.duration} step={0.001} suffix={t("canvas.audioEditing.seconds")} disabled={saving} value={Number(secondsAt(bound === "start" ? start : end).toFixed(3))}
                                        onChange={(value) => {
                                            if (value === null || !Number.isFinite(value)) return;
                                            const frame = audioFrameAt(value / clip.audio.duration, clip.audio.length);
                                            setRange(bound === "start" ? [Math.min(frame, end), end] : [start, Math.max(frame, start)]);
                                        }} />
                                </label>
                            ))}
                            <span className="tabular-nums opacity-70">{t("canvas.audioEditing.selected", { duration: secondsAt(end - start).toFixed(3) })}</span>
                        </div>
                    </>
                ) : !error && <div className="flex h-32 items-center justify-center gap-2 text-sm"><Spin size="small" />{t("canvas.audioEditing.loading")}</div>}
                {error && <p role="alert" className="text-sm" style={{ color: token.colorError }}>{error}</p>}
            </div>
        </Modal>
    );
}
