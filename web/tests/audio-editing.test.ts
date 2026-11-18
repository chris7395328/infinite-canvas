import { expect, mock, test } from "bun:test";
import { audioFrameAt, audioWaveform, encodeAudioClip } from "../src/lib/audio-editing";

mock.module("@/i18n", () => ({ default: { t: (key: string) => key } }));
const { pastedFiles } = await import("../src/services/clipboard");

function testBuffer(left: number[], right?: number[]): AudioBuffer {
    const channels = [left, ...(right ? [right] : [])].map((samples) => Float32Array.from(samples));
    return { length: left.length, sampleRate: 48000, numberOfChannels: channels.length, getChannelData: (index: number) => channels[index] } as AudioBuffer;
}

test("stored audio is real PCM16 WAV, not a renamed compressed file", async () => {
    const { blob, durationMs } = await encodeAudioClip(testBuffer(Array(480).fill(0.25)));
    const data = await blob.arrayBuffer();
    const view = new DataView(data);
    expect(blob.type).toBe("audio/wav");
    expect(new TextDecoder().decode(data.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(data.slice(8, 12))).toBe("WAVE");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(480 * 2);
    expect(durationMs).toBe(10);
});

test("crop writes only [start, end) samples in both channels and does not mutate the original", async () => {
    const source = testBuffer([0, 1, 0, 1], [0, -1, 1, 0]);
    const { blob, audioPeaks } = await encodeAudioClip(source, 1, 3);
    const view = new DataView(await blob.arrayBuffer());
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(40, true)).toBe(8);
    expect([44, 46, 48, 50].map((offset) => view.getInt16(offset, true))).toEqual([32767, -32768, 0, 32767]);
    expect(audioPeaks).toEqual([255, 255]);
    expect(Array.from(source.getChannelData(0))).toEqual([0, 1, 0, 1]);
});

test("waveform captures quiet, silent and right-channel peaks; invalid crops are not exported", async () => {
    const source = testBuffer([0, 0.5, 0], [0, 0, -0.25]);
    expect(audioWaveform(source)).toEqual([0, 128, 64]);
    expect(audioFrameAt(-0.1, 100)).toBe(0);
    expect(audioFrameAt(0.25, 100)).toBe(25);
    expect(audioFrameAt(1.1, 100)).toBe(100);
    for (const [start, end] of [[1,1], [2,1], [-1,2], [0,4], [0.5,2]]) await expect(encodeAudioClip(source, start, end)).rejects.toThrow(RangeError);
});

test("native paste reads both direct file lists and file items, not text or paths", () => {
    const audio = new File(["sample"], "source.m4a", { type: "audio/mp4" });
    expect(pastedFiles({ files: [audio] } as unknown as DataTransfer)).toEqual([audio]);
    expect(pastedFiles({ files: [], items: [{ kind: "file", getAsFile: () => audio }, { kind: "string" }] } as unknown as DataTransfer)).toEqual([audio]);
    expect(pastedFiles(null)).toEqual([]);
});
