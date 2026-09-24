import { useEffect, type ReactNode } from "react";
import { Slider, Switch } from "antd";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { ImageSettingsTheme } from "@/components/image-settings-panel";
import { type CanvasTheme } from "@/lib/canvas-theme";
import { clampVideoSeconds, computeVideoSize, inferVideoRatio, parseVideoResolution, readVideoDimensions, VIDEO_SECONDS_MAX, VIDEO_SECONDS_MIN, videoRatioOptions } from "@/lib/media-size";
import { isVolcengineSeedance25, modelOptionName, type AiConfig } from "@/stores/use-config-store";

const resolutionOptions = [
    { value: "480", label: "480p" },
    { value: "720", label: "720p" },
    { value: "1080", label: "1080p" },
];
const videoModeOptions = [
    { value: "frames", labelKey: "frames" },
    { value: "reference", labelKey: "reference" },
];
const seedanceTaskTypeLabels = {
    reference: "全模态参考",
    auto: "自动识别",
    extend: "延长视频",
    edit: "视频编辑",
} as const;

export const videoResolutionOptions = resolutionOptions.map((item) => ({ value: item.value, label: item.label }));
export const videoSizeOptions = videoRatioOptions.map((item) => ({ value: item.value, get label() { return item.value === "auto" ? i18n.t("settingsPanels.common.auto") : item.value; } }));
export const videoSecondsRange = { min: VIDEO_SECONDS_MIN, max: VIDEO_SECONDS_MAX };

export type VideoSettingsKey = "vquality" | "size" | "videoSeconds" | "videoGenerateAudio" | "videoWatermark" | "videoMode" | "seedanceDraft" | "seedanceTaskType" | "seedanceSeed" | "seedanceCameraFixed" | "seedanceReturnLastFrame" | "seedanceOutputFormat";

type VideoSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: VideoSettingsKey, value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
};

export function VideoSettingsPanel({ config, onConfigChange, theme, showTitle = true, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5" }: VideoSettingsPanelProps) {
    const { t } = useTranslation();
    const isSeedance25 = isVolcengineSeedance25(config);
    const modelName = modelOptionName(config.model).replace(/^models\//, "").toLowerCase();
    const isSeedance20 = /doubao-seedance-2-0/.test(modelName);
    const isSeedance20Fast = isSeedance20 && /fast|mini/.test(modelName);
    const isOmni = /^gemini-omni-/.test(modelName);
    const isDraft = isSeedance25 && config.seedance.draft;
    const minSeconds = isOmni ? 3 : VIDEO_SECONDS_MIN;
    const maxSeconds = isOmni ? 10 : isSeedance20 ? 15 : VIDEO_SECONDS_MAX;
    const seconds = Math.max(minSeconds, Math.min(maxSeconds, Number(config.videoSeconds) || 6));
    const videoMode = normalizeVideoModeValue(config.videoMode);
    const omniResolutionOptions = [{ value: "360", label: "360p" }, { value: "720", label: "720p" }, { value: "1080", label: "1080p" }, { value: "2160", label: "4K" }];
    const allowedResolutions = isOmni ? omniResolutionOptions : isSeedance20Fast ? resolutionOptions.filter((item) => item.value !== "1080") : resolutionOptions;
    const requestedResolution = parseVideoResolution(config.vquality);
    const resolution = isDraft ? "480" : allowedResolutions.some((item) => item.value === requestedResolution) ? requestedResolution : "720";
    const selectedRatio = inferVideoRatio(config.size || "auto");
    const fixedDimensions = isOmni || isSeedance20 || isSeedance25;
    const dimensions = readVideoDimensions(fixedDimensions ? computeVideoSize(resolution, selectedRatio === "auto" ? "16:9" : selectedRatio) : config.size || "auto", resolution, selectedRatio);
    const applySize = (nextResolution: string, ratio: string) => {
        onConfigChange("vquality", nextResolution);
        onConfigChange("size", computeVideoSize(nextResolution, ratio));
    };
    const selectResolution = (nextResolution: string) => {
        if (selectedRatio === "auto") onConfigChange("vquality", nextResolution);
        else applySize(nextResolution, selectedRatio);
    };
    useEffect(() => {
        const smartEdit = isSeedance25 && config.seedance.taskType === "edit" && config.videoSeconds === "-1";
        if (!smartEdit && String(seconds) !== String(config.videoSeconds)) onConfigChange("videoSeconds", String(seconds));
        if (resolution !== requestedResolution) onConfigChange("vquality", resolution);
        const adaptive = isSeedance25 && ["extend", "edit"].includes(config.seedance.taskType);
        if (!isDraft && !adaptive && selectedRatio !== "auto" && (fixedDimensions || resolution !== requestedResolution)) {
            const nextSize = computeVideoSize(resolution, selectedRatio);
            if (config.size !== nextSize) onConfigChange("size", nextSize);
        }
    }, [config.model, config.size, config.videoSeconds, config.vquality, config.seedance.taskType, seconds, isDraft, isSeedance25, fixedDimensions, resolution, requestedResolution, selectedRatio, onConfigChange]);

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">{t("settingsPanels.video.title")}</div> : null}
                {isSeedance25 ? (
                    <SettingGroup title="Seedance 2.5" color={theme.node.muted}>
                        <div className="space-y-2.5">
                            <div className="text-xs" style={{ color: theme.node.muted }}>任务类型</div>
                            <div className="grid grid-cols-4 gap-2">
                                {(Object.keys(seedanceTaskTypeLabels) as Array<keyof typeof seedanceTaskTypeLabels>).map((taskType) => (
                                    <OptionPill key={taskType} selected={config.seedance.taskType === taskType} theme={theme} onClick={() => { onConfigChange("seedanceTaskType", taskType); if (taskType === "extend" || taskType === "edit") onConfigChange("size", "auto"); if (taskType === "edit") onConfigChange("videoSeconds", "-1"); }}><span className="block whitespace-nowrap text-[11px] leading-none">{seedanceTaskTypeLabels[taskType]}</span></OptionPill>
                                ))}
                            </div>
                        </div>
                        <label className="flex h-9 items-center justify-between rounded-full border px-3 text-sm" style={{ borderColor: theme.node.stroke }}>
                            草稿模式
                            <Switch size="small" checked={isDraft} onChange={(checked) => { onConfigChange("seedanceDraft", String(checked)); if (checked) onConfigChange("vquality", "480"); }} />
                        </label>
                        <div className="grid grid-cols-2 gap-2.5">
                            <label className="flex h-9 items-center justify-between rounded-full border px-3 text-sm" style={{ borderColor: theme.node.stroke }}>
                                固定镜头
                                <Switch size="small" checked={config.seedance.cameraFixed} onChange={(checked) => onConfigChange("seedanceCameraFixed", String(checked))} />
                            </label>
                            <label className="flex h-9 items-center justify-between rounded-full border px-3 text-sm" style={{ borderColor: theme.node.stroke }}>
                                返回尾帧
                                <Switch size="small" checked={config.seedance.returnLastFrame} onChange={(checked) => onConfigChange("seedanceReturnLastFrame", String(checked))} />
                            </label>
                        </div>
                        <div className="grid grid-cols-[1fr_104px] items-center gap-2.5">
                            <div className="grid grid-cols-2 gap-2">
                                {(["mp4", "mov"] as const).map((format) => <OptionPill key={format} selected={config.seedance.outputFormat === format} theme={theme} onClick={() => onConfigChange("seedanceOutputFormat", format)}>{format.toUpperCase()}</OptionPill>)}
                            </div>
                            <label className="flex h-9 overflow-hidden rounded-full border text-sm" style={{ borderColor: theme.node.stroke }}>
                                <span className="grid shrink-0 place-items-center px-2 text-xs" style={{ color: theme.node.muted }}>Seed</span>
                                <input type="number" className="min-w-0 flex-1 bg-transparent pr-2 text-center outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" value={config.seedance.seed} onChange={(event) => onConfigChange("seedanceSeed", event.target.value)} onMouseDown={(event) => event.stopPropagation()} />
                            </label>
                        </div>
                        {isDraft ? <div className="text-xs" style={{ color: theme.node.muted }}>草稿固定为 480p；生成成功后可在视频节点中发起正式生成。</div> : null}
                    </SettingGroup>
                ) : null}
                <SettingGroup title={t("settingsPanels.video.quality")} color={theme.node.muted}>
                    {isDraft ? <div className="flex h-9 items-center justify-center rounded-full border text-sm" style={{ borderColor: theme.node.stroke }}>480p（草稿模式锁定）</div> : <div className="grid grid-cols-4 gap-2.5">{allowedResolutions.map((item) => (<OptionPill key={item.value} selected={resolution === item.value} theme={theme} onClick={() => selectResolution(item.value)}>{item.label}</OptionPill>))}</div>}
                </SettingGroup>
                <SettingGroup title={t("settingsPanels.video.size")} color={theme.node.muted}>
                    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2.5">
                        <DimensionInput prefix="W" value={dimensions.width} disabled={fixedDimensions || selectedRatio === "auto"} theme={theme} onChange={(value) => updateDimension("width", value, dimensions, onConfigChange)} />
                        <span className="text-lg opacity-45">↔</span>
                        <DimensionInput prefix="H" value={dimensions.height} disabled={fixedDimensions || selectedRatio === "auto"} theme={theme} onChange={(value) => updateDimension("height", value, dimensions, onConfigChange)} />
                    </div>
                </SettingGroup>
                <SettingGroup title={t("settingsPanels.video.ratio")} color={theme.node.muted}>
                    <div className={isOmni ? "grid grid-cols-2 gap-2.5" : "grid grid-cols-4 gap-2.5"}>
                        {(isOmni ? videoRatioOptions.filter((item) => item.value === "16:9" || item.value === "9:16") : videoRatioOptions).map((item) => (
                            <button
                                key={item.value}
                                type="button"
                                className="flex h-[72px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border bg-transparent text-sm transition hover:opacity-80"
                                style={{ borderColor: selectedRatio === item.value ? theme.node.text : theme.node.stroke, color: theme.node.text }}
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={() => applySize(resolution, item.value)}
                            >
                                <SizePreview width={item.width} height={item.height} color={theme.node.text} />
                                <span>{item.value === "auto" ? t("settingsPanels.common.auto") : item.value}</span>
                            </button>
                        ))}
                    </div>
                </SettingGroup>
                <SettingGroup title={t("settingsPanels.video.seconds")} color={theme.node.muted}>
                    <div className="flex items-center gap-3" onMouseDown={(event) => event.stopPropagation()}>
                        <Slider className="min-w-0 flex-1" min={minSeconds} max={maxSeconds} step={1} value={seconds} onChange={(value) => onConfigChange("videoSeconds", String(Array.isArray(value) ? value[0] : value))} />
                        <SecondsInput value={seconds} theme={theme} min={minSeconds} max={maxSeconds} onCommit={(value) => onConfigChange("videoSeconds", String(value))} />
                        <span className="shrink-0 text-sm" style={{ color: theme.node.muted }}>s</span>
                    </div>
                </SettingGroup>
                <SettingGroup title={t("settingsPanels.video.mode")} color={theme.node.muted}>
                    <div className="grid grid-cols-2 gap-2.5">
                        {videoModeOptions.map((item) => (
                            <OptionPill key={item.value} selected={videoMode === item.value} theme={theme} onClick={() => onConfigChange("videoMode", item.value)}>
                                {t(`settingsPanels.video.modes.${item.labelKey}`)}
                            </OptionPill>
                        ))}
                    </div>
                </SettingGroup>
                {isOmni ? <div className="text-xs" style={{ color: theme.node.muted }}>首尾帧：前两张图依次作为首帧、尾帧；全参考：所有图片按顺序作为素材参考。Omni 支持 3–10s · 16:9 / 9:16，1080p/4K 为放大输出。</div> : null}
            </div>
        </ImageSettingsTheme>
    );
}

export function videoResolutionLabel(value: string) {
    return `${parseVideoResolution(value)}p`;
}

export function videoSizeLabel(value: string) {
    const ratio = inferVideoRatio(value);
    return ratio === "auto" ? i18n.t("settingsPanels.video.adaptive") : ratio;
}

export function videoSecondsLabel(value: string) {
    if (String(value).trim() === "-1") return i18n.t("settingsPanels.video.smart");
    return `${value || "6"}s`;
}

export function videoModeLabel(value: string) {
    return i18n.t(`settingsPanels.video.modes.${normalizeVideoModeValue(value)}`);
}

export function normalizeVideoModeValue(value: string | undefined) {
    return value === "reference" ? "reference" : "frames";
}

export function normalizeVideoSizeValue(value: string, resolution = "720") {
    if (value === "auto") return "auto";
    if (/^\d+x\d+$/.test(value || "")) return value;
    const ratio = inferVideoRatio(value);
    return ratio === "auto" ? "auto" : computeVideoSize(resolution, ratio);
}

export function normalizeVideoResolutionValue(value: string) {
    return parseVideoResolution(value);
}

function updateDimension(key: "width" | "height", value: number | null, dimensions: { width: number; height: number }, onConfigChange: VideoSettingsPanelProps["onConfigChange"]) {
    const next = Math.max(1, Math.floor(value || dimensions[key] || 720));
    onConfigChange("size", `${key === "width" ? next : dimensions.width}x${key === "height" ? next : dimensions.height}`);
}

function OptionPill({ selected, disabled = false, theme, onClick, children }: { selected: boolean; disabled?: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button type="button" disabled={disabled} className="h-9 min-w-0 cursor-pointer overflow-hidden rounded-full border px-2 text-sm transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-35" style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()} onClick={onClick}>
            {children}
        </button>
    );
}

function SettingGroup({ title, color, children }: { title: string; color: string; children: ReactNode }) {
    return (
        <div className="space-y-2.5">
            <div className="text-xs font-medium" style={{ color }}>
                {title}
            </div>
            {children}
        </div>
    );
}

function SecondsInput({ value, theme, onCommit, min = VIDEO_SECONDS_MIN, max = VIDEO_SECONDS_MAX }: { value: number; theme: CanvasTheme; onCommit: (value: number) => void; min?: number; max?: number }) {
    const commit = (input: HTMLInputElement) => {
        const next = Math.max(min, Math.min(max, Number(input.value) || 6));
        input.value = String(next);
        onCommit(next);
    };

    return (
        <label className="flex h-9 w-[68px] shrink-0 overflow-hidden rounded-xl text-sm" style={{ background: theme.node.fill, color: theme.node.text }}>
            <input
                type="number"
                min={min}
                max={max}
                className="min-w-0 flex-1 bg-transparent px-2 text-center outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                defaultValue={value}
                key={value}
                onBlur={(event) => commit(event.currentTarget)}
                onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                }}
                onMouseDown={(event) => event.stopPropagation()}
            />
        </label>
    );
}

function DimensionInput({ prefix, value, disabled, theme, onChange }: { prefix: string; value: number; disabled: boolean; theme: CanvasTheme; onChange: (value: number | null) => void }) {
    return (
        <label className="flex h-9 overflow-hidden rounded-xl text-sm" style={{ background: theme.node.fill, color: theme.node.text, opacity: disabled ? 0.55 : 1 }}>
            <span className="grid w-9 place-items-center" style={{ color: theme.node.muted }}>
                {prefix}
            </span>
            <input type="number" min={1} disabled={disabled} className="min-w-0 flex-1 bg-transparent px-2 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" value={value || ""} onChange={(event) => onChange(Number(event.target.value) || null)} onMouseDown={(event) => event.stopPropagation()} />
        </label>
    );
}

function SizePreview({ width, height, color }: { width: number; height: number; color: string }) {
    if (!width || !height) return null;
    const longSide = Math.max(width, height);
    const previewWidth = Math.max(10, Math.round((width / longSide) * 26));
    const previewHeight = Math.max(10, Math.round((height / longSide) * 26));
    return <span className="rounded-[3px] border-2" style={{ width: previewWidth, height: previewHeight, borderColor: color }} />;
}
