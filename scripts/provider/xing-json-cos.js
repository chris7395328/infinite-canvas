// 粘贴到同渠道各视频模型的「调用脚本」；model读取当前选中的完整模型ID。
// 沿用933的JSON接口，参考素材只向中转站提交公网URL，不提交文件/Base64。
const COS_SOURCE_CHANNEL_ID = ""; // 多套COS时填写来源渠道ID；只有一套新加坡COS时留空。

if (!model.trim() || !apiKey.trim()) throw new Error("请先选择模型并填写此渠道API Key，尚未创建任务。");
if (!prompt.trim()) throw new Error("请填写提示词，尚未创建任务。");
const duration = Number(params.seconds);
if (!Number.isInteger(duration) || duration !== -1 && duration <= 0) throw new Error("时长须为正整数秒或-1自动时长，尚未创建任务。");
const endpoint = new URL(baseUrl);
if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error("无效的渠道地址。");
const createUrl = http.url("/videos/generations");
const marker = createUrl.indexOf("/" + endpoint.origin + "/");
if (marker < 0) throw new Error("请启用自己的本地代理，由本机／Docker后台查询并保存视频；尚未上传或生成。");
const proxy = createUrl.slice(0, marker);

function completeCos(value) {
  return value?.cosEnabled === true && ["cosBucket", "cosEndpoint", "cosSecretId", "cosSecretKey"]
    .every(key => typeof value[key] === "string" && value[key].trim());
}
function cosSettings() {
  let saved;
  try { saved = JSON.parse(globalThis.localStorage?.getItem("infinite-canvas:ai_config_store") || "null")?.state?.config; }
  catch { /* 下方显示明确错误，不猜测密钥 */ }
  if (COS_SOURCE_CHANNEL_ID) {
    const selected = saved?.channels?.find(channel => channel.id === COS_SOURCE_CHANNEL_ID)?.seedance;
    if (!completeCos(selected)) throw new Error("指定来源渠道的COS配置不完整，尚未上传或生成。");
    return selected;
  }
  if (completeCos(seedance)) return seedance;
  const unique = new Map();
  for (const value of [...(saved?.channels || []).map(channel => channel.seedance), saved?.seedance]) {
    if (completeCos(value)) unique.set(JSON.stringify([value.cosBucket.trim(), value.cosEndpoint.trim(), value.cosSecretId.trim(), value.cosSecretKey.trim()]), value);
  }
  if (unique.size !== 1) throw new Error(unique.size ? "存在多套COS，请填写脚本COS_SOURCE_CHANNEL_ID或在当前渠道绑定COS；尚未上传或生成。" : "未找到完整COS配置，请启用已有新加坡COS并填写Bucket、Endpoint、Secret ID/Key；尚未上传或生成。");
  return unique.values().next().value;
}
let cos;
async function publicUrl(value, kind) {
  if (typeof value === "string" && /^https?:\/\//i.test(value)) {
    const url = new URL(value);
    if (url.username || url.password) throw new Error("参考素材URL不能含用户名或密码。");
    return value; // 保留签名参数及原始顺序，不下载后重复上传。
  }
  let dataUrl = value;
  if (value instanceof Blob) {
    dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("参考素材读取失败，尚未创建任务。"));
      reader.readAsDataURL(value);
    });
  }
  if (typeof dataUrl !== "string" || !/^data:[^,]*;base64,/i.test(dataUrl)) throw new Error("参考素材须为画布本地文件或公网HTTP/HTTPS直链，不接受其他渠道的asset ID。");
  cos ||= cosSettings();
  // 用原生fetch调用自己的代理：上传准备不产生生成回执，不会把COS密钥发送给中转站。
  const response = await globalThis.fetch(proxy + "/seedance/cos-upload", {
    method: "POST", signal, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataUrl, kind, seedance: {
      cosEnabled: cos.cosEnabled, cosBucket: cos.cosBucket, cosEndpoint: cos.cosEndpoint,
      cosSecretId: cos.cosSecretId, cosSecretKey: cos.cosSecretKey,
      cosPublicBaseUrl: cos.cosPublicBaseUrl, cosObjectPrefix: cos.cosObjectPrefix,
    } }),
  });
  const raw = await response.text();
  let result;
  try { result = JSON.parse(raw); } catch { result = {}; }
  if (!response.ok || !/^https?:\/\//i.test(result.url || "")) throw new Error("COS上传失败（HTTP " + response.status + "）：" + (result.error || "未返回有效公网URL") + "；尚未创建视频任务。");
  return result.url;
}

const body = {
  model, prompt, duration,
  resolution: String(params.resolution || "720p").toLowerCase(),
  ratio: !params.ratio || params.ratio === "auto" ? "16:9" : params.ratio,
  n: 1,
};
for (const [kind, files, field] of [["image", images, "images"], ["video", videos, "videos"], ["audio", audios, "audios"]]) {
  if (!files.length) continue;
  body[field] = [];
  for (const file of files) body[field].push(await publicUrl(file, kind));
}
if (typeof params.generateAudio === "boolean") body.generate_audio = params.generateAudio;
// 所有图片均为reference_image语义；不伪装成首尾帧，不发送官方私域库／草稿字段。
// 唯一一次生成POST。后台每10秒GET /videos/{id}，不因浏览器刷新重新提交。
const blob = await http.post("/videos/generations", body, {
  headers: { "x-canvas-video-protocol": "json-video", "x-canvas-video-public-result": "1" },
  responseType: "blob",
});
if (!(blob instanceof Blob) || !blob.size || /json|text\//i.test(blob.type)) throw new Error("后台未返回可领取的视频文件；请查询原任务，不要自动重新生成。");
return { blob };
