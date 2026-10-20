import { Alert, AutoComplete, Button, Checkbox, Form, InputNumber, Modal, Radio, Select } from "antd";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { normalizeModelPrice, normalizeResolutionPrices } from "@/lib/generation-cost";
import type { ChannelModel } from "@/stores/use-config-store";
import type { ModelPrice, ResolutionPrice } from "@/types/generation-cost";

export function ModelPriceEditor({ model, onSave, onClose }: { model: ChannelModel; onSave: (pricing: Pick<ChannelModel, "price" | "resolutionPrices">) => void; onClose: () => void }) {
    const tiered = ["image", "video"].includes(model.capability);
    const canUseSeconds = ["video", "audio"].includes(model.capability);
    const [useDefault, setUseDefault] = useState(!tiered || Boolean(model.price));
    const [unit, setUnit] = useState<ModelPrice["unit"]>(canUseSeconds ? model.price?.unit || "request" : "request");
    const [amount, setAmount] = useState<string | null>(model.price?.amount || "0");
    const [rows, setRows] = useState<ResolutionPrice[]>(normalizeResolutionPrices(model.resolutionPrices, model.capability));
    const price = normalizeModelPrice({ unit, amount: amount || "" });
    const prices = normalizeResolutionPrices(rows, model.capability);
    const valid = (!useDefault || Boolean(price)) && prices.length === rows.length;
    const resolutions = model.capability === "video" ? ["480p", "720p", "1080p", "1440p", "2160p", "auto"] : ["512", "1K", "2K", "4K", "auto"];
    const patchRow = (index: number, patch: Partial<ResolutionPrice>) => setRows((current) => current.map((row, at) => at === index ? { ...row, ...patch } : row));
    const units: Array<{ value: ModelPrice["unit"]; label: string }> = [{ value: "request", label: "元 / 次" }, ...(canUseSeconds ? [{ value: "second" as const, label: "元 / 秒" }] : [])];
    return (
        <Modal open title={`${model.name} · 金额设置`} width={tiered ? 620 : 440} onCancel={onClose} footer={[
            <Button key="clear" onClick={() => { onSave({ price: undefined, resolutionPrices: undefined }); onClose(); }}>取消计价</Button>,
            <Button key="cancel" onClick={onClose}>返回</Button>,
            <Button key="save" type="primary" disabled={!valid} onClick={() => { onSave({ price: useDefault ? price : undefined, resolutionPrices: prices.length ? prices : undefined }); onClose(); }}>确定</Button>,
        ]}>
            <Form layout="vertical" className="mt-4">
                {tiered ? <div className="mb-5 space-y-3">
                    <div className="text-sm">按生成分辨率设置单价</div>
                    {rows.map((row, index) => <div key={index} className="flex flex-wrap items-center gap-2">
                        <AutoComplete className="w-40" aria-label={`分辨率 ${index + 1}`} value={row.resolution} options={resolutions.map((value) => ({ value, label: value === "auto" ? "auto（自动）" : value }))} placeholder="选择或输入分辨率" onChange={(resolution) => patchRow(index, { resolution })} />
                        <InputNumber<string> className="min-w-28 flex-1" aria-label={`分辨率单价 ${index + 1}`} stringMode min="0" precision={6} step="0.01" value={row.amount || null} onChange={(value) => patchRow(index, { amount: value ?? "" })} />
                        <Select className="w-28" aria-label={`计价单位 ${index + 1}`} value={row.unit} options={units} onChange={(value) => patchRow(index, { unit: value })} />
                        <Button type="text" danger aria-label={`删除分辨率 ${index + 1}`} icon={<Trash2 className="size-4" />} onClick={() => setRows((current) => current.filter((_, at) => at !== index))} />
                    </div>)}
                    <Button type="dashed" icon={<Plus className="size-4" />} onClick={() => setRows((current) => [...current, { resolution: resolutions.find((value) => !prices.some((entry) => entry.resolution === value)) || "", amount: "0", unit: model.capability === "video" ? "second" : "request" }])}>添加分辨率</Button>
                    <div className="text-xs text-stone-500">{model.capability === "video" ? "视频可分别按秒或按次定价；4K 等同 2160p。" : "图片按次定价；可设置 512、1K、2K、4K，或输入精确像素（如 1024x1024），精确像素价优先。"} 此处仅设置费用，不改变模型生成参数。单价最多 6 位小数，0 表示免费。</div>
                    {prices.length !== rows.length ? <Alert type="warning" showIcon message="请填写有效分辨率和单价；同一分辨率不能重复，图片仅按次计价。" /> : null}
                    <Checkbox checked={useDefault} onChange={(event) => setUseDefault(event.target.checked)}>未匹配分辨率时使用通用单价</Checkbox>
                </div> : null}
                {useDefault ? <>
                <Form.Item label={tiered ? "通用计价方式" : "计价方式"}>
                    <Radio.Group value={unit} onChange={(event) => setUnit(event.target.value)} options={units.map((option) => ({ value: option.value, label: option.value === "second" ? "按秒" : "按次" }))} />
                </Form.Item>
                <Form.Item label={`${tiered ? "通用" : ""}单价（元 / ${unit === "second" ? "秒" : "次"}）`} extra="支持最多 6 位小数；0 表示免费。">
                    <InputNumber<string> className="w-full" stringMode min="0" precision={6} step="0.01" value={amount} onChange={setAmount} />
                </Form.Item>
                </> : null}
            </Form>
            <Alert type="info" showIcon message="提交时按节点参数预记费，成功领取后确认，失败取消" description="按秒使用节点固定时长，不读取成片时长。没有匹配价格或未指定固定时长时显示未定价，不按免费处理。历史记录保留提交时的分辨率及价格。确定后还需保存渠道设置。" />
        </Modal>
    );
}
