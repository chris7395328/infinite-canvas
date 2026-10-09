import { useContext, useEffect, useRef, useState } from "react";
import { App, Button, Checkbox, Input, Select } from "antd";
import { geminiAudioCapabilities, geminiAudioReferenceKey, geminiVoiceOptions, normalizeGeminiAudio, resolveGeminiReferenceVoice, type GeminiAudioReference, type GeminiAudioSettings } from "@/lib/gemini-audio";
import { createGeminiVoice, listGeminiVoices, type GeminiVoice } from "@/services/api/gemini-audio";
import { resolveModelChannel, withLocalProxy, type AiConfig } from "@/stores/use-config-store";
import { getMediaBlob } from "@/services/file-storage";
import { CanvasAudioInputsContext } from "@/components/canvas/canvas-audio-inputs";

export function GeminiAudioSettingsPanel({ config, onChange }: { config: AiConfig; onChange: (value: GeminiAudioSettings) => void }) {
    const caps = geminiAudioCapabilities(config.model || config.audioModel)!;
    const references = useContext(CanvasAudioInputsContext);
    const settings = normalizeGeminiAudio(config.model || config.audioModel, config.geminiAudio);
    const update = (key: keyof GeminiAudioSettings, value: string) => onChange({ ...settings, [key]: value });
    const textField = (key: keyof GeminiAudioSettings, label: string, placeholder: string, multiline = false) => (
        <label className="block space-y-1.5 text-xs" key={key}><span>{label}</span>{multiline ? <Input.TextArea autoSize={{ minRows: 3, maxRows: 8 }} value={String(settings[key] || "")} placeholder={placeholder} onChange={(event) => update(key, event.target.value)} /> : <Input value={String(settings[key] || "")} placeholder={placeholder} onChange={(event) => update(key, event.target.value)} />}</label>
    );
    if (caps.kind === "music") return (
        <div className="space-y-3">
            <p className="text-xs leading-5 opacity-70">{caps.clip ? "Lyria Clip：固定30秒音乐片段，MP3输出。" : caps.wav ? "Lyria 3.5：完整歌曲，支持MP3或WAV。" : "Lyria 3 Pro Preview：完整歌曲，MP3输出；官方推荐后续改用3.5，不会自动替换模型。"} 支持连接图片作为音乐灵感参考，不支持参考音频续写或多轮编辑。</p>
            <label className="block space-y-1.5 text-xs"><span>音乐类型</span><Select className="w-full" value={settings.musicMode} onChange={(value) => update("musicMode", value)} options={[{ value: "auto", label: "由提示词决定" }, { value: "instrumental", label: "纯音乐（无人声）" }, { value: "vocals", label: "人声歌曲" }]} /></label>
            {caps.wav ? <label className="block space-y-1.5 text-xs"><span>输出格式</span><Select className="w-full" value={settings.musicFormat} onChange={(value) => update("musicFormat", value)} options={[{ value: "mp3", label: "MP3" }, { value: "wav", label: "WAV（无损）" }]} /></label> : null}
            <p className="text-xs leading-5 opacity-70">下面是音乐创作指令，会组合进提示词，不是独立的精确控制API参数；实际时长、速度及编曲以模型输出为准。</p>
            {textField("musicStyle", "曲风", "如：电影配乐、电子、爵士、国风")}
            {textField("musicMood", "情绪与氛围", "如：温暖、悬疑、史诗、轻松")}
            {textField("musicInstruments", "乐器与编配", "如：钢琴、弦乐、合成器与轻鼓点")}
            <div className="grid grid-cols-2 gap-2">{textField("musicTempo", "期望速度（BPM）", "如：100")}{textField("musicKey", "调性", "如：C大调、A小调")}</div>
            {!caps.clip ? textField("musicDuration", "期望时长（提示词控制）", "如：2分钟，包含前奏、主歌、副歌与尾奏") : null}
            {settings.musicMode !== "instrumental" ? textField("musicLyrics", "指定歌词／歌曲结构", "建议用歌词目标语言填写；可使用 [Verse]、[Chorus]、[Bridge] 分段；留空由模型创作", true) : null}
            <p className="text-xs leading-5 opacity-70">歌词和结构会随生成结果保存在节点。Google会进行版权与安全审核，生成音频带有SynthID水印。</p>
        </div>
    );
    if (references.length) return <GeminiNodeVoiceReplication key={config.model} config={config} settings={settings} references={references} onChange={onChange} />;
    return (
        <div className="space-y-3">
            <p className="text-xs leading-5 opacity-70">{caps.lite ? "Flash-Lite TTS：低延迟语音合成，101种语言。" : "Flash TTS：高表现力语音合成，130种语言。"} 两者使用相同参数，只接受文本，不使用连接的图片或音视频；正文是逐字朗读的台词，不要把导演指令写进台词。</p>
            <label className="block space-y-1.5 text-xs"><span>说话模式</span><Select className="w-full" value={settings.mode} onChange={(value) => update("mode", value)} options={[{ value: "single", label: "单人朗读" }, { value: "dialogue", label: "双人对话（预设音色）" }]} /></label>
            <GeminiVoicePicker key={config.model} config={config} settings={settings} onChange={onChange} />
            {settings.mode === "dialogue" ? <div className="grid grid-cols-2 gap-2">{textField("speaker", "说话人一名称", "甲")}{textField("secondSpeaker", "说话人二名称", "乙")}</div> : null}
            {textField("style", settings.mode === "dialogue" ? "说话人一表演风格" : "表演风格／情绪／语速", "如：轻声、亲切、稍慢；留空保持自然")}
            {settings.mode === "dialogue" ? textField("secondStyle", "说话人二表演风格", "如：活泼、轻快") : null}
            {textField("language", "语言代码（可选）", "留空自动识别；如 zh-CN、en-US、ja-JP")}
            <label className="block space-y-1.5 text-xs"><span>输出编码</span><Select className="w-full" value={settings.encoding} onChange={(value) => update("encoding", value)} options={[{ value: "wav", label: "WAV（推荐，可直接播放）" }, { value: "l16", label: "原始PCM（L16，无文件头）" }, { value: "mulaw", label: "μ-law（电话系统）" }, { value: "alaw", label: "A-law（电话系统）" }]} /></label>
            <label className="block space-y-1.5 text-xs"><span>采样率（Hz）</span><Input type="number" value={settings.sampleRate} placeholder="默认24000；可填16000或8000" onChange={(event) => update("sampleRate", event.target.value)} /></label>
            {settings.encoding !== "wav" ? <p className="text-xs leading-5 opacity-70">原始PCM／电话编码没有WAV文件头，浏览器可能无法预览；将保留原始文件下载，不会冒充MP3。需要直接播放请选择WAV。</p> : null}
            <p className="text-xs leading-5 opacity-70">{settings.mode === "dialogue" ? `正文每行写「${settings.speaker}：台词」或「${settings.secondSpeaker}：台词」，逐句风格可写「${settings.speaker}[轻声]：台词」。` : "正文直接填写台词。"} 可插入官方事件标签 &lt;laugh&gt;（笑）、&lt;sigh&gt;（叹气）、&lt;short pause&gt;（短暂停顿）。不使用GPT的数值语速倍率。</p>
        </div>
    );
}

function GeminiNodeVoiceReplication({ config, settings, references, onChange }: { config: AiConfig; settings: ReturnType<typeof normalizeGeminiAudio>; references: GeminiAudioReference[]; onChange: (value: GeminiAudioSettings) => void }) {
    const { message } = App.useApp();
    const channel = resolveModelChannel(config, config.model);
    const sourceId = settings.replicationSourceNodeId || (references.length === 1 ? references[0].nodeId : "");
    const consentId = settings.replicationConsentNodeId || "";
    const source = references.find((item) => item.nodeId === sourceId);
    const consent = references.find((item) => item.nodeId === consentId);
    const [name, setName] = useState("");
    const [language, setLanguage] = useState(settings.language || "");
    const [authorized, setAuthorized] = useState(false);
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const requestRef = useRef<AbortController | null>(null);
    const scope = JSON.stringify([config.model, channel.id, sourceId, consentId, references.map((item) => [item.nodeId, geminiAudioReferenceKey(item)])]);
    useEffect(() => {
        setAuthorized(false); setConfirming(false); setBusy(false);
        return () => requestRef.current?.abort();
    }, [scope, channel.apiKey, channel.baseUrl]);
    let ready = false;
    try { resolveGeminiReferenceVoice(settings, references, channel.id); ready = true; } catch { /* Missing or changed recordings require explicit creation. */ }
    const select = (key: "replicationSourceNodeId" | "replicationConsentNodeId", value: string) => onChange({ ...settings, mode: "single", [key]: value, replication: undefined });
    const create = async () => {
        if (!source || !consent || source.nodeId === consent.nodeId || !authorized || !name.trim() || busy) return;
        const controller = new AbortController(); requestRef.current = controller; setBusy(true);
        const read = async (reference: GeminiAudioReference) => {
            const stored = reference.audio.storageKey ? await getMediaBlob(reference.audio.storageKey) : null;
            let blob = stored;
            if (!blob) {
                const response = await fetch(withLocalProxy(reference.audio.url), { signal: controller.signal });
                if (!response.ok) throw new Error(`音频节点「${reference.title}」读取失败（${response.status}）。`);
                blob = await response.blob();
            }
            if (!blob.size || !(blob.type || reference.audio.type).startsWith("audio/")) throw new Error(`音频节点「${reference.title}」不是有效音频。`);
            return blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: reference.audio.type });
        };
        try {
            const [sourceAudio, consentAudio] = await Promise.all([read(source), read(consent)]);
            if (controller.signal.aborted) return;
            const voice = await createGeminiVoice(config, { name, language, source: sourceAudio, consent: consentAudio }, controller.signal);
            if (controller.signal.aborted) return;
            onChange({ ...settings, mode: "single", voice: voice.id, language, replicationSourceNodeId: source.nodeId, replicationConsentNodeId: consent.nodeId, replication: { voiceId: voice.id, channelId: channel.id, sourceNodeId: source.nodeId, consentNodeId: consent.nodeId, sourceKey: geminiAudioReferenceKey(source), consentKey: geminiAudioReferenceKey(consent) } });
            setConfirming(false); setAuthorized(false);
            message.success("授权音色已保存到当前节点，可填写台词并生成配音。");
        } catch (error) { if (!controller.signal.aborted) message.error(error instanceof Error ? error.message : "授权音色创建失败"); }
        finally { if (!controller.signal.aborted) setBusy(false); }
    };
    const options = references.map((item) => ({ value: item.nodeId, label: item.title || item.nodeId }));
    return <div className="space-y-3 text-xs">
        <p className="leading-5 opacity-70">已连接音频节点，自动进入授权音色复刻。参考录音与本人授权录音分别使用两条音频入线；不会把录音当成需要朗读的台词。</p>
        <label className="block space-y-1.5"><span>参考录音节点（10–30秒自然人声）</span><Select className="w-full" placeholder="选择参考录音" value={sourceId || undefined} options={options.filter((item) => item.value !== consentId)} onChange={(value) => select("replicationSourceNodeId", value)} /></label>
        <label className="block space-y-1.5"><span>本人授权录音节点（同一位说话人）</span><Select className="w-full" placeholder="请再连接本人授权录音节点并选择" value={consentId || undefined} options={options.filter((item) => item.value !== sourceId)} onChange={(value) => select("replicationConsentNodeId", value)} /></label>
        <p className="leading-5 opacity-70">授权录音请本人朗读：我是此声音的拥有者并授权谷歌使用此声音创建语音合成模型。需本人真实录音，勾选不能代替官方验证。</p>
        {ready ? <>
            <p className="break-all leading-5">已应用授权音色：{settings.replication!.voiceId}</p>
            <label className="block space-y-1.5"><span>配音表演风格／情绪／语速</span><Input.TextArea value={settings.style || ""} placeholder="如：自然、温暖、稍慢" onChange={(event) => onChange({ ...settings, mode: "single", style: event.target.value })} /></label>
            <p className="leading-5 opacity-70">正文填写台词，点击节点生成按钮即可配音。断开音频入线可恢复普通音色选择；更换录音后必须重新授权创建。</p>
            <Button size="small" onClick={() => onChange({ ...settings, replication: undefined })}>重新创建授权音色</Button>
        </> : <>
            <Input value={name} placeholder="自定义音色名称" onChange={(event) => { setName(event.target.value); setConfirming(false); }} />
            <Input value={language} placeholder="语言代码（可选，如 zh-CN）" onChange={(event) => { setLanguage(event.target.value); setConfirming(false); }} />
            <Checkbox checked={authorized} onChange={(event) => { setAuthorized(event.target.checked); setConfirming(false); }}>确认两段录音为同一位成年本人，且本人同意上传Google创建音色</Checkbox>
            {confirming ? <div className="space-y-2">
                <p className="leading-5">将上传上述两个音频节点到Google，可能计费；音色保存在Google项目，官方一年未使用过期。浏览器节点只保存音色ID及来源关联。</p>
                <div className="flex gap-2"><Button size="small" loading={busy} disabled={!authorized} onClick={() => void create()}>确认上传并创建</Button><Button size="small" disabled={busy} onClick={() => setConfirming(false)}>取消</Button></div>
            </div> : <Button size="small" disabled={!source || !consent || source.nodeId === consent.nodeId || !name.trim() || !authorized} onClick={() => setConfirming(true)}>创建并应用授权音色</Button>}
        </>}
    </div>;
}

function GeminiVoicePicker({ config, settings, onChange }: { config: AiConfig; settings: ReturnType<typeof normalizeGeminiAudio>; onChange: (value: GeminiAudioSettings) => void }) {
    const { message, modal } = App.useApp();
    const [voices, setVoices] = useState<GeminiVoice[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [loadedQuery, setLoadedQuery] = useState("");
    const [nextPage, setNextPage] = useState<string>();
    const [search, setSearch] = useState("");
    const [language, setLanguage] = useState("");
    const [filters, setFilters] = useState({ type: "", gender: "", pitch: "", accent: "", context: "" });
    const [busy, setBusy] = useState(false);
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [sample, setSample] = useState("");
    const requestRef = useRef<AbortController | null>(null);
    const confirmationRef = useRef<{ destroy: () => void } | null>(null);
    const query = JSON.stringify([search.trim(), language.trim(), filters]);
    useEffect(() => {
        setVoices([]); setLoaded(false); setLoadedQuery(""); setNextPage(undefined); setSample(""); setBusy(false);
        return () => { requestRef.current?.abort(); confirmationRef.current?.destroy(); };
    }, [config.model, config.channels, settings.mode]);
    useEffect(() => {
        requestRef.current?.abort(); setNextPage(undefined); setBusy(false);
    }, [query]);
    const load = async (append = false) => {
        requestRef.current?.abort();
        const controller = new AbortController(); requestRef.current = controller; setBusy(true);
        try {
            const result = await listGeminiVoices(config, { search: search.trim() || undefined, language_code: language.trim() || undefined, type: settings.mode === "dialogue" ? "prebuilt" : filters.type || undefined, gender: filters.gender || undefined, pitch: filters.pitch || undefined, accent: filters.accent.trim() || undefined, context: filters.context.trim() || undefined, page_token: append && loadedQuery === query ? nextPage : undefined }, controller.signal);
            if (controller.signal.aborted) return;
            setVoices((prev) => append && loadedQuery === query ? [...prev, ...(result.voices || [])] : result.voices || []); setNextPage(result.next_page_token); setLoaded(true); setLoadedQuery(query);
        } catch (error) { if (!controller.signal.aborted) message.error(error instanceof Error ? error.message : "音色库读取失败"); }
        finally { if (!controller.signal.aborted) setBusy(false); }
    };
    const create = () => { confirmationRef.current = modal.confirm({
        title: "确认在Google项目中创建音色？",
        content: "此操作会调用Google官方音色接口，可能计费；描述或录音会上传到Google，并在Google项目保存自定义音色（官方默认一年未使用自动删除）。浏览器本地只保存使用的音色ID。",
        okText: "确认创建", cancelText: "取消",
        onCancel: () => { requestRef.current?.abort(); setBusy(false); },
        onOk: async () => {
            requestRef.current?.abort();
            const controller = new AbortController(); requestRef.current = controller; setBusy(true);
            try {
                const voice = await createGeminiVoice(config, { name, description, language }, controller.signal);
                if (controller.signal.aborted) return;
                setVoices((prev) => [voice, ...prev]); onChange({ ...settings, voice: voice.id });
                setSample(voice.sample_audio?.data ? `data:${voice.sample_audio.mime_type || "audio/wav"};base64,${voice.sample_audio.data}` : "");
                message.success("音色创建成功，已应用到当前节点");
            } catch (error) { if (!controller.signal.aborted) { message.error(error instanceof Error ? error.message : "音色创建失败"); throw error; } }
            finally { if (!controller.signal.aborted) setBusy(false); }
        },
    }); };
    const catalog: GeminiVoice[] = [...new Map([...(loaded ? [] : geminiVoiceOptions.map((item) => ({ id: item.value, display_name: item.value, description: item.label, type: "prebuilt" }))), ...voices].map((voice) => [voice.id, voice])).values()];
    const matches = catalog.filter((voice) => {
        if (settings.mode === "dialogue" && voice.type !== "prebuilt") return false;
        const needle = search.trim().toLocaleLowerCase();
        if (needle && !`${voice.id} ${voice.display_name || ""} ${voice.description || ""}`.toLocaleLowerCase().includes(needle)) return false;
        const criteria = { ...filters, language_code: language, ...(settings.mode === "dialogue" ? { type: "prebuilt" } : {}) };
        return Object.entries(criteria).every(([key, value]) => !value.trim() || String(voice[key as keyof GeminiVoice] || "").toLocaleLowerCase() === value.trim().toLocaleLowerCase());
    });
    const options = matches.map((voice) => ({ value: voice.id, label: `${voice.display_name || voice.id}${voice.language_code ? ` · ${voice.language_code}` : ""}` }));
    const voiceField = (key: "voice" | "secondVoice", title: string) => <label className="block space-y-1.5 text-xs"><span>{title}</span><Select className="w-full" showSearch optionFilterProp="label" value={settings[key]} options={options} onChange={(value) => onChange({ ...settings, [key]: value })} /></label>;
    return <div className="space-y-3">
        {voiceField("voice", settings.mode === "dialogue" ? "说话人一音色" : "音色")}
        {settings.mode === "dialogue" ? voiceField("secondVoice", "说话人二音色") : <label className="block space-y-1.5 text-xs"><span>也可手动填写官方音色ID</span><Input value={settings.voice} placeholder="预设名称、voice_… 或 voicekey_…" onChange={(event) => onChange({ ...settings, voice: event.target.value })} /></label>}
        <details className="text-xs"><summary className="cursor-pointer py-1">官方音色库／自定义音色</summary><div className="mt-2 space-y-2">
            <Input value={search} placeholder="输入即筛选已加载音色，回车搜索官方库" onChange={(event) => setSearch(event.target.value)} onPressEnter={() => void load()} />
            <p className="leading-5 opacity-70">{loaded ? `官方库已加载 ${voices.length} 个，当前匹配 ${options.length} 个。` : `当前匹配 ${options.length} 个预设音色。`}{loadedQuery !== query ? " 点击搜索官方库可获取当前条件下的完整分页结果。" : " 可在上方音色下拉框选择结果。"}</p>
            <Input value={language} placeholder="音色库／创建音色的语言，如 zh-CN" onChange={(event) => { setLanguage(event.target.value); setNextPage(undefined); }} />
            <div className="grid grid-cols-2 gap-2">
                <Select value={filters.gender} onChange={(value) => { setFilters((prev) => ({ ...prev, gender: value })); setNextPage(undefined); }} options={[{ value: "", label: "不限声线性别" }, { value: "female", label: "女性声线" }, { value: "male", label: "男性声线" }, { value: "neutral", label: "中性声线" }]} />
                <Select value={filters.pitch} onChange={(value) => { setFilters((prev) => ({ ...prev, pitch: value })); setNextPage(undefined); }} options={[{ value: "", label: "不限音高" }, { value: "low", label: "低音" }, { value: "medium", label: "中音" }, { value: "high", label: "高音" }]} />
            </div>
            <Input value={filters.accent} placeholder="口音筛选（官方值，如 British）" onChange={(event) => { setFilters((prev) => ({ ...prev, accent: event.target.value })); setNextPage(undefined); }} />
            <Input value={filters.context} placeholder="用途筛选（如 Audiobook、News）" onChange={(event) => { setFilters((prev) => ({ ...prev, context: event.target.value })); setNextPage(undefined); }} />
            {settings.mode === "single" ? <Select className="w-full" value={filters.type} onChange={(value) => { setFilters((prev) => ({ ...prev, type: value })); setNextPage(undefined); }} options={[{ value: "", label: "全部音色来源" }, { value: "prebuilt", label: "官方预设" }, { value: "prompted", label: "文字设计音色" }, { value: "replicated", label: "授权复刻音色" }]} /> : null}
            <div className="flex gap-2"><Button size="small" loading={busy} onClick={() => load()}>{search.trim() || loaded ? "搜索官方音色库" : "获取音色库"}</Button>{nextPage && loadedQuery === query ? <Button size="small" disabled={busy} onClick={() => load(true)}>加载下一页</Button> : null}</div>
            {settings.mode === "single" ? <>
                <p className="leading-5">用文字设计新音色</p>
                <Input value={name} placeholder="自定义音色名称" onChange={(event) => setName(event.target.value)} />
                <Input.TextArea value={description} autoSize={{ minRows: 3, maxRows: 6 }} placeholder="描述年龄感、音色、口音与角色气质，如温暖沉稳的中文男旁白" onChange={(event) => setDescription(event.target.value)} />
                <Button size="small" disabled={busy || !name.trim() || !description.trim()} onClick={create}>创建并应用音色</Button>
                <p className="leading-5 opacity-70">要复刻本人音色，请把参考录音和本人授权录音作为两个音频节点连接到当前节点，参数会自动切换到授权复刻。不在这里重复上传文件。</p>
                {sample ? <audio controls src={sample} className="h-9 w-full" /> : null}
            </> : <p className="leading-5 opacity-70">双人单次合成仅使用预设音色；自定义音色请分别使用单人节点生成。</p>}
        </div></details>
    </div>;
}
