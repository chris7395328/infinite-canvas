import { fileTypeFromBlob } from "file-type";

/** A generic transport MIME is not a video type; inspect content before saving it. */
export async function normalizeVideoResultBlob(blob: Blob): Promise<Blob> {
    const mime = blob.type.split(";", 1)[0].trim().toLowerCase();
    if (!blob.size) throw new Error("后台视频文件为空；暂存结果未释放，未重新生成。");
    if (mime.startsWith("video/")) return blob;
    if (mime && !["application/octet-stream", "binary/octet-stream"].includes(mime)) throw new Error("后台响应不是视频文件，可能仅包含任务ID或错误信息；暂存结果未释放，未重新生成。");
    let detected;
    try { detected = await fileTypeFromBlob(blob); } catch { /* Reject unrecognized/truncated binary data. */ }
    if (!detected?.mime.startsWith("video/")) throw new Error("后台二进制响应无法识别为视频；暂存结果未释放，未重新生成。");
    return new Blob([blob], { type: detected.mime });
}
