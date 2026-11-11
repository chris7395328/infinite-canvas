import { Alert, App, Button, DatePicker, Segmented, Select, Statistic, Table, Tabs } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { filterCostRecords, formatCost, generationCostMicros } from "@/lib/generation-cost";
import { useGenerationCostStore } from "@/stores/use-generation-cost-store";
import { useConfigStore } from "@/stores/use-config-store";
import type { GenerationCostRecord } from "@/types/generation-cost";

const capabilityNames = { image: "图片", video: "视频", audio: "音频", text: "文字" };

export function ConfigCostStatistics({ active }: { active: boolean }) {
    const { records, loading, error, load, reprice, repricing } = useGenerationCostStore();
    const { modal, message } = App.useApp();
    const confirmReprice = () => modal.confirm({
        title: "按当前价格重新统计全部历史？",
        content: "将对所有项目、所有日期和素材类型重新计价，不受当前筛选影响。按原提交的分辨率、秒数／次数匹配当前渠道和模型价格；不读取成片时长、不重新生成。已删除渠道／模型的记录保留原价；当前未设置价格或按秒计价却未指定固定时长的记录标为未定价，不当作免费。保留原单价与重算时间，成功／待确认／失败状态不变。",
        okText: "全时间线重新统计", cancelText: "取消",
        onOk: async () => {
            try {
                const result = await reprice(useConfigStore.getState().config.channels);
                message.success(`已重新统计 ${result.updated} 条；跳过已移除渠道／模型 ${result.skipped} 条；其中 ${result.unpriced} 条仍无法计价。`);
            } catch (reason) {
                message.error(reason instanceof Error ? reason.message : String(reason));
                throw reason;
            }
        },
    });
    const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>([dayjs().startOf("month"), dayjs()]);
    const [channelId, setChannelId] = useState<string>();
    const [capability, setCapability] = useState<GenerationCostRecord["capability"] | "all">("all");
    useEffect(() => { if (active) void load(); }, [active, load]);
    const filtered = useMemo(() => filterCostRecords(records, range?.[0]?.startOf("day").valueOf(), range?.[1]?.add(1, "day").startOf("day").valueOf(), capability === "all" ? undefined : capability).filter((record) => !channelId || record.channelId === channelId), [records, range, channelId, capability]);
    const successful = filtered.filter((record) => record.status === "success");
    const pending = filtered.filter((record) => record.status === "pending");
    const unpriced = filtered.filter((record) => record.status !== "cancelled" && generationCostMicros(record) === undefined);
    const total = successful.reduce((sum, record) => sum + (generationCostMicros(record) || 0), 0);
    const estimated = pending.reduce((sum, record) => sum + (generationCostMicros(record) || 0), 0);
    const groups = useMemo(() => {
        const grouped = new Map<string, { id: string; channel: string; model: string; capability: GenerationCostRecord["capability"]; resolution?: string; count: number; seconds: number; amount: number; pending: number; estimated: number; cancelled: number }>();
        for (const record of filtered) {
            const id = JSON.stringify([record.channelId, record.modelName, record.capability, record.resolution]);
            const group = grouped.get(id) || { id, channel: record.channelName, model: record.modelName, capability: record.capability, resolution: record.resolution, count: 0, seconds: 0, amount: 0, pending: 0, estimated: 0, cancelled: 0 };
            const amount = generationCostMicros(record) || 0;
            if (record.status === "success") { group.count++; group.seconds += record.seconds || 0; group.amount += amount; }
            else if (record.status === "pending") { group.pending++; group.estimated += amount; }
            else group.cancelled++;
            grouped.set(id, group);
        }
        return [...grouped.values()];
    }, [filtered]);
    return (
        <div className="space-y-4">
            <div className="text-xs text-stone-500">提交请求时按节点参数预记费，前端成功接收并保存结果后确认，失败则取消。按次计算已提交次数，按秒使用节点设置的时长；不读取成片时长。日期按提交时间筛选，金额单位为人民币。</div>
            <Segmented<GenerationCostRecord["capability"] | "all"> value={capability} onChange={setCapability} options={[{ value: "all", label: "全部类型" }, { value: "video", label: "视频" }, { value: "image", label: "图片" }, { value: "audio", label: "音频" }, { value: "text", label: "文字" }]} />
            <div className="flex flex-wrap items-center gap-2">
                <DatePicker.RangePicker value={range} onChange={setRange} format="YYYY-MM-DD" placeholder={["开始日期", "结束日期"]} presets={[
                    { label: "今天", value: [dayjs(), dayjs()] },
                    { label: "最近 7 天", value: [dayjs().subtract(6, "day"), dayjs()] },
                    { label: "本月", value: [dayjs().startOf("month"), dayjs()] },
                    { label: "最近 30 天", value: [dayjs().subtract(29, "day"), dayjs()] },
                ]} />
                <Select className="min-w-40" allowClear placeholder="全部渠道" value={channelId} onChange={setChannelId} options={[...new Map(records.map((record) => [record.channelId, { value: record.channelId, label: record.channelName }])).values()]} />
                <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void load()}>刷新</Button>
                <Button loading={repricing} disabled={loading} onClick={confirmReprice}>按当前价格重新统计</Button>
            </div>
            {error ? <Alert type="error" showIcon message={error} /> : null}
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                <Statistic title="成功确认费用（元）" value={formatCost(total)} prefix="¥" />
                <Statistic title="待确认预计费用（元）" value={formatCost(estimated)} prefix="¥" />
                <Statistic title="成功 / 待确认" value={`${successful.length} / ${pending.length}`} suffix="次" />
                <Statistic title="失败已取消" value={filtered.filter((record) => record.status === "cancelled").length} suffix="次" />
            </div>
            {unpriced.length ? <Alert type="info" showIcon message={`${unpriced.length} 次请求未匹配分辨率价格、未设置通用价或使用自动/未指定时长，暂不能计算金额（不计作免费）。修改价格不会自动改写历史；可通过「按当前价格重新统计」手动更新全时间线。`} /> : null}
            <Tabs items={[
                { key: "models", label: "模型与分辨率汇总", children: <Table size="small" rowKey="id" loading={loading} dataSource={groups} scroll={{ x: 1000 }} locale={{ emptyText: "所选筛选范围内暂无记录" }} columns={[
                    { title: "渠道", dataIndex: "channel" }, { title: "模型", dataIndex: "model" },
                    { title: "类型", dataIndex: "capability", render: (value: GenerationCostRecord["capability"]) => capabilityNames[value] },
                    { title: "提交分辨率", dataIndex: "resolution", render: (value?: string) => value || "—" },
                    { title: "成功次数", dataIndex: "count" },
                    { title: "成功参数时长", dataIndex: "seconds", render: (value: number) => `${value} 秒` },
                    { title: "确认金额（元）", dataIndex: "amount", render: (value: number) => `¥${formatCost(value)}` },
                    { title: "待确认次数", dataIndex: "pending" },
                    { title: "预计金额（元）", dataIndex: "estimated", render: (value: number) => `¥${formatCost(value)}` },
                    { title: "已取消", dataIndex: "cancelled" },
                ]} /> },
                { key: "details", label: "生成明细", children: <Table<GenerationCostRecord> size="small" rowKey="id" loading={loading} dataSource={[...filtered].sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))} scroll={{ x: 1150 }} locale={{ emptyText: "所选筛选范围内暂无记录" }} columns={[
                    { title: "提交时间", dataIndex: "submittedAt", render: (value: string) => dayjs(value).format("YYYY-MM-DD HH:mm:ss") },
                    { title: "状态", dataIndex: "status", render: (value: GenerationCostRecord["status"]) => ({ pending: "预计费 / 待确认", success: "成功已确认", cancelled: "失败已取消" })[value] },
                    { title: "渠道", dataIndex: "channelName" }, { title: "模型", dataIndex: "modelName" },
                    { title: "类型", dataIndex: "capability", render: (value: GenerationCostRecord["capability"]) => capabilityNames[value] },
                    { title: "提交分辨率", render: (_, record) => record.resolution ? `${record.resolution}${record.size && record.size !== "auto" ? ` · ${record.size}` : ""}` : "—" },
                    { title: "单价", render: (_, record) => record.price ? `${record.price.amount} 元/${record.price.unit === "second" ? "秒" : "次"}` : "未设置" },
                    { title: "原单价 / 最近重算", render: (_, record) => record.repricedAt ? <span>{record.originalPrice ? `${record.originalPrice.amount} 元/${record.originalPrice.unit === "second" ? "秒" : "次"}` : "原未定价"}<br />{dayjs(record.repricedAt).format("YYYY-MM-DD HH:mm:ss")}</span> : "未重算" },
                    { title: "节点时长", dataIndex: "seconds", render: (value?: number) => value ? `${value} 秒` : "—" },
                    { title: "金额（元）", render: (_, record) => { if (record.status === "cancelled") return "¥0.00"; const amount = generationCostMicros(record); return amount === undefined ? record.price ? "未指定固定时长" : "未定价" : `¥${formatCost(amount)}`; } },
                ]} /> },
            ]} />
            <div className="text-xs text-stone-500">从本功能更新后新提交的生成开始记录。费用保存在当前浏览器本地，删除节点不删除费用；复制或导入节点不会新增费用。清空浏览器站点数据会删除费用记录。清空日期选择可查看全部日期。</div>
        </div>
    );
}
