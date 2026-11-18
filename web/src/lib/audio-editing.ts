import WavEncoder from "wav-encoder";

export async function decodeAudioFile(blob: Blob) {
    // A fixed output sample rate keeps browser decoding independent of the sound device.
    return new OfflineAudioContext(1, 1, 48000).decodeAudioData(await blob.arrayBuffer());
}

export function audioFrameAt(fraction: number, length: number) {
    return Math.round(Math.max(0, Math.min(1, fraction)) * length);
}

export function audioWaveform(audio: AudioBuffer, start = 0, end = audio.length) {
    const bars = Math.min(192, end - start);
    const peaks = Array<number>(bars).fill(0);
    for (let channel = 0; channel < audio.numberOfChannels; channel++) {
        const samples = audio.getChannelData(channel);
        for (let bar = 0; bar < bars; bar++) {
            const left = start + Math.floor(bar * (end - start) / bars);
            const right = start + Math.floor((bar + 1) * (end - start) / bars);
            let peak = peaks[bar];
            for (let frame = left; frame < right; frame++) peak = Math.max(peak, Math.abs(samples[frame]));
            peaks[bar] = Math.min(1, peak);
        }
    }
    return peaks.map((peak) => Math.round(peak * 255));
}

export async function encodeAudioClip(audio: AudioBuffer, start = 0, end = audio.length) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= end || end > audio.length) throw new RangeError("Invalid audio range");
    const channelData = Array.from({ length: audio.numberOfChannels }, (_, channel) => audio.getChannelData(channel).subarray(start, end));
    const encoded = await WavEncoder.encode({ sampleRate: audio.sampleRate, channelData });
    return {
        blob: new Blob([encoded], { type: "audio/wav" }),
        durationMs: Math.round((end - start) * 1000 / audio.sampleRate),
        audioPeaks: audioWaveform(audio, start, end),
    };
}
