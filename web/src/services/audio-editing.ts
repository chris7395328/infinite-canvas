import { decodeAudioFile, encodeAudioClip } from "@/lib/audio-editing";
import { withLocalProxy } from "@/stores/use-config-store";
import { getMediaBlob, uploadMediaFile } from "@/services/file-storage";

export async function loadCanvasAudio(content: string, storageKey?: string, signal?: AbortSignal) {
    const cached = storageKey ? await getMediaBlob(storageKey) : null;
    signal?.throwIfAborted();
    if (cached) return decodeAudioFile(cached);
    const response = await fetch(withLocalProxy(content), { signal });
    if (!response.ok) throw new Error("Audio file unavailable");
    return decodeAudioFile(await response.blob());
}

export async function storeCanvasAudio(audio: AudioBuffer, start?: number, end?: number) {
    const { blob, durationMs, audioPeaks } = await encodeAudioClip(audio, start, end);
    return { ...await uploadMediaFile(blob, "audio", { knownAudioDurationMs: durationMs }), audioPeaks };
}
