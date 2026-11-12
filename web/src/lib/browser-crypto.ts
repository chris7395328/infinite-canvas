import { v4 } from "uuid";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

// getRandomValues is available on ordinary HTTP; never use Math.random for task credentials.
export function randomUUID() {
    if (!globalThis.crypto?.getRandomValues) throw new Error("浏览器不支持安全随机数，请升级浏览器；尚未提交生成。");
    return v4({ rng: () => globalThis.crypto.getRandomValues(new Uint8Array(16)) });
}

export async function sha256Hex(text: string) {
    const data = new TextEncoder().encode(text);
    const hash = globalThis.crypto?.subtle ? await globalThis.crypto.subtle.digest("SHA-256", data) : sha256(data);
    return bytesToHex(new Uint8Array(hash));
}

// An explicit script-local facade keeps saved SHA-256/UUID scripts usable without changing browser globals.
export function scriptCrypto() {
    return {
        randomUUID,
        getRandomValues: <T extends ArrayBufferView>(data: T) => globalThis.crypto.getRandomValues(data),
        subtle: globalThis.crypto?.subtle ?? {
            async digest(algorithm: AlgorithmIdentifier, data: BufferSource) {
                if ((typeof algorithm === "string" ? algorithm : algorithm.name).toUpperCase() !== "SHA-256") throw new DOMException("HTTP脚本兼容层仅支持SHA-256摘要，其他Web Crypto操作请使用HTTPS。", "NotSupportedError");
                const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
                return Uint8Array.from(sha256(bytes)).buffer;
            },
        },
    };
}
