// https://ai.google.dev/gemini-api/docs/speech-generation
// https://ai.google.dev/gemini-api/docs/music-generation
export type GeminiAudioSettings = {
    mode?: "single" | "dialogue";
    voice?: string;
    secondVoice?: string;
    speaker?: string;
    secondSpeaker?: string;
    style?: string;
    secondStyle?: string;
    language?: string;
    encoding?: "wav" | "l16" | "mulaw" | "alaw";
    sampleRate?: string;
    musicFormat?: "mp3" | "wav";
    musicMode?: "auto" | "instrumental" | "vocals";
    musicStyle?: string;
    musicMood?: string;
    musicInstruments?: string;
    musicTempo?: string;
    musicKey?: string;
    musicDuration?: string;
    musicLyrics?: string;
};

export function geminiAudioCapabilities(model: string) {
    const name = model.toLowerCase().split("::").pop()!.replace(/^models\//, "");
    if (/^gemini-3\.8-flash(?:-lite)?-tts$/.test(name)) return { kind: "tts" as const, lite: name.includes("-lite-"), clip: false, wav: true };
    if (["lyria-3-clip-preview", "lyria-3-pro-preview", "lyria-3.5"].includes(name)) return { kind: "music" as const, lite: false, clip: name === "lyria-3-clip-preview", wav: name === "lyria-3.5" };
    return null;
}

export function normalizeGeminiAudio(model: string, value: GeminiAudioSettings = {}) {
    const capabilities = geminiAudioCapabilities(model);
    return {
        ...value,
        mode: value.mode === "dialogue" ? "dialogue" as const : "single" as const,
        voice: value.voice?.trim() || "Kore",
        secondVoice: value.secondVoice?.trim() || "Puck",
        speaker: value.speaker?.trim() || "甲",
        secondSpeaker: value.secondSpeaker?.trim() || "乙",
        encoding: (["wav", "l16", "mulaw", "alaw"] as const).includes(value.encoding!) ? value.encoding! : "wav" as const,
        sampleRate: value.sampleRate ?? "24000",
        musicFormat: capabilities?.wav && value.musicFormat === "wav" ? "wav" as const : "mp3" as const,
        musicMode: value.musicMode || "auto" as const,
    };
}

export const geminiVoiceOptions = [
    ["Zephyr", "明亮"], ["Puck", "欢快"], ["Charon", "讲解"], ["Kore", "坚定"], ["Fenrir", "激昂"], ["Leda", "年轻"],
    ["Orus", "坚定"], ["Aoede", "轻快"], ["Callirrhoe", "随和"], ["Autonoe", "明亮"], ["Enceladus", "气声"], ["Iapetus", "清晰"],
    ["Umbriel", "随和"], ["Algieba", "顺滑"], ["Despina", "顺滑"], ["Erinome", "清晰"], ["Algenib", "沙哑"], ["Rasalgethi", "讲解"],
    ["Laomedeia", "欢快"], ["Achernar", "柔和"], ["Alnilam", "坚定"], ["Schedar", "平稳"], ["Gacrux", "成熟"], ["Pulcherrima", "直接"],
    ["Achird", "友好"], ["Zubenelgenubi", "随性"], ["Vindemiatrix", "温柔"], ["Sadachbia", "活泼"], ["Sadaltager", "博学"], ["Sulafat", "温暖"],
].map(([value, description]) => ({ value, label: `${value} · ${description}` }));

export function geminiAudioSummary(model: string, value?: GeminiAudioSettings) {
    const caps = geminiAudioCapabilities(model);
    const settings = normalizeGeminiAudio(model, value);
    if (!caps) return "";
    return caps.kind === "music" ? `${caps.clip ? "30秒片段" : "完整歌曲"} · ${settings.musicFormat.toUpperCase()}` : `${settings.mode === "dialogue" ? "双人对话" : settings.voice} · ${settings.encoding.toUpperCase()}`;
}
