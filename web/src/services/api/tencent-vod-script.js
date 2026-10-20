// 腾讯VOD国际站 WAND-Vega；粘贴到模型调用脚本。模型名是文档中的ModelVersion。
// SecretId/SecretKey/SubAppId读取当前渠道「腾讯VOD」设置，不要写入脚本。
if (!tencentVod?.secretId || !tencentVod?.secretKey || !tencentVod?.subAppId) throw new Error("请先在腾讯VOD设置中填写当前渠道的SecretId、SecretKey和SubAppId");
if (!["1.0-pro", "1.0-pro-fast", "1.0-pro-mini", "1.5-pro"].includes(model)) throw new Error("请选择腾讯VOD文档中的模型版本");
if (baseUrl.replace(/\/+$/, "") !== "https://vod.intl.tencentcloudapi.com") throw new Error("本脚本仅用于文档中的腾讯VOD国际站地址，尚未发送凭据");
const proxy = seedance.bridgeUrl?.replace(/\/+$/, "");
if (!proxy) throw new Error("请开启本地代理并设置同域Docker代理地址");
const identity = await globalThis.fetch(proxy + "/", { signal, cache: "no-store" });
if (!identity.ok || (await identity.json()).tencentVod !== 1) throw new Error("请同时更新app和proxy镜像以支持腾讯VOD，尚未提交生成");
async function source(file) {
    if (typeof file === "string") return file;
    return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("读取参考素材失败，尚未提交生成"));
        reader.readAsDataURL(file);
    });
}
const references = [];
for (const [kind, files] of [["image", images], ["video", videos], ["audio", audios]]) {
    for (const file of files) references.push({ kind, source: await source(file) });
}
const response = await fetch(proxy + "/tencent-vod/video", { method: "POST", headers: { "Content-Type": "application/json" }, signal, body: JSON.stringify({ model, prompt, references, params, tencentVod, cos: {
    cosEnabled: seedance.cosEnabled, cosBucket: seedance.cosBucket, cosEndpoint: seedance.cosEndpoint,
    cosSecretId: seedance.cosSecretId, cosSecretKey: seedance.cosSecretKey, cosPublicBaseUrl: seedance.cosPublicBaseUrl, cosObjectPrefix: seedance.cosObjectPrefix,
} }) });
if (!response.ok) throw new Error(await response.text());
const result = await response.blob();
if (!result.size || /json|text\//i.test(result.type)) throw new Error("VOD后台尚未返回有效视频文件，请查询原任务，不要盲目重新生成");
return result;
