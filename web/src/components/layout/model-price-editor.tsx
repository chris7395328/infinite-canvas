import { Alert, Button, Form, InputNumber, Modal, Radio } from "antd";
import { useState } from "react";
import { normalizeModelPrice } from "@/lib/generation-cost";
import type { ChannelModel } from "@/stores/use-config-store";
import type { ModelPrice } from "@/types/generation-cost";

export function ModelPriceEditor({ model, onSave, onClose }: { model: ChannelModel; onSave: (price?: ModelPrice) => void; onClose: () => void }) {
    const [unit, setUnit] = useState<ModelPrice["unit"]>(model.price?.unit || "request");
    const [amount, setAmount] = useState<string | null>(model.price?.amount || "0");
    const price = normalizeModelPrice({ unit, amount: amount || "" });
    return (
        <Modal open title={`${model.name} · 金额设置`} width={440} onCancel={onClose} footer={[
            <Button key="clear" onClick={() => { onSave(undefined); onClose(); }}>取消计价</Button>,
            <Button key="cancel" onClick={onClose}>返回</Button>,
            <Button key="save" type="primary" disabled={!price} onClick={() => { onSave(price); onClose(); }}>确定</Button>,
        ]}>
            <Form layout="vertical" className="mt-4">
                <Form.Item label="计价方式">
                    <Radio.Group value={unit} onChange={(event) => setUnit(event.target.value)} options={[{ value: "request", label: "按次" }, { value: "second", label: "按秒", disabled: !["video", "audio"].includes(model.capability) }]} />
                </Form.Item>
                <Form.Item label={`单价（元 / ${unit === "second" ? "秒" : "次"}）`} extra="支持最多 6 位小数；0 表示免费。">
                    <InputNumber<string> className="w-full" stringMode min="0" precision={6} step="0.01" value={amount} onChange={setAmount} />
                </Form.Item>
            </Form>
            <Alert type="info" showIcon message="提交时按节点参数预记费，成功领取后确认，失败取消" description="每个已提交请求按一次计价；音视频按秒使用节点设置的固定时长，不读取成片时长。自动或未指定时长暂不能估算。修改单价只影响之后发起的生成。确定后还需保存渠道设置。" />
        </Modal>
    );
}
