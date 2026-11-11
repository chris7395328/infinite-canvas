import { type ReactNode, useState } from "react";
import { ConfigProvider, Switch } from "antd";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { geminiImageCapabilities, normalizeGeminiImageSettings } from "@/lib/gemini-image";
import { type CanvasTheme } from "@/lib/canvas-theme";
import { getImageQualityOptions, isImageQualitySupported } from "@/lib/image-quality";
import { computeMediaSize, inferMediaRatio, inferMediaScale, mediaRatioOptions, mediaScaleOptions, readMediaDimensions } from "@/lib/media-size";
import { resolveModelScript, type AiConfig } from "@/stores/use-config-store";
import { isGptImage26Model, type GptImageSettings } from "@/lib/gpt-image";

const DIMENSION_STEP = 16;

export function imageQualityOptions(model?: string) {
    return getImageQualityOptions(model).map((item) => ({ value: item.value, label: i18n.t(`settingsPanels.common.${item.labelKey}`) }));
}
export const imageAspectOptions = mediaRatioOptions.map((item) => ({ value: item.value, label: item.value === "auto" ? i18n.t("settingsPanels.common.auto") : item.value }));
export const imageScaleOptions = mediaScaleOptions.map((value) => ({ value, label: value === "auto" ? i18n.t("settingsPanels.common.auto") : value }));

type ImageSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: "quality" | "size" | "count" | "background" | "geminiImageSize" | "geminiAspectRatio" | "geminiThinkingLevel" | "gptImage", value: string | GptImageSettings) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
    maxCount?: number;
    quickCount?: number;
};

export function ImageSettingsPanel({ config, onConfigChange, theme, showTitle = true, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5", maxCount = 15, quickCount = 10 }: ImageSettingsPanelProps) {
    const { t } = useTranslation();
    const [snapDimensionToStep, setSnapDimensionToStep] = useState(true);
    const model = config.model || config.imageModel;
    const gemini = geminiImageCapabilities(model);
    const gpt26 = isGptImage26Model(model);
    const format = config.gptImage?.format || "png";
    const qualityOptions = getImageQualityOptions(model);
    const quality = isImageQualitySupported(model, config.quality) ? config.quality : "auto";
    const count = Math.max(1, Math.min(maxCount, Math.floor(Math.abs(Number(config.count)) || 1)));
    const activeSize = config.size || "auto";
    const transparentBackground = config.background === "transparent";
    const selectedScale = inferMediaScale(activeSize);
    const selectedRatio = inferMediaRatio(activeSize);
    const dimensions = readMediaDimensions(activeSize, selectedScale, selectedRatio);
    const applySize = (scale: string, ratio: string) => onConfigChange("size", computeMediaSize(scale, ratio));
    const selectScale = (scale: string) => applySize(scale, selectedRatio === "auto" ? "1:1" : selectedRatio);
    const selectRatio = (ratio: string) => applySize(selectedScale, ratio);
    const updateDimension = (key: "width" | "height", value: number | null) => {
        const next = Math.max(1, Math.floor(value || dimensions[key] || 1024));
        const width = key === "width" ? next : dimensions.width;
        const height = key === "height" ? next : dimensions.height;
        onConfigChange("size", `${alignDimension(width, snapDimensionToStep)}x${alignDimension(height, snapDimensionToStep)}`);
    };

    return (
        <ImageSettingsTheme theme={theme}>
            <div
                className={className}
                style={{ color: theme.node.text }}
                onMouseDown={(event) => {
                    event.stopPropagation();
                    if (event.target instanceof HTMLInputElement) return;
                    if (document.activeElement instanceof HTMLInputElement && event.currentTarget.contains(document.activeElement)) document.activeElement.blur();
                }}
            >
                {showTitle ? <div className="text-lg font-semibold">{t("settingsPanels.image.title")}</div> : null}
                {gpt26 ? <GptImageOptions config={config} theme={theme} onConfigChange={onConfigChange} /> : null}
                {gemini ? <GeminiImageOptions config={config} theme={theme} onConfigChange={onConfigChange} /> : <>
                <div className="space-y-2.5">
                    <SettingTitle color={theme.node.muted}>{t("settingsPanels.image.quality")}</SettingTitle>
                    <div className={`grid gap-2.5 ${qualityOptions.length > 4 ? "grid-cols-3" : "grid-cols-4"}`}>
                        {qualityOptions.map((item) => (
                            <OptionPill key={item.value} selected={quality === item.value} theme={theme} onClick={() => onConfigChange("quality", item.value)}>
                                {t(`settingsPanels.common.${item.labelKey}`)}
                            </OptionPill>
                        ))}
                    </div>
                </div>
                <div className="space-y-2.5">
                    <div className="flex items-center justify-between gap-3">
                        <SettingTitle color={theme.node.muted}>{t("settingsPanels.image.size")}</SettingTitle>
                        <div className="flex items-center gap-2">
                            <span className="text-xs font-medium" style={{ color: theme.node.muted }}>
                                {t("settingsPanels.image.align16")}
                            </span>
                            <span title={t("settingsPanels.image.align16Hint")} onMouseDown={(event) => event.stopPropagation()}>
                                <Switch size="small" checked={snapDimensionToStep} onChange={setSnapDimensionToStep} />
                            </span>
                        </div>
                    </div>
                    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2.5">
                        <DimensionInput prefix="W" value={dimensions.width} disabled={selectedRatio === "auto"} theme={theme} alignToStep={snapDimensionToStep} onChange={(value) => updateDimension("width", value)} />
                        <span className="text-lg opacity-45">↔</span>
                        <DimensionInput prefix="H" value={dimensions.height} disabled={selectedRatio === "auto"} theme={theme} alignToStep={snapDimensionToStep} onChange={(value) => updateDimension("height", value)} />
                    </div>
                </div>
                <div className="space-y-2.5">
                    <SettingTitle color={theme.node.muted}>{t("settingsPanels.image.resolution")}</SettingTitle>
                    <div className="grid grid-cols-4 gap-2.5">
                        {mediaScaleOptions.map((value) => (
                            <OptionPill key={value} selected={selectedScale === value} theme={theme} onClick={() => selectScale(value)}>
                                {value === "auto" ? t("settingsPanels.common.auto") : value}
                            </OptionPill>
                        ))}
                    </div>
                </div>
                <div className="space-y-2.5">
                    <SettingTitle color={theme.node.muted}>{t("settingsPanels.image.aspectRatio")}</SettingTitle>
                    <div className="grid grid-cols-4 gap-2.5">
                        {mediaRatioOptions.map((item) => (
                            <button
                                key={item.value}
                                type="button"
                                className="flex h-[72px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border bg-transparent text-sm transition hover:opacity-80"
                                style={{ borderColor: selectedRatio === item.value ? theme.node.text : theme.node.stroke, background: "transparent", color: theme.node.text }}
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={() => selectRatio(item.value)}
                            >
                                <AspectIcon width={item.width} height={item.height} color={theme.node.text} />
                                <span>{item.value === "auto" ? t("settingsPanels.common.auto") : item.value}</span>
                            </button>
                        ))}
                    </div>
                </div>
                <div className="flex items-center justify-between gap-3">
                    <div className="space-y-0.5">
                        <SettingTitle color={theme.node.muted}>{t("settingsPanels.image.transparent")}</SettingTitle>
                        <div className="text-xs" style={{ color: theme.node.muted, opacity: 0.75 }}>
                            {t("settingsPanels.image.transparentHint")}
                        </div>
                    </div>
                    <span onMouseDown={(event) => event.stopPropagation()}>
                        <Switch size="small" disabled={gpt26 && !["png", "webp"].includes(format)} checked={transparentBackground && (!gpt26 || ["png", "webp"].includes(format))} onChange={(checked) => onConfigChange("background", checked ? "transparent" : "")} />
                    </span>
                </div>
                </>}
                <div className="space-y-2.5">
                    <SettingTitle color={theme.node.muted}>{t("settingsPanels.image.count")}</SettingTitle>
                    <div className="grid grid-cols-4 gap-2.5">
                        {Array.from({ length: quickCount }, (_, index) => index + 1).map((value) => (
                            <OptionPill key={value} selected={count === value} theme={theme} onClick={() => onConfigChange("count", String(value))}>
                                {t("settingsPanels.image.images", { count: value })}
                            </OptionPill>
                        ))}
                        <CountInput value={count} max={maxCount} theme={theme} onChange={(value) => onConfigChange("count", String(value || 1))} />
                    </div>
                </div>
            </div>
        </ImageSettingsTheme>
    );
}

function GptImageOptions({ config, theme, onConfigChange }: Pick<ImageSettingsPanelProps, "config" | "theme" | "onConfigChange">) {
    const settings = config.gptImage || {};
    const format = settings.format || "png";
    const update = (patch: Partial<GptImageSettings>) => onConfigChange("gptImage", { ...settings, ...patch });
    const inputClass = "w-full min-w-0 rounded-lg border border-current/20 bg-transparent p-2 text-sm";
    return <div className="space-y-3">
        <div className="text-xs" style={{ color: theme.node.muted }}>GPT Image 2.6 · 输出格式与复杂度独立于画质。GIF／SVG需账号或中转站支持，失败不会自动换模型或重新生成。</div>
        {resolveModelScript(config, config.model) ? <div className="text-xs" style={{ color: theme.node.muted }}>当前模型启用了自定义脚本。新参数需脚本读取并转发params；旧脚本不会自动更新。使用官方默认接口可清空调用脚本，内置请求会处理这些参数。</div> : null}
        <div className="grid grid-cols-3 gap-2">{(["png", "jpeg", "webp", "gif", "svg"] as const).map((value) => <OptionPill key={value} selected={format === value} theme={theme} onClick={() => {
            update({ format: value });
            if (!["png", "webp"].includes(value)) onConfigChange("background", "");
        }}>{value === "gif" ? "GIF 动画" : value === "svg" ? "SVG 矢量" : value.toUpperCase()}</OptionPill>)}</div>
        <SettingTitle color={theme.node.muted}>构图复杂度（思考量）</SettingTitle>
        <div className="grid grid-cols-4 gap-2">{([ ["auto", "默认"], ["low", "低"], ["medium", "中"], ["high", "高"] ] as const).map(([value, label]) => <OptionPill key={value} selected={(settings.complexity || "auto") === value} theme={theme} onClick={() => update({ complexity: value })}>{label}</OptionPill>)}</div>
        <div className="text-xs" style={{ color: theme.node.muted }}>默认不传complexity，采用模型默认值（官方当前为高）；更高复杂度可能增加等待时间。</div>
        {format === "gif" ? <div className="space-y-2 text-xs">
            <label className="block">动画帧数（2～16，默认9）<input type="number" min={2} max={16} step={1} className={inputClass} value={settings.frameCount ?? "9"} onChange={(event) => update({ frameCount: event.target.value })} /></label>
            <label className="block">每帧间隔毫秒（默认200；建议20～2000）<input type="number" min={20} step={10} className={inputClass} value={settings.frameDurationMs ?? "200"} onChange={(event) => update({ frameDurationMs: event.target.value })} /></label>
            <div style={{ color: theme.node.muted }}>API按10ms取整。尺寸指每帧尺寸，总像素预算由API校验；建议先用自动尺寸。GIF不支持压缩参数或流式预览，原动画文件会完整保存。</div>
        </div> : null}
        {["jpeg", "webp"].includes(format) ? <label className="block text-xs">压缩质量（0～100；留空使用官方默认）<input type="number" min={0} max={100} step={1} className={inputClass} value={settings.compression || ""} onChange={(event) => update({ compression: event.target.value })} /></label> : null}
        {format === "svg" ? <div className="space-y-2 text-xs">
            <div style={{ color: theme.node.muted }}>仅文生图、单次API只生成1张；画布批量仍逐次提交。不支持参考图／局部编辑。保存为真实矢量文件。下面的作者模型选项仅限账号已开通对应权限时填写。</div>
            <input className={inputClass} placeholder="SVG作者模型ID（默认留空）" value={settings.svgModel || ""} onChange={(event) => update({ svgModel: event.target.value })} />
            {settings.svgModel?.trim() ? <select className={inputClass} value={settings.svgReasoning || "auto"} onChange={(event) => update({ svgReasoning: event.target.value })}>{["auto", "none", "minimal", "low", "medium", "high", "xhigh", "max"].map((effort) => <option key={effort} value={effort}>{({ auto: "作者默认", none: "不思考", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高" } as Record<string, string>)[effort]}</option>)}</select> : null}
            <div style={{ color: theme.node.muted }}>SVG作者有独立Token费用；具体支持的推理档位由作者模型决定。</div>
        </div> : null}
        <label className="flex items-center justify-between text-xs">内容过滤（仍遵守官方政策）<select className="rounded border border-current/20 bg-transparent p-1" value={settings.moderation || "auto"} onChange={(event) => update({ moderation: event.target.value as "auto" | "low" })}><option value="auto">标准</option><option value="low">较宽松</option></select></label>
    </div>;
}

function GeminiImageOptions({ config, theme, onConfigChange }: Pick<ImageSettingsPanelProps, "config" | "theme" | "onConfigChange">) {
    const { t } = useTranslation();
    const model = config.model || config.imageModel;
    const capabilities = geminiImageCapabilities(model)!;
    const settings = normalizeGeminiImageSettings(model, config);
    const groups = [
        { key: "geminiImageSize" as const, label: "resolution", values: capabilities.sizes },
        { key: "geminiAspectRatio" as const, label: "aspectRatio", values: ["auto", ...capabilities.ratios] },
        ...(capabilities.thinking.length ? [{ key: "geminiThinkingLevel" as const, label: "thinking", values: ["auto", ...capabilities.thinking] }] : []),
    ];
    return <>
        <div className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>{t("settingsPanels.geminiImage.hint")}</div>
        {groups.map((group) => <div key={group.key} className="space-y-2.5">
            <SettingTitle color={theme.node.muted}>{t(`settingsPanels.geminiImage.${group.label}`)}</SettingTitle>
            <div className="grid grid-cols-3 gap-2">
                {group.values.map((value) => <OptionPill key={value} selected={settings[group.key] === value} theme={theme} onClick={() => onConfigChange(group.key, value)}>
                    {value === "auto" ? t("settingsPanels.common.auto") : group.key === "geminiThinkingLevel" ? t(`settingsPanels.geminiImage.${value}`) : value}
                </OptionPill>)}
            </div>
        </div>)}
    </>;
}

export function ImageSettingsTheme({ theme, children }: { theme: CanvasTheme; children: ReactNode }) {
    return (
        <ConfigProvider
            theme={{
                token: { colorBgContainer: theme.toolbar.panel, colorBgElevated: theme.toolbar.panel, colorBorder: theme.node.stroke, colorPrimary: theme.node.activeStroke, colorText: theme.node.text, colorTextLightSolid: theme.node.panel },
                components: {
                    Button: { defaultBg: theme.toolbar.panel, defaultBorderColor: theme.node.stroke, defaultColor: theme.node.text },
                    Slider: { railBg: theme.node.stroke, railHoverBg: theme.node.stroke, trackBg: theme.node.activeStroke, handleColor: theme.node.text, handleActiveColor: theme.node.text },
                },
            }}
        >
            {children}
        </ConfigProvider>
    );
}

export function imageQualityLabel(value: string) {
    return (["auto", "high", "medium", "low", "xhigh", "max"].includes(value) ? i18n.t(`settingsPanels.common.${value}`) : value);
}

export function imageSizeLabel(size: string) {
    const scale = inferMediaScale(size);
    const ratio = inferMediaRatio(size);
    if (ratio === "auto" || size === "auto") return i18n.t("settingsPanels.common.auto");
    if (scale === "auto") return ratio;
    return `${scale} · ${ratio}`;
}

function OptionPill({ selected, theme, onClick, children }: { selected: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button
            type="button"
            className="h-9 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80"
            style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onClick}
        >
            {children}
        </button>
    );
}

function DimensionInput({ prefix, value, disabled, theme, alignToStep, onChange }: { prefix: string; value: number; disabled: boolean; theme: CanvasTheme; alignToStep: boolean; onChange: (value: number | null) => void }) {
    const commit = (input: HTMLInputElement) => {
        const next = alignDimension(Math.max(1, Math.floor(Number(input.value) || value || 1024)), alignToStep);
        input.value = String(next);
        onChange(next);
    };

    return (
        <label className="flex h-9 overflow-hidden rounded-xl text-sm" style={{ background: theme.node.fill, color: theme.node.text, opacity: disabled ? 0.55 : 1 }}>
            <span className="grid w-9 place-items-center" style={{ color: theme.node.muted }}>
                {prefix}
            </span>
            <input
                type="number"
                min={1}
                disabled={disabled}
                className="min-w-0 flex-1 bg-transparent px-2 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                defaultValue={value || ""}
                key={`${prefix}-${value}`}
                onBlur={(event) => commit(event.currentTarget)}
                onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                }}
                onMouseDown={(event) => event.stopPropagation()}
            />
        </label>
    );
}

function CountInput({ value, max, theme, onChange }: { value: number; max: number; theme: CanvasTheme; onChange: (value: number | null) => void }) {
    return (
        <label className="col-span-2 flex h-9 overflow-hidden rounded-full border text-sm" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
            <input
                type="number"
                min={1}
                max={max}
                className="min-w-0 flex-1 bg-transparent px-3 text-center outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                style={{ color: theme.node.text, WebkitTextFillColor: theme.node.text }}
                value={value || ""}
                onChange={(event) => onChange(Number(event.target.value) || null)}
                onMouseDown={(event) => event.stopPropagation()}
            />
        </label>
    );
}

function AspectIcon({ width, height, color }: { width: number; height: number; color: string }) {
    if (!width || !height) return null;
    const ratio = width / height;
    const boxWidth = ratio >= 1 ? 24 : Math.max(10, 24 * ratio);
    const boxHeight = ratio >= 1 ? Math.max(10, 24 / ratio) : 24;
    return (
        <span className="grid h-7 w-9 place-items-center">
            <span className="border-2" style={{ width: boxWidth, height: boxHeight, borderColor: color }} />
        </span>
    );
}

function SettingTitle({ children, color }: { children: string; color: string }) {
    return (
        <div className="text-xs font-medium" style={{ color }}>
            {children}
        </div>
    );
}

function alignDimension(value: number, enabled: boolean) {
    return enabled ? Math.ceil(value / DIMENSION_STEP) * DIMENSION_STEP : value;
}
