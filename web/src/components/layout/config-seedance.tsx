import { Alert, Button, Form, Input, Select, Switch } from "antd";
import { Clapperboard, Plus } from "lucide-react";
import { useState } from "react";

import { createModelChannel, defaultSeedanceConfig, modelOptionsFromChannels, resolveChannelSeedanceConfig, useConfigStore, type ModelChannel } from "@/stores/use-config-store";

const PIXMAX_BASE_URL = "https://openai.pixmax.ai/ai-api/volcengine/api-key/api/v3";
const PIXMAX_MODELS = [
    { name: "dreamina-seedance-2-0-260128", capability: "video" as const, seedanceVersion: "2.0" as const },
    { name: "dreamina-seedance-2-0-fast-260128", capability: "video" as const, seedanceVersion: "2.0" as const },
    { name: "dreamina-seedance-2-0-mini-260615", capability: "video" as const, seedanceVersion: "2.0" as const },
    { name: "dreamina-seedance-2-5-260628", capability: "video" as const, seedanceVersion: "2.5" as const },
];

export function ConfigSeedance({ onAddModels }: { onAddModels: () => void }) {
    const config = useConfigStore((state) => state.config);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const [selectedChannelId, setSelectedChannelId] = useState("");
    const channels = config.channels.filter((item) => item.apiFormat === "volcengine" || /^https:\/\/ark\.cn-beijing\.volces\.com\/api\/v3\/?$/i.test(item.baseUrl));
    const channel = channels.find((item) => item.id === selectedChannelId) || channels[0];
    const seedance = channel ? resolveChannelSeedanceConfig(config, channel) : config.seedance;
    const updateChannels = (next: ModelChannel[]) => {
        updateConfig("channels", next);
        updateConfig("models", modelOptionsFromChannels(next));
    };
    const update = <K extends keyof typeof seedance>(key: K, value: (typeof seedance)[K]) => {
        if (!channel) return;
        updateChannels(config.channels.map((item) => item.id === channel.id ? { ...item, seedance: { ...seedance, [key]: value } } : item));
    };
    const addPixmaxChannel = () => {
        const existing = config.channels.find((item) => item.baseUrl.replace(/\/+$/, "") === PIXMAX_BASE_URL);
        if (existing) {
            const names = new Set(existing.models.map((item) => item.name));
            updateChannels(config.channels.map((item) => item.id === existing.id ? { ...item, models: [...item.models.map((saved) => {
                const preset = PIXMAX_MODELS.find((model) => model.name === saved.name);
                return preset ? { ...saved, capability: "video" as const, seedanceVersion: preset.seedanceVersion } : saved;
            }), ...PIXMAX_MODELS.filter((model) => !names.has(model.name))] } : item));
            setSelectedChannelId(existing.id);
            return;
        }
        const created = createModelChannel({
            name: "Pixmax 海外 Seedance",
            apiFormat: "volcengine",
            baseUrl: PIXMAX_BASE_URL,
            models: PIXMAX_MODELS,
            seedance: { ...defaultSeedanceConfig, bridgeUrl: config.seedance.bridgeUrl, projectName: "default", assetApiUrl: "https://openai.pixmax.ai/ai-api/volcengine/openapi/", assetRegion: "ap-southeast-1" },
        });
        updateChannels([...config.channels, created]);
        setSelectedChannelId(created.id);
    };

    return (
        <Form layout="vertical" requiredMark={false}>
            <section className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <div className="flex items-center gap-2 text-sm font-semibold"><Clapperboard className="size-4" />Seedance 渠道设置</div>
                        <div className="mt-1 text-xs text-stone-500">每个火山协议渠道独立保存 Seedance、私域素材库和 COS 设置；在渠道编辑器添加模型推理点 ID 并标记 2.0 或 2.5。</div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <Button icon={<Plus className="size-4" />} onClick={onAddModels}>添加官方 Seedance 模型</Button>
                        <Button type="primary" icon={<Plus className="size-4" />} onClick={addPixmaxChannel}>添加 Pixmax 海外渠道</Button>
                    </div>
                </div>
                <Form.Item label="当前设置所属渠道" extra="切换后显示该渠道自己的配置；Pixmax 渠道已按接入指引预填四个模型 ID，请在渠道页填入 API Key。其他火山兼容渠道可手动添加模型。" className="mb-4">
                    <Select value={channel?.id} options={channels.map((item) => ({ value: item.id, label: `${item.name} · ${item.baseUrl}` }))} onChange={setSelectedChannelId} placeholder="请先添加火山协议渠道" />
                </Form.Item>
                {!channel ? <Alert type="info" showIcon message="请先在渠道页添加火山方舟协议渠道" /> : null}
                <Alert className="mb-4" type="warning" showIcon message="仅连接你信任的代理" description="方舟 AK/SK、COS Secret 保存在浏览器本地，并会发送给配置的代理处理上传与生成。Docker 使用同域代理；服务器部署请使用 HTTPS，并通过反向代理登录或私有网络限制访问。" />
                <div className="grid gap-4 md:grid-cols-2">
                    <Form.Item label="Seedance 代理地址" extra="Docker 自动使用当前网站的 /canvas-proxy；本机默认 127.0.0.1:23210。" className="mb-0"><Input value={seedance.bridgeUrl} onChange={(event) => update("bridgeUrl", event.target.value)} /></Form.Item>
                    <Form.Item label="方舟项目名称" extra="私域素材库所使用的 ProjectName。" className="mb-0"><Input value={seedance.projectName} onChange={(event) => update("projectName", event.target.value)} placeholder="项目名称" /></Form.Item>
                    <Form.Item label="方舟 Access Key ID" className="mb-0"><Input.Password value={seedance.accessKeyId} onChange={(event) => update("accessKeyId", event.target.value)} /></Form.Item>
                    <Form.Item label="方舟 Secret Access Key" className="mb-0"><Input.Password value={seedance.secretAccessKey} onChange={(event) => update("secretAccessKey", event.target.value)} /></Form.Item>
                    <Form.Item label="已有私域素材组 ID（可选）" extra="留空时 bridge 首次使用自动创建一个 AIGC 素材组。" className="mb-0"><Input value={seedance.assetGroupId} onChange={(event) => update("assetGroupId", event.target.value)} /></Form.Item>
                    <Form.Item label="私域素材库"><Switch checked={seedance.usePrivateAssets} onChange={(checked) => update("usePrivateAssets", checked)} checkedChildren="启用" unCheckedChildren="关闭" /></Form.Item>
                    <Form.Item label="私域素材库 API 地址（可选）" extra="Pixmax 海外： https://openai.pixmax.ai/ai-api/volcengine/openapi/；留空按已知渠道地址自动选择。" className="mb-0"><Input value={seedance.assetApiUrl || ""} onChange={(event) => update("assetApiUrl", event.target.value)} placeholder="留空自动选择" /></Form.Item>
                    <Form.Item label="私域素材库签名区域（可选）" extra="Pixmax 海外为 ap-southeast-1；官方北京为 cn-beijing。" className="mb-0"><Input value={seedance.assetRegion || ""} onChange={(event) => update("assetRegion", event.target.value)} placeholder="留空自动选择" /></Form.Item>
                </div>
            </section>
            <section className="mt-4 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                <div className="mb-3 text-sm font-semibold">腾讯 COS 素材上传</div>
                <div className="mb-3 text-xs text-stone-500">使用私域素材库时，本地参考图片、视频和音频会先上传到可公开读取的 COS URL，再提交方舟入库。</div>
                <div className="mb-4"><Switch checked={seedance.cosEnabled} onChange={(checked) => update("cosEnabled", checked)} checkedChildren="启用 COS" unCheckedChildren="关闭 COS" /></div>
                <div className="grid gap-4 md:grid-cols-2">
                    <Form.Item label="Bucket" className="mb-0"><Input value={seedance.cosBucket} onChange={(event) => update("cosBucket", event.target.value)} placeholder="example-1234567890" /></Form.Item>
                    <Form.Item label="上传 Endpoint" className="mb-0"><Input value={seedance.cosEndpoint} onChange={(event) => update("cosEndpoint", event.target.value)} placeholder="https://{bucket}.cos.ap-singapore.myqcloud.com" /></Form.Item>
                    <Form.Item label="公网访问基址（可选）" className="mb-0"><Input value={seedance.cosPublicBaseUrl} onChange={(event) => update("cosPublicBaseUrl", event.target.value)} placeholder="留空则使用上传 Endpoint" /></Form.Item>
                    <Form.Item label="对象前缀" className="mb-0"><Input value={seedance.cosObjectPrefix} onChange={(event) => update("cosObjectPrefix", event.target.value)} /></Form.Item>
                    <Form.Item label="COS Secret ID" className="mb-0"><Input.Password value={seedance.cosSecretId} onChange={(event) => update("cosSecretId", event.target.value)} /></Form.Item>
                    <Form.Item label="COS Secret Key" className="mb-0"><Input.Password value={seedance.cosSecretKey} onChange={(event) => update("cosSecretKey", event.target.value)} /></Form.Item>
                </div>
            </section>
        </Form>
    );
}
