import { Alert, Button, Form, Input, Switch } from "antd";
import { Clapperboard, Plus } from "lucide-react";

import { useConfigStore } from "@/stores/use-config-store";

export function ConfigSeedance({ onAddModels }: { onAddModels: () => void }) {
    const config = useConfigStore((state) => state.config);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const seedance = config.seedance;
    const update = <K extends keyof typeof seedance>(key: K, value: (typeof seedance)[K]) => updateConfig("seedance", { ...seedance, [key]: value });

    return (
        <Form layout="vertical" requiredMark={false}>
            <section className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <div className="flex items-center gap-2 text-sm font-semibold"><Clapperboard className="size-4" />火山方舟 Seedance 官方视频</div>
                        <div className="mt-1 text-xs text-stone-500">支持 Seedance 2.0 与 2.5；本地 bridge 负责 COS 上传、私域素材入库及方舟任务轮询。2.0 的实际模型 ID 以你方舟账户模型列表为准，可在渠道编辑器中替换。</div>
                    </div>
                    <Button type="primary" icon={<Plus className="size-4" />} onClick={onAddModels}>添加官方 Seedance 模型</Button>
                </div>
                <Alert className="mb-4" type="warning" showIcon message="仅连接你信任的代理" description="方舟 AK/SK、COS Secret 保存在浏览器本地，并会发送给配置的代理处理上传与生成。Docker 使用同域代理；服务器部署请使用 HTTPS，并通过反向代理登录或私有网络限制访问。" />
                <div className="grid gap-4 md:grid-cols-2">
                    <Form.Item label="Seedance 代理地址" extra="Docker 自动使用当前网站的 /canvas-proxy；本机默认 127.0.0.1:23210。" className="mb-0"><Input value={seedance.bridgeUrl} onChange={(event) => update("bridgeUrl", event.target.value)} /></Form.Item>
                    <Form.Item label="方舟项目名称" extra="私域素材库所使用的 ProjectName。" className="mb-0"><Input value={seedance.projectName} onChange={(event) => update("projectName", event.target.value)} placeholder="项目名称" /></Form.Item>
                    <Form.Item label="方舟 Access Key ID" className="mb-0"><Input.Password value={seedance.accessKeyId} onChange={(event) => update("accessKeyId", event.target.value)} /></Form.Item>
                    <Form.Item label="方舟 Secret Access Key" className="mb-0"><Input.Password value={seedance.secretAccessKey} onChange={(event) => update("secretAccessKey", event.target.value)} /></Form.Item>
                    <Form.Item label="已有私域素材组 ID（可选）" extra="留空时 bridge 首次使用自动创建一个 AIGC 素材组。" className="mb-0"><Input value={seedance.assetGroupId} onChange={(event) => update("assetGroupId", event.target.value)} /></Form.Item>
                    <Form.Item label="私域素材库"><Switch checked={seedance.usePrivateAssets} onChange={(checked) => update("usePrivateAssets", checked)} checkedChildren="启用" unCheckedChildren="关闭" /></Form.Item>
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
