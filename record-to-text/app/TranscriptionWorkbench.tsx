"use client";

import {
  ChangeEvent,
  DragEvent,
  KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  baseName,
  DEFAULT_COMPRESSION_TARGET_MB,
  DEFAULT_MINIMUM_BITRATE_KBPS,
  formatBytes,
  OPENAI_FILE_LIMIT,
  recommendedTargetMb,
  validateAudio,
} from "./lib/audio";
import {
  AudioProcessingProgress,
  cancelAudioProcessing,
  compressAudioForUpload,
  repairAudioAsFlac,
} from "./lib/audioProcessing";
import {
  ChunkingStrategy,
  ResponseFormat,
  TimestampGranularity,
  friendlyError,
  getTranscriptionRequestPreview,
  transcribeAudio,
} from "./lib/transcription";

const DEFAULT_PROMPT =
  "这是中文语音转写。请正确识别以下词汇：OpenAI、Whisper、API。";

const RESPONSE_FORMAT_LABELS: Record<ResponseFormat, string> = {
  json: "JSON · 纯文字",
  text: "Text · 纯文字",
  srt: "SRT · 字幕",
  verbose_json: "Verbose JSON · 含时间信息",
  vtt: "VTT · 字幕",
  diarized_json: "Diarized JSON · 说话人分段",
};

const LOGPROB_MODELS = new Set([
  "gpt-4o-transcribe",
  "gpt-4o-mini-transcribe",
]);

function splitHints(value: string): string[] {
  return [...new Set(value.split(/[，,\n]/).map((item) => item.trim()).filter(Boolean))];
}

function responseFormatsFor(model: string): ResponseFormat[] {
  if (model === "gpt-4o-transcribe-diarize") return ["diarized_json"];
  if (model === "gpt-4o-transcribe" || model === "gpt-4o-mini-transcribe") {
    return ["json"];
  }
  if (model === "whisper-1") {
    return ["json", "text", "srt", "vtt", "verbose_json"];
  }
  return ["json", "text"];
}

type Status = "idle" | "ready" | "uploading" | "done" | "error";
type AudioToolStatus = "idle" | "loading" | "processing" | "done" | "error";

const statusCopy: Record<Status, string> = {
  idle: "等待音频",
  ready: "准备就绪",
  uploading: "正在转写",
  done: "转写完成",
  error: "需要处理",
};

export function TranscriptionWorkbench() {
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [originalFile, setOriginalFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState("");
  const [targetSizeMb, setTargetSizeMb] = useState(DEFAULT_COMPRESSION_TARGET_MB);
  const [minimumBitrateKbps, setMinimumBitrateKbps] = useState(DEFAULT_MINIMUM_BITRATE_KBPS);
  const [audioToolStatus, setAudioToolStatus] = useState<AudioToolStatus>("idle");
  const [audioToolProgress, setAudioToolProgress] = useState(0);
  const [audioToolMessage, setAudioToolMessage] = useState("");
  const [model, setModel] = useState("gpt-transcribe");
  const [languageHints, setLanguageHints] = useState("zh");
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [keywords, setKeywords] = useState("");
  const [temperature, setTemperature] = useState(0);
  const [chunkingStrategy, setChunkingStrategy] = useState<ChunkingStrategy>("auto");
  const [vadThreshold, setVadThreshold] = useState(0.5);
  const [vadPrefixPaddingMs, setVadPrefixPaddingMs] = useState(300);
  const [vadSilenceDurationMs, setVadSilenceDurationMs] = useState(200);
  const [responseFormat, setResponseFormat] = useState<ResponseFormat>("json");
  const [includeLogprobs, setIncludeLogprobs] = useState(false);
  const [stream, setStream] = useState(false);
  const [wordTimestamps, setWordTimestamps] = useState(false);
  const [segmentTimestamps, setSegmentTimestamps] = useState(true);
  const [speakerDiarization, setSpeakerDiarization] = useState(false);
  const [includeTimestamps, setIncludeTimestamps] = useState(true);
  const [transcript, setTranscript] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => {
    abortRef.current?.abort();
    cancelAudioProcessing();
  }, []);

  const acceptFile = (nextFile?: File) => {
    if (!nextFile) return;
    const validation = validateAudio(nextFile);
    setFileError(validation || "");
    setFile(validation ? null : nextFile);
    setOriginalFile(validation ? null : nextFile);
    setTargetSizeMb(recommendedTargetMb(nextFile.size));
    setAudioToolStatus("idle");
    setAudioToolProgress(0);
    setAudioToolMessage("");
    setTranscript("");
    setMessage("");
    setStatus(validation ? "error" : "ready");
  };

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    acceptFile(event.target.files?.[0]);
    event.target.value = "";
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    acceptFile(event.dataTransfer.files?.[0]);
  };

  const handleDropKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      inputRef.current?.click();
    }
  };

  const updateAudioToolProgress = (progress: AudioProcessingProgress) => {
    setAudioToolStatus(progress.stage);
    setAudioToolProgress(progress.progress);
    setAudioToolMessage(progress.message);
  };

  const compressSelectedAudio = async () => {
    if (!file) return;
    setAudioToolStatus("loading");
    setAudioToolProgress(0);
    setAudioToolMessage("正在准备浏览器音频处理器…");
    try {
      const result = await compressAudioForUpload(
        file,
        targetSizeMb,
        minimumBitrateKbps,
        updateAudioToolProgress,
      );
      setFile(result.file);
      setFileError("");
      setAudioToolStatus("done");
      setAudioToolProgress(1);
      setAudioToolMessage(
        `已转为单声道 Opus VBR：目标平均 ${result.targetBitrateKbps} kbps，` +
        `${formatBytes(file.size)} → ${formatBytes(result.file.size)}。`,
      );
      setStatus("ready");
      setMessage("");
      setTranscript("");
    } catch (error) {
      setAudioToolStatus("error");
      setAudioToolMessage(error instanceof Error ? error.message : "音频压缩失败。");
    }
  };

  const repairSelectedAudio = async () => {
    if (!file) return;
    setAudioToolStatus("loading");
    setAudioToolProgress(0);
    setAudioToolMessage("正在准备浏览器音频处理器…");
    try {
      const repairedFile = await repairAudioAsFlac(file, updateAudioToolProgress);
      setFile(repairedFile);
      setFileError("");
      setAudioToolStatus("done");
      setAudioToolProgress(1);
      setAudioToolMessage(
        `已重新解码并无损编码为 FLAC：${formatBytes(file.size)} → ${formatBytes(repairedFile.size)}。`,
      );
      setStatus("ready");
      setMessage("");
      setTranscript("");
    } catch (error) {
      setAudioToolStatus("error");
      setAudioToolMessage(error instanceof Error ? error.message : "音频修复失败。");
    }
  };

  const cancelProcessing = () => {
    cancelAudioProcessing();
    setAudioToolStatus("idle");
    setAudioToolProgress(0);
    setAudioToolMessage("已取消。再次处理时需要重新加载音频核心。");
  };

  const restoreOriginalAudio = () => {
    if (!originalFile) return;
    setFile(originalFile);
    setAudioToolStatus("idle");
    setAudioToolProgress(0);
    setAudioToolMessage("已恢复最初选择的文件。");
    setStatus("ready");
  };

  const downloadProcessedAudio = () => {
    if (!file) return;
    const href = URL.createObjectURL(file);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = file.name;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(href), 0);
  };

  const effectiveModel = speakerDiarization
    ? "gpt-4o-transcribe-diarize"
    : model;
  const availableResponseFormats = responseFormatsFor(effectiveModel);
  const effectiveResponseFormat = availableResponseFormats.includes(responseFormat)
    ? responseFormat
    : availableResponseFormats[0];
  const effectiveChunkingStrategy: ChunkingStrategy =
    effectiveModel === "whisper-1"
      ? "single"
      : speakerDiarization && chunkingStrategy === "single"
        ? "auto"
        : chunkingStrategy;
  const supportsStreaming =
    effectiveModel !== "whisper-1" &&
    ["json", "diarized_json"].includes(effectiveResponseFormat);
  const supportsLogprobs =
    LOGPROB_MODELS.has(effectiveModel) && effectiveResponseFormat === "json";
  const supportsWhisperTimestamps =
    effectiveModel === "whisper-1" && effectiveResponseFormat === "verbose_json";
  const timestampGranularities: TimestampGranularity[] = supportsWhisperTimestamps
    ? [
        ...(wordTimestamps ? (["word"] as TimestampGranularity[]) : []),
        ...(segmentTimestamps ? (["segment"] as TimestampGranularity[]) : []),
      ]
    : [];

  const requestOptionsFor = (selectedFile: File) => ({
    file: selectedFile,
    model: effectiveModel,
    languages: splitHints(languageHints),
    prompt,
    keywords: splitHints(keywords),
    temperature,
    chunkingStrategy: effectiveChunkingStrategy,
    vadThreshold,
    vadPrefixPaddingMs,
    vadSilenceDurationMs,
    responseFormat: effectiveResponseFormat,
    includeLogprobs: includeLogprobs && supportsLogprobs,
    stream: stream && supportsStreaming,
    timestampGranularities,
    speakerDiarization,
    includeTimestamps,
  });
  const requestPreview = file
    ? getTranscriptionRequestPreview(requestOptionsFor(file))
    : {
        endpoint: "https://api.openai.com/v1/audio/transcriptions",
        method: "POST",
        body: { file: "[选择录音后显示完整参数]", model: effectiveModel },
      };
  const isAudioProcessing = audioToolStatus === "loading" || audioToolStatus === "processing";
  const fileExceedsUploadLimit = Boolean(file && file.size > OPENAI_FILE_LIMIT);
  const fileWasProcessed = Boolean(file && originalFile && file !== originalFile);
  const canSubmit = Boolean(
    apiKey.trim() &&
    file &&
    !fileExceedsUploadLimit &&
    !isAudioProcessing &&
    status !== "uploading",
  );

  const runTranscription = async () => {
    if (!file || !apiKey.trim()) {
      setMessage("请先填写 API Key 并选择音频文件。");
      setStatus("error");
      return;
    }
    if (file.size > OPENAI_FILE_LIMIT) {
      setMessage("文件仍超过 25 MB。请先使用网页端压缩，或降低目标大小。");
      setStatus("error");
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setStatus("uploading");
    setMessage(
      speakerDiarization
        ? "正在转写并区分说话人。大文件可能需要几分钟。"
        : "正在将音频直接发送至 OpenAI。大文件可能需要几分钟。",
    );
    setTranscript("");

    try {
      const result = await transcribeAudio({
        apiKey,
        ...requestOptionsFor(file),
        onPartialTranscript: stream && supportsStreaming
          ? (partialText) => setTranscript(partialText)
          : undefined,
        signal: controller.signal,
      });
      setTranscript(result);
      setStatus("done");
      setMessage("完成。你可以直接修改文字，或下载为 Markdown。 ");
    } catch (error) {
      setStatus("error");
      setMessage(friendlyError(error));
    } finally {
      abortRef.current = null;
    }
  };

  const copyTranscript = async () => {
    if (!transcript) return;
    await navigator.clipboard.writeText(transcript);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const downloadTranscript = () => {
    if (!transcript) return;
    const blob = new Blob([`${transcript.trim()}\n`], {
      type: "text/markdown;charset=utf-8",
    });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `${baseName(file?.name || "transcript")}.md`;
    anchor.click();
    URL.revokeObjectURL(href);
  };

  const reset = () => {
    abortRef.current?.abort();
    cancelAudioProcessing();
    setFile(null);
    setOriginalFile(null);
    setFileError("");
    setAudioToolStatus("idle");
    setAudioToolProgress(0);
    setAudioToolMessage("");
    setTranscript("");
    setMessage("");
    setStatus("idle");
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="../" aria-label="返回 Henry Huang 主页">
          <span className="brand-name">HENRY<span>.H</span></span>
          <span className="brand-product">/ Whisper Desk</span>
        </a>
        <div className="topbar-actions">
          <div className="privacy-pill">
            <span className="privacy-dot" aria-hidden="true" />
            Key 仅保存在当前页面内存
          </div>
          <a className="home-link" href="../">返回主页</a>
        </div>
      </header>

      <section className="hero" id="top">
        <p className="eyebrow">PERSONAL TOOL / AUDIO TRANSCRIPTION</p>
        <h1>让每一段声音，<br /><em>清晰落在纸上。</em></h1>
        <p className="hero-copy">
          文件准备和结果整理都在浏览器完成。转写时，音频会从你的浏览器直接发送给 OpenAI，不经过自建服务器。
        </p>
        <div className="hero-meta" aria-label="产品特点">
          <span>无需安装</span><span>不保存密钥</span><span>结果可编辑</span>
        </div>
      </section>

      <section className="workspace" aria-label="音频转写工作台">
        <div className="control-column">
          <section className="panel setup-panel">
            <div className="panel-heading">
              <span className="step-number">01</span>
              <div><p className="overline">ACCESS</p><h2>连接 OpenAI</h2></div>
            </div>
            <label className="field-label" htmlFor="api-key">OpenAI API Key</label>
            <div className="key-field">
              <input
                id="api-key"
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="sk-..."
                autoComplete="off"
                spellCheck={false}
              />
              <button type="button" onClick={() => setShowKey((value) => !value)}>
                {showKey ? "隐藏" : "显示"}
              </button>
            </div>
            <p className="field-note">不会写入 Cookie、Local Storage 或项目文件。关闭页面后即清除。</p>
          </section>

          <section className="panel file-panel">
            <div className="panel-heading">
              <span className="step-number">02</span>
              <div><p className="overline">SOURCE</p><h2>选择录音</h2></div>
            </div>
            <input
              ref={inputRef}
              className="visually-hidden"
              type="file"
              accept=".mp3,.mp4,.mpeg,.mpga,.m4a,.flac,.ogg,.wav,.webm,audio/*"
              onChange={handleFileInput}
            />
            <div
              className={`dropzone ${dragging ? "is-dragging" : ""} ${file ? "has-file" : ""}`}
              onClick={() => inputRef.current?.click()}
              onKeyDown={handleDropKey}
              onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              role="button"
              tabIndex={0}
              aria-label="选择或拖放音频文件"
            >
              <span className="drop-glyph" aria-hidden="true">↗</span>
              {file ? (
                <div className="file-summary">
                  <strong>{file.name}</strong>
                  <span>
                    {formatBytes(file.size)} · {fileExceedsUploadLimit ? "需要压缩" : "准备上传"}
                  </span>
                </div>
              ) : (
                <div><strong>把音频拖到这里</strong><span>或点击浏览文件</span></div>
              )}
              <span className="file-limit">MP3 · M4A · FLAC · OGG · WAV · WEBM · API 上限 {formatBytes(OPENAI_FILE_LIMIT)}</span>
            </div>
            {fileError && <p className="error-copy" role="alert">{fileError}</p>}
            {file && (
              <div className="audio-tools" aria-label="浏览器端音频处理">
                <div className="audio-tools-heading">
                  <div>
                    <p className="overline">LOCAL AUDIO LAB</p>
                    <h3>压缩与兼容修复</h3>
                  </div>
                  <span className="local-only-badge">仅在本机处理</span>
                </div>

                <div className="compression-controls">
                  <label>
                    <span>压缩目标</span>
                    <div className="number-suffix-field">
                      <input
                        type="number"
                        min="1"
                        max="24"
                        step="0.5"
                        value={targetSizeMb}
                        disabled={isAudioProcessing}
                        onChange={(event) => setTargetSizeMb(Math.max(1, Math.min(24, Number(event.target.value))))}
                        aria-label="压缩目标大小 MB"
                      />
                      <span>MB</span>
                    </div>
                  </label>
                  <label>
                    <span>最低码率</span>
                    <select
                      value={minimumBitrateKbps}
                      disabled={isAudioProcessing}
                      onChange={(event) => setMinimumBitrateKbps(Number(event.target.value))}
                    >
                      <option value="16">16 kbps · 极长录音</option>
                      <option value="24">24 kbps · 推荐</option>
                      <option value="32">32 kbps · 更清晰</option>
                      <option value="48">48 kbps · 高保真语音</option>
                    </select>
                  </label>
                </div>

                <p className="audio-tool-note">
                  压缩输出为 16 kHz 单声道 WebM/Opus。码率按时长和目标大小计算，采用 VBR 动态分配；
                  最低码率可能使最终文件略大于目标。
                </p>

                <div className="audio-tool-actions">
                  <button
                    className="audio-tool-primary"
                    type="button"
                    disabled={isAudioProcessing}
                    onClick={compressSelectedAudio}
                  >
                    压缩到约 {targetSizeMb} MB
                  </button>
                  <button
                    type="button"
                    disabled={isAudioProcessing}
                    onClick={repairSelectedAudio}
                  >
                    无损修复为 FLAC
                  </button>
                  {isAudioProcessing && (
                    <button type="button" onClick={cancelProcessing}>取消处理</button>
                  )}
                </div>

                <p className="audio-tool-note repair-note">
                  修复会完整解码后重新编码为 FLAC，不会恢复源文件已经丢失的细节，但不会造成第二次有损压缩。
                  FLAC 可能比原文件更大。
                </p>

                {(audioToolMessage || isAudioProcessing) && (
                  <div
                    className={`audio-tool-status ${audioToolStatus === "error" ? "is-error" : ""}`}
                    role={audioToolStatus === "error" ? "alert" : "status"}
                  >
                    {isAudioProcessing && (
                      <progress max="1" value={audioToolProgress || undefined} />
                    )}
                    <span>{audioToolMessage}</span>
                  </div>
                )}

                {fileWasProcessed && !isAudioProcessing && (
                  <div className="processed-file-actions">
                    <button type="button" onClick={downloadProcessedAudio}>下载处理后的音频</button>
                    <button type="button" onClick={restoreOriginalAudio}>恢复原文件</button>
                  </div>
                )}

                <p className="audio-engine-note">
                  首次点击会从 CDN 按需加载约 31 MB 的单线程 ffmpeg.wasm；GitHub Pages 无需后端。
                </p>
              </div>
            )}
          </section>

          <section className="panel settings-panel">
            <div className="panel-heading compact">
              <span className="step-number">03</span>
              <div><p className="overline">DETAILS</p><h2>调整识别</h2></div>
            </div>
            <div className="field-grid">
              <label><span>模型</span>
                <select value={model} onChange={(event) => setModel(event.target.value)}>
                  <option value="gpt-transcribe">OpenAI: GPT Transcribe · 推荐</option>
                  <option value="gpt-4o-mini-transcribe">GPT-4o mini Transcribe</option>
                  <option value="gpt-4o-transcribe">GPT-4o Transcribe</option>
                  <option value="whisper-1">Whisper-1 · 兼容原项目</option>
                </select>
              </label>
              <label><span>返回格式</span>
                <select
                  value={effectiveResponseFormat}
                  disabled={availableResponseFormats.length === 1}
                  onChange={(event) => setResponseFormat(event.target.value as ResponseFormat)}
                >
                  {availableResponseFormats.map((format) => (
                    <option key={format} value={format}>{RESPONSE_FORMAT_LABELS[format]}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="field-grid">
              <label><span>语言提示</span>
                <input
                  type="text"
                  value={languageHints}
                  onChange={(event) => setLanguageHints(event.target.value)}
                  placeholder={effectiveModel === "gpt-transcribe" ? "zh, en" : "zh"}
                  spellCheck={false}
                />
              </label>
              <label><span>音频分段</span>
                <select
                  value={effectiveChunkingStrategy}
                  disabled={effectiveModel === "whisper-1"}
                  onChange={(event) => setChunkingStrategy(event.target.value as ChunkingStrategy)}
                >
                  <option value="auto">自动检测语音 · 推荐</option>
                  {!speakerDiarization && <option value="single">整段处理</option>}
                  <option value="server_vad">手动设置 VAD</option>
                </select>
              </label>
            </div>

            <p className="field-note model-note">
              {effectiveModel === "gpt-transcribe"
                ? "GPT Transcribe 支持多个语言代码（逗号分隔）和关键词提示。"
                : effectiveModel === "whisper-1"
                  ? "Whisper 按整段提交；网页会省略 chunking_strategy，以匹配本地 Python 调用。"
                  : speakerDiarization
                    ? "多人模式固定使用 Diarized JSON，并要求启用语音分段。"
                    : "此模型只使用第一个语言代码，并固定返回 JSON。"}
            </p>

            {effectiveChunkingStrategy === "server_vad" && (
              <div className="vad-settings" aria-label="手动 VAD 参数">
                <p className="subsection-title">语音活动检测 / SERVER VAD</p>
                <div className="vad-grid">
                  <label><span>灵敏度阈值</span>
                    <input
                      type="number"
                      min="0"
                      max="1"
                      step="0.05"
                      value={vadThreshold}
                      onChange={(event) => setVadThreshold(Number(event.target.value))}
                    />
                  </label>
                  <label><span>前置保留 ms</span>
                    <input
                      type="number"
                      min="0"
                      step="50"
                      value={vadPrefixPaddingMs}
                      onChange={(event) => setVadPrefixPaddingMs(Number(event.target.value))}
                    />
                  </label>
                  <label><span>静音判停 ms</span>
                    <input
                      type="number"
                      min="0"
                      step="50"
                      value={vadSilenceDurationMs}
                      onChange={(event) => setVadSilenceDurationMs(Number(event.target.value))}
                    />
                  </label>
                </div>
              </div>
            )}

            {effectiveModel === "gpt-transcribe" && (
              <>
                <label className="field-label" htmlFor="keywords">关键词提示</label>
                <textarea
                  id="keywords"
                  value={keywords}
                  onChange={(event) => setKeywords(event.target.value)}
                  placeholder={"每行一个词或短语，例如：\n产品名称\n人物姓名\n专业术语"}
                  rows={3}
                />
                <p className="field-note">关键词是识别提示，不会强制模型输出；请只填写录音中可能出现的词。</p>
              </>
            )}

            <label className="field-label prompt-label" htmlFor="prompt">上下文提示 / 输出风格</label>
            <textarea
              id="prompt"
              value={prompt}
              disabled={speakerDiarization}
              onChange={(event) => setPrompt(event.target.value)}
              rows={3}
            />

            <div className="recognition-options" aria-label="高级识别选项">
              <label className="option-card" htmlFor="speaker-diarization">
                <input
                  id="speaker-diarization"
                  type="checkbox"
                  aria-label="区分说话人"
                  checked={speakerDiarization}
                  onChange={(event) => setSpeakerDiarization(event.target.checked)}
                />
                <span>
                  <strong>区分说话人</strong>
                  <small>自动识别人数，并标记为说话人 A、B、C…</small>
                </span>
              </label>

              {speakerDiarization && (
                <label className="option-card" htmlFor="include-speaker-timestamps">
                  <input
                    id="include-speaker-timestamps"
                    type="checkbox"
                    aria-label="显示分段时间"
                    checked={includeTimestamps}
                    onChange={(event) => setIncludeTimestamps(event.target.checked)}
                  />
                  <span>
                    <strong>显示分段时间</strong>
                    <small>给每个说话人片段加入开始与结束时间</small>
                  </span>
                </label>
              )}

              <label
                className={`option-card ${supportsStreaming ? "" : "is-disabled"}`}
                htmlFor="stream-response"
              >
                <input
                  id="stream-response"
                  type="checkbox"
                  aria-label="流式返回"
                  checked={stream && supportsStreaming}
                  disabled={!supportsStreaming}
                  onChange={(event) => setStream(event.target.checked)}
                />
                <span>
                  <strong>流式返回</strong>
                  <small>边识别边显示文字；Whisper 不支持</small>
                </span>
              </label>

              <label
                className={`option-card ${supportsLogprobs ? "" : "is-disabled"}`}
                htmlFor="include-logprobs"
              >
                <input
                  id="include-logprobs"
                  type="checkbox"
                  aria-label="返回 Logprobs"
                  checked={includeLogprobs && supportsLogprobs}
                  disabled={!supportsLogprobs}
                  onChange={(event) => setIncludeLogprobs(event.target.checked)}
                />
                <span>
                  <strong>返回 Logprobs</strong>
                  <small>仅 GPT-4o Transcribe 系列 JSON 响应支持</small>
                </span>
              </label>

              {supportsWhisperTimestamps && (
                <>
                  <label className="option-card" htmlFor="word-timestamps">
                    <input
                      id="word-timestamps"
                      type="checkbox"
                      aria-label="词级时间戳"
                      checked={wordTimestamps}
                      onChange={(event) => setWordTimestamps(event.target.checked)}
                    />
                    <span><strong>词级时间戳</strong><small>更精细，但会增加处理延迟</small></span>
                  </label>
                  <label className="option-card" htmlFor="segment-timestamps">
                    <input
                      id="segment-timestamps"
                      type="checkbox"
                      aria-label="段落时间戳"
                      checked={segmentTimestamps}
                      onChange={(event) => setSegmentTimestamps(event.target.checked)}
                    />
                    <span><strong>段落时间戳</strong><small>返回每个语音片段的时间范围</small></span>
                  </label>
                </>
              )}
            </div>
            <div className="temperature-row">
              <label htmlFor="temperature">随机度</label>
              <input id="temperature" type="range" min="0" max="1" step="0.1" value={temperature} onChange={(event) => setTemperature(Number(event.target.value))} />
              <output>{temperature.toFixed(1)}</output>
            </div>
            <p className="field-note temperature-note">0 更专注、结果更确定；数值越高，模型输出的随机性越大。</p>
          </section>

          <details className="request-preview">
            <summary>
              <span>查看提交给模型的参数</span>
              <small>JSON / 已隐藏 API Key 与音频内容</small>
            </summary>
            <pre><code>{JSON.stringify(requestPreview, null, 2)}</code></pre>
          </details>

          <div className="action-row">
            <button className="primary-button" type="button" disabled={!canSubmit} onClick={runTranscription}>
              {status === "uploading" ? <><span className="spinner" />正在转写</> : <>开始转写 <span aria-hidden="true">→</span></>}
            </button>
            {status === "uploading" ? (
              <button className="text-button" type="button" onClick={() => abortRef.current?.abort()}>取消</button>
            ) : file ? (
              <button className="text-button" type="button" onClick={reset}>重新选择</button>
            ) : null}
          </div>
        </div>

        <section className="transcript-panel" aria-live="polite">
          <div className="transcript-toolbar">
            <div>
              <p className="overline">TRANSCRIPT</p>
              <h2>转写稿</h2>
            </div>
            <div className={`status-badge status-${status}`}><span />{statusCopy[status]}</div>
          </div>

          {status === "uploading" && (
            <div className="processing-card">
              <div className="wave" aria-hidden="true">{[1,2,3,4,5,6,7,8,9].map((bar) => <i key={bar} />)}</div>
              <strong>正在听取你的录音…</strong>
              <span>请保持页面开启</span>
            </div>
          )}

          {transcript ? (
            <>
              <textarea
                className="transcript-editor"
                aria-label="转写结果"
                value={transcript}
                onChange={(event) => setTranscript(event.target.value)}
              />
              <div className="transcript-actions">
                <span>{transcript.length.toLocaleString("zh-CN")} 字符</span>
                <div>
                  <button type="button" onClick={copyTranscript}>{copied ? "已复制" : "复制全文"}</button>
                  <button className="download-button" type="button" onClick={downloadTranscript}>下载 .md</button>
                </div>
              </div>
            </>
          ) : status !== "uploading" ? (
            <div className="empty-transcript">
              <span className="quote-mark" aria-hidden="true">“</span>
              <p>转写结果会出现在这里。</p>
              <span>完成前三步，然后开始转写。</span>
            </div>
          ) : null}

          {message && <p className={`status-message ${status === "error" ? "is-error" : ""}`}>{message}</p>}

          <footer className="transcript-footer">
            <span>音频直接发送至 OpenAI API</span>
            <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">管理 API Key ↗</a>
          </footer>
        </section>
      </section>

      <footer className="page-footer">
        <span>HENRY.H / WHISPER DESK</span>
        <p>为个人、私密且直接的转写工作流而设计。</p>
      </footer>
    </main>
  );
}
