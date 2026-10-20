import { Alert, Button, Form, Input, Select, Switch } from "antd";
import { useState } from "react";
import { defaultTencentVodConfig, TENCENT_VOD_BASE_URL, TENCENT_VOD_VERSIONS } from "@/lib/tencent-vod";
import { createModelChannel, defaultSeedanceConfig, modelOptionsFromChannels, resolveChannelSeedanceConfig, useConfigStore, type ModelChannel } from "@/stores/use-config-store";
import { getTencentVodScript } from "@/services/api/model-plugin";

export function ConfigTencentVod() {
    const { config, updateConfig } = useConfigStore();
    const [selectedId, setSelectedId] = useState("");
    const channels = config.channels.filter((channel) => channel.apiFormat === "tencent-vod");
    const channel = channels.find((item) => item.id === selectedId) || channels[0];
    const vod = { ...defaultTencentVodConfig, ...channel?.tencentVod };
    const cos = channel ? resolveChannelSeedanceConfig(config, channel) : defaultSeedanceConfig;
    const saveChannels = (next: ModelChannel[]) => { updateConfig("channels", next); updateConfig("models", modelOptionsFromChannels(next)); };
    const patch = (patch: Partial<ModelChannel>) => { if (channel) saveChannels(config.channels.map((item) => item.id === channel.id ? { ...item, ...patch } : item)); };
    const updateVod = <K extends keyof typeof vod>(key: K, value: (typeof vod)[K]) => patch({ tencentVod: { ...vod, [key]: value } });
    const updateCos = <K extends keyof typeof cos>(key: K, value: (typeof cos)[K]) => patch({ seedance: { ...cos, [key]: value } });
    const addChannel = () => {
        const added = createModelChannel({ name: "腾讯VOD国际站 WAND-Vega", apiFormat: "tencent-vod", baseUrl: TENCENT_VOD_BASE_URL, tencentVod: { ...defaultTencentVodConfig }, seedance: { ...defaultSeedanceConfig, bridgeUrl: config.proxyUrl }, models: TENCENT_VOD_VERSIONS.map((name) => ({ name, capability: "video", script: getTencentVodScript() })) });
        saveChannels([...config.channels, added]);
        setSelectedId(added.id);
    };
    const copyCos = (id: string) => {
        const source = config.channels.find((item) => item.id === id);
        if (!source) return;
        const from = resolveChannelSeedanceConfig(config, source);
        patch({ seedance: { ...cos, cosEnabled: from.cosEnabled, cosBucket: from.cosBucket, cosEndpoint: from.cosEndpoint, cosPublicBaseUrl: from.cosPublicBaseUrl, cosObjectPrefix: from.cosObjectPrefix, cosSecretId: from.cosSecretId, cosSecretKey: from.cosSecretKey } });
    };
    return <Form layout="vertical" requiredMark={false} className="space-y-4">
        <div className="flex flex-wrap items-center gap-3"><Select className="min-w-64 flex-1" placeholder="选择腾讯VOD渠道" value={channel?.id} options={channels.map((item) => ({ value: item.id, label: item.name }))} onChange={setSelectedId} /><Button onClick={addChannel}>添加腾讯VOD海外渠道</Button></div>
        <Alert type="info" showIcon message="ModelName 固定为 wand-vega-video，所选模型名作为 ModelVersion" description="预置1.0-pro／fast／mini（对标2.0）与1.5-pro（对标2.5），不请求/models。国际站按接入文档创建人像素材，无需国内站活体认证；不开放未明确支持的草稿和固定镜头参数。" />
        {!channel ? <Alert type="info" message="请先添加腾讯VOD渠道" /> : <>
            <Alert type="warning" showIcon message="凭据保存在当前浏览器，生成时仅发送给你配置的Docker代理" description="导出的配置文件也包含密钥，请妥善保管。请启用本地代理并使用HTTPS及访问控制。不会把密钥写入脚本或Docker任务文件。" />
            <div className="grid gap-4 md:grid-cols-2">
                <Form.Item label="VOD SecretId" className="mb-0"><Input.Password value={vod.secretId} onChange={(event) => updateVod("secretId", event.target.value)} /></Form.Item>
                <Form.Item label="VOD SecretKey" className="mb-0"><Input.Password value={vod.secretKey} onChange={(event) => updateVod("secretKey", event.target.value)} /></Form.Item>
                <Form.Item label="SubAppId" className="mb-0"><Input value={vod.subAppId} onChange={(event) => updateVod("subAppId", event.target.value)} /></Form.Item>
                <Form.Item label="VOD素材组ID" extra="仅用于本VOD应用，不能填火山／Pixmax素材组ID；按文档可自定义。" className="mb-0"><Input value={vod.groupId} onChange={(event) => updateVod("groupId", event.target.value)} /></Form.Item>
                <Form.Item label="VOD素材入库（人像推荐保持开启）" className="mb-0"><Switch checked={vod.usePrivateAssets} onChange={(value) => updateVod("usePrivateAssets", value)} /></Form.Item>
                <Form.Item label="提示词优化（默认关闭）" className="mb-0"><Switch checked={vod.enhancePrompt} onChange={(value) => updateVod("enhancePrompt", value)} /></Form.Item>
            </div>
            <div className="text-sm font-semibold">COS素材上传</div>
            <Select className="w-full" value={undefined} placeholder="从已有渠道复制COS配置（只复制，不修改来源）" options={config.channels.filter((item) => item.id !== channel.id && item.seedance?.cosBucket).map((item) => ({ value: item.id, label: item.name }))} onChange={copyCos} />
            <div className="grid gap-4 md:grid-cols-2">
                <Form.Item label="启用COS上传" className="mb-0"><Switch checked={cos.cosEnabled} onChange={(value) => updateCos("cosEnabled", value)} /></Form.Item>
                <Form.Item label="代理地址" extra="Docker使用同域 /canvas-proxy，须同时启用本地代理。" className="mb-0"><Input value={cos.bridgeUrl} onChange={(event) => updateCos("bridgeUrl", event.target.value)} /></Form.Item>
                {([ ["cosBucket", "Bucket"], ["cosEndpoint", "上传Endpoint"], ["cosPublicBaseUrl", "公网访问基址（可选）"], ["cosObjectPrefix", "对象前缀"] ] as const).map(([key, label]) => <Form.Item key={key} label={label} className="mb-0"><Input value={cos[key]} onChange={(event) => updateCos(key, event.target.value)} /></Form.Item>)}
                <Form.Item label="COS SecretId（不是VOD SecretId）" className="mb-0"><Input.Password value={cos.cosSecretId} onChange={(event) => updateCos("cosSecretId", event.target.value)} /></Form.Item>
                <Form.Item label="COS SecretKey" className="mb-0"><Input.Password value={cos.cosSecretKey} onChange={(event) => updateCos("cosSecretKey", event.target.value)} /></Form.Item>
            </div>
            <div className="text-xs text-stone-500">生成流程：画布素材 → 已配置COS → 此VOD应用的素材库 → 视频生成 → Docker保存成片24小时。节点可设置分辨率、时长、首尾帧／全参考、音轨、水印、Seed、返回尾帧，以及1.5-pro的视频编辑／延长。改价及费用统计继续使用各模型自己的设置。</div>
        </>}
    </Form>;
}
