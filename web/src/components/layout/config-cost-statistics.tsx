import { Alert, Button, DatePicker, Select, Statistic, Table, Tabs } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { filterCostRecords, formatCost, generationCostMicros } from "@/lib/generation-cost";
import { useGenerationCostStore } from "@/stores/use-generation-cost-store";
import type { GenerationCostRecord } from "@/types/generation-cost";

const capabilityNames = { image: "图片", video: "视频", audio: "音频", text: "文字" };

export function ConfigCostStatistics({ active }: { active: boolean }) {
    const { records, loading, error, load } = useGenerationCostStore();
    const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>([dayjs().startOf("month"), dayjs()]);
    const [channelId, setChannelId] = useState<string>();
    useEffect(() => { if (active) void load(); }, [active, load]);
    const filtered = useMemo(() => filterCostRecords(records, range?.[0]?.startOf("day").valueOf(), range?.[1]?.add(1, "day").startOf("day").valueOf()).filter((record) => !channelId || record.channelId === channelId), [records, range, channelId]);
    const successful = filtered.filter((record) => record.status === "success");
    const pending = filtered.filter((record) => record.status === "pending");
    const unpriced = filtered.filter((record) => record.status !== "cancelled" && generationCostMicros(record) === undefined);
    const total = successful.reduce((sum, record) => sum + (generationCostMicros(record) || 0), 0);
    const estimated = pending.reduce((sum, record) => sum + (generationCostMicros(record) || 0), 0);
    const groups = useMemo(() => {
        const grouped = new Map<string, { id: string; channel: string; model: string; count: number; seconds: number; amount: number; pending: number; estimated: number; cancelled: number }>();
        for (const record of filtered) {
            const id = JSON.stringify([record.channelId, record.modelName]);
            const group = grouped.get(id) || { id, channel: record.channelName, model: record.modelName, count: 0, seconds: 0, amount: 0, pending: 0, estimated: 0, cancelled: 0 };
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
            <div className="flex flex-wrap items-center gap-2">
                <DatePicker.RangePicker value={range} onChange={setRange} format="YYYY-MM-DD" placeholder={["开始日期", "结束日期"]} presets={[
                    { label: "今天", value: [dayjs(), dayjs()] },
                    { label: "最近 7 天", value: [dayjs().subtract(6, "day"), dayjs()] },
                    { label: "本月", value: [dayjs().startOf("month"), dayjs()] },
                    { label: "最近 30 天", value: [dayjs().subtract(29, "day"), dayjs()] },
                ]} />
                <Select className="min-w-40" allowClear placeholder="全部渠道" value={channelId} onChange={setChannelId} options={[...new Map(records.map((record) => [record.channelId, { value: record.channelId, label: record.channelName }])).values()]} />
                <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void load()}>刷新</Button>
            </div>
            {error ? <Alert type="error" showIcon message={error} /> : null}
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                <Statistic title="成功确认费用（元）" value={formatCost(total)} prefix="¥" />
                <Statistic title="待确认预计费用（元）" value={formatCost(estimated)} prefix="¥" />
                <Statistic title="成功 / 待确认" value={`${successful.length} / ${pending.length}`} suffix="次" />
                <Statistic title="失败已取消" value={filtered.filter((record) => record.status === "cancelled").length} suffix="次" />
            </div>
            {unpriced.length ? <Alert type="info" showIcon message={`${unpriced.length} 次请求未设置单价或使用自动/未指定时长，暂不能计算金额。历史记录保留提交时的价格和参数，不随之后的设置改变。`} /> : null}
            <Tabs items={[
                { key: "models", label: "模型汇总", children: <Table size="small" rowKey="id" loading={loading} dataSource={groups} scroll={{ x: 650 }} locale={{ emptyText: "所选日期范围内暂无记录" }} columns={[
                    { title: "渠道", dataIndex: "channel" }, { title: "模型", dataIndex: "model" },
                    { title: "成功次数", dataIndex: "count" },
                    { title: "成功参数时长", dataIndex: "seconds", render: (value: number) => `${value} 秒` },
                    { title: "确认金额（元）", dataIndex: "amount", render: (value: number) => `¥${formatCost(value)}` },
                    { title: "待确认次数", dataIndex: "pending" },
                    { title: "预计金额（元）", dataIndex: "estimated", render: (value: number) => `¥${formatCost(value)}` },
                    { title: "已取消", dataIndex: "cancelled" },
                ]} /> },
                { key: "details", label: "生成明细", children: <Table<GenerationCostRecord> size="small" rowKey="id" loading={loading} dataSource={[...filtered].sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))} scroll={{ x: 950 }} locale={{ emptyText: "所选日期范围内暂无记录" }} columns={[
                    { title: "提交时间", dataIndex: "submittedAt", render: (value: string) => dayjs(value).format("YYYY-MM-DD HH:mm:ss") },
                    { title: "状态", dataIndex: "status", render: (value: GenerationCostRecord["status"]) => ({ pending: "预计费 / 待确认", success: "成功已确认", cancelled: "失败已取消" })[value] },
                    { title: "渠道", dataIndex: "channelName" }, { title: "模型", dataIndex: "modelName" },
                    { title: "类型", dataIndex: "capability", render: (value: GenerationCostRecord["capability"]) => capabilityNames[value] },
                    { title: "单价", render: (_, record) => record.price ? `${record.price.amount} 元/${record.price.unit === "second" ? "秒" : "次"}` : "未设置" },
                    { title: "节点时长", dataIndex: "seconds", render: (value?: number) => value ? `${value} 秒` : "—" },
                    { title: "金额（元）", render: (_, record) => { if (record.status === "cancelled") return "¥0.00"; const amount = generationCostMicros(record); return amount === undefined ? record.price ? "未指定固定时长" : "未定价" : `¥${formatCost(amount)}`; } },
                ]} /> },
            ]} />
            <div className="text-xs text-stone-500">从本功能更新后新提交的生成开始记录。费用保存在当前浏览器本地，删除节点不删除费用；复制或导入节点不会新增费用。清空浏览器站点数据会删除费用记录。清空日期选择可查看全部日期。</div>
        </div>
    );
}
