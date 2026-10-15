// 粘贴到此中转站的视频模型「调用脚本」。API只有30秒、多图参考；不发送model或火山草稿参数。
// 本地/远程参考图先暂存你的COS，随后以images[]文件字节提交；该站不接受COS URL。
const endpoint = new URL(baseUrl);
if (endpoint.origin !== "https://43.254.166.145") throw new Error("渠道地址须为文档中的 https://43.254.166.145；尚未发送令牌。");
if (!apiKey?.trim()) throw new Error("请在此渠道填写用户访问令牌；尚未创建任务。");
const cleanPrompt = prompt.trim();
if (Array.from(cleanPrompt).length < 1 || Array.from(cleanPrompt).length > 3000) throw new Error("提示词须为1～3000个Unicode字符。");
if (Number(params.seconds) !== 30) throw new Error("此站只支持30秒，请将视频节点时长设置为30秒；尚未创建任务。");
if (images.length && params.mode === "frames") throw new Error("此站只支持普通参考图，不支持首帧/首尾帧模式；请切换全参考。");
if (videos.length || audios.length) throw new Error("此站仅支持参考图片，不接受参考视频或音频。");
if (images.length > 9) throw new Error("此站最多接收9张参考图。");
const ratio = String(params.ratio || "");
if (!["16:9", "9:16", "1:1", "3:4", "4:3", "21:9"].includes(ratio)) throw new Error("请在视频节点选择16:9、9:16、1:1、3:4、4:3或21:9画幅。");

const probe = http.url("/models");
const marker = probe.indexOf("/" + endpoint.origin + "/");
if (marker < 0) throw new Error("请启用本地代理，任务必须由Docker后台保存与查询。");
const proxy = probe.slice(0, marker);
const health = await fetch(proxy + "/", { signal, cache: "no-store" });
if (!health.ok || !(await health.json()).multipartContentLength) throw new Error("当前Docker代理未支持此站所需的multipart Content-Length；请先更新app/proxy镜像，尚未创建任务。");

function completeCos(value) {
  return value?.cosEnabled === true && ["cosBucket", "cosEndpoint", "cosSecretId", "cosSecretKey"]
    .every(key => typeof value[key] === "string" && value[key].trim());
}
function cosSettings() {
  if (completeCos(seedance)) return seedance;
  let saved;
  try { saved = JSON.parse(globalThis.localStorage?.getItem("infinite-canvas:ai_config_store") || "null")?.state?.config; }
  catch { /* 下方给出明确提示 */ }
  const official = (Array.isArray(saved?.channels) ? saved.channels : [])
    .filter(channel => /^https:\/\/ark\.cn-beijing\.volces\.com\/api\/v3\/?$/i.test(channel.baseUrl || "") && completeCos(channel.seedance));
  if (official.length > 1) throw new Error("有多个已配置COS的火山官方渠道，请在当前中转渠道指定COS配置；尚未上传素材。");
  if (official.length === 1) return official[0].seedance;
  if (completeCos(saved?.seedance)) return saved.seedance;
  throw new Error("未找到完整的COS配置。请在当前渠道或同站点的火山官方渠道填写Bucket、Endpoint、Secret ID/Key；尚未上传素材。");
}
function proxyUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("参考图须为可读取的HTTP/HTTPS地址或画布本地图片。");
  return proxy + "/" + url.href;
}
async function imageFile(value, index) {
  let file = value;
  if (!(file instanceof Blob)) {
    if (typeof value !== "string") throw new Error("参考图片" + (index + 1) + "无法读取。");
    const address = /^https?:\/\//i.test(value) ? proxyUrl(value) : value;
    const response = await globalThis.fetch(address, { signal, cache: "no-store" });
    if (!response.ok) throw new Error("参考图片" + (index + 1) + "读取失败（HTTP " + response.status + "），尚未创建任务。");
    file = await response.blob();
  }
  if (!file.size) throw new Error("参考图片" + (index + 1) + "为空。");
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const png = bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte);
  const jpeg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!png && !jpeg) throw new Error("参考图片" + (index + 1) + "须为完整的JPG或PNG文件，不接受其他格式。");
  let bitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new Error("参考图片" + (index + 1) + "无法解码，请换用有效JPG/PNG。"); }
  const valid = bitmap.width <= 8192 && bitmap.height <= 8192 && bitmap.width * bitmap.height <= 40000000;
  bitmap.close();
  if (!valid) throw new Error("参考图片" + (index + 1) + "超过8192边长或4000万像素限制。");
  return { file: new Blob([file], { type: png ? "image/png" : "image/jpeg" }), extension: png ? "png" : "jpg" };
}
async function uploadCos(file, index, cos) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("参考图片" + (index + 1) + "读取失败。"));
    reader.readAsDataURL(file);
  });
  const response = await globalThis.fetch(proxy + "/seedance/cos-upload", {
    method: "POST", signal, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataUrl, kind: "image", seedance: {
      cosEnabled: cos.cosEnabled, cosBucket: cos.cosBucket, cosEndpoint: cos.cosEndpoint,
      cosSecretId: cos.cosSecretId, cosSecretKey: cos.cosSecretKey,
      cosPublicBaseUrl: cos.cosPublicBaseUrl, cosObjectPrefix: cos.cosObjectPrefix,
    } }),
  });
  const result = /application\/json/i.test(response.headers.get("content-type") || "") ? await response.json() : null;
  if (!response.ok || !result?.url) throw new Error(result?.error || "参考图片" + (index + 1) + "上传COS失败；尚未创建视频任务。");
}

const files = [];
let total = 0;
for (let index = 0; index < images.length; index++) {
  const item = await imageFile(images[index], index);
  total += item.file.size;
  if (total > 20971520) throw new Error("参考图片合计不能超过20 MiB；尚未创建任务。");
  files.push(item);
}
if (files.length) {
  const cos = cosSettings();
  for (let index = 0; index < files.length; index++) await uploadCos(files[index].file, index, cos);
}
const form = new FormData();
form.append("prompt", cleanPrompt);
form.append("ratio", ratio);
form.append("seconds", "30");
files.forEach((item, index) => form.append("images[]", item.file, "reference-" + (index + 1) + "." + item.extension));

const idempotencyKey = "canvas-" + crypto.randomUUID();
const receipt = "infinite-canvas:video-idempotency:" + idempotencyKey;
try { globalThis.localStorage.setItem(receipt, JSON.stringify({ createdAt: Date.now(), provider: endpoint.origin })); }
catch { throw new Error("无法在浏览器保存幂等键，尚未提交付费任务；请检查此站点的本地存储。"); }
// Content-Type由浏览器生成multipart边界，Docker按完整请求体补Content-Length。
// 原POST仅提交一次；Docker每10秒查询同一task_id，刷新不会重新运行脚本。
const result = await request({
  method: "post", url: proxy + "/" + endpoint.origin + "/api/v1/videos",
  headers: {
    Authorization: "Bearer " + apiKey.trim(),
    "Idempotency-Key": idempotencyKey,
    "x-canvas-video-protocol": "json-video",
    "x-canvas-video-public-result": "1",
    "x-canvas-require-content-length": "1",
  },
  data: form, responseType: "blob",
});
if (!(result instanceof Blob) || !result.size || /json|text\//i.test(result.type)) throw new Error("未领取到有效视频；保留原任务与幂等键核对，不要盲目重新生成。");
globalThis.localStorage.removeItem(receipt);
return result;
