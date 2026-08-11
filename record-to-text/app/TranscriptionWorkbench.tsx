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
  AudioDiagnosticError,
  AudioDiagnosticReport,
  AudioProcessingProgress,
  STANDARD_TRANSCRIPTION_MAX_SECONDS,
  STANDARD_TRANSCRIPTION_SEGMENT_SECONDS,
  cancelAudioProcessing,
  compressAudioForUpload,
  diagnoseAudioFile,
  prepareAudioSegmentsForUpload,
  repairAudioAsWav,
} from "./lib/audioProcessing";
import {
  ApiProvider,
  ChunkingStrategy,
  ResponseFormat,
  RequestDebugInfo,
  TimestampGranularity,
  UploadProgress,
  friendlyError,
  getTranscriptionRequestPreview,
  mergeTranscriptionSegments,
  transcribeAudio,
} from "./lib/transcription";

const DEFAULT_PROMPT =
  "请忠实转写录音；遇到中文时优先使用简体中文，并正确识别以下词汇：OpenAI、Whisper、API。";

const LANGUAGE_PRESETS = [
  { value: "", label: "自动检测语言" },
  { value: "zh-cn", label: "中文（偏好简体）" },
  { value: "en", label: "英文" },
  { value: "ja", label: "日语" },
  { value: "fr", label: "法语" },
  { value: "it", label: "意大利语" },
  { value: "zh-cn,en", label: "中文 + 英文（多语言）", multiple: true },
  { value: "zh-cn,en,ja,fr,it", label: "中 / 英 / 日 / 法 / 意（多语言）", multiple: true },
] as const;

const RESPONSE_FORMAT_LABELS: Record<ResponseFormat, string> = {
  json: "JSON · 纯文字",
  text: "Text · 纯文字",
  srt: "SRT · 字幕",
  verbose_json: "Verbose JSON · 含时间信息",
  vtt: "VTT · 字幕",
};

const LOGPROB_MODELS = new Set([
  "gpt-4o-transcribe",
  "gpt-4o-mini-transcribe",
]);

const OPENROUTER_SEGMENT_SECONDS = 600;
const PROVIDER_DEFAULT_MODELS: Record<ApiProvider, string> = {
  openai: "gpt-transcribe",
  openrouter: "x-ai/grok-stt-1.0",
};

function splitHints(value: string): string[] {
  return [...new Set(value.split(/[，,\n]/).map((item) => item.trim()).filter(Boolean))];
}

function languageCodes(value: string): string[] {
  return value.split(",").map((code) => code.trim()).filter(Boolean);
}

function formatClock(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const remainder = wholeSeconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function responseFormatsFor(model: string): ResponseFormat[] {
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
type SegmentBatchProgress = {
  current: number;
  total: number;
  fileName: string;
  stage: "preparing" | "uploading" | "processing";
};

const statusCopy: Record<Status, string> = {
  idle: "等待音频",
  ready: "准备就绪",
  uploading: "正在转写",
  done: "转写完成",
  error: "需要处理",
};

export function TranscriptionWorkbench() {
  const [provider, setProvider] = useState<ApiProvider>("openai");
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
  const [audioDiagnostics, setAudioDiagnostics] = useState<AudioDiagnosticReport | null>(null);
  const [requestDebug, setRequestDebug] = useState<RequestDebugInfo | RequestDebugInfo[] | null>(null);
  const [submittedRequestPreviews, setSubmittedRequestPreviews] = useState<Record<string, unknown>[] | null>(null);
  const [diagnosticCopied, setDiagnosticCopied] = useState(false);
  const [model, setModel] = useState("gpt-transcribe");
  const [languagePreset, setLanguagePreset] = useState("zh-cn");
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
  const [includeTimestamps, setIncludeTimestamps] = useState(true);
  const [grokDiarization, setGrokDiarization] = useState(true);
  const [grokTextFormatting, setGrokTextFormatting] = useState(true);
  const [grokFillerWords, setGrokFillerWords] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [segmentBatch, setSegmentBatch] = useState<SegmentBatchProgress | null>(null);
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
    setAudioDiagnostics(null);
    setRequestDebug(null);
    setSubmittedRequestPreviews(null);
    setTranscript("");
    setMessage("");
    setUploadProgress(null);
    setSegmentBatch(null);
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
      setAudioDiagnostics(result.diagnostics);
      setFileError("");
      setAudioToolStatus("done");
      setAudioToolProgress(1);
      setAudioToolMessage(
        `已转为单声道 MP3 ABR：目标平均 ${result.targetBitrateKbps} kbps，` +
        `${formatBytes(file.size)} → ${formatBytes(result.file.size)}。`,
      );
      setStatus("ready");
      setMessage("");
      setTranscript("");
    } catch (error) {
      if (error instanceof AudioDiagnosticError) setAudioDiagnostics(error.report);
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
      const result = await repairAudioAsWav(file, updateAudioToolProgress);
      const repairedFile = result.file;
      setFile(repairedFile);
      setAudioDiagnostics(result.diagnostics);
      setFileError("");
      setAudioToolStatus("done");
      setAudioToolProgress(1);
      setAudioToolMessage(
        `已重新解码为兼容 WAV PCM：${formatBytes(file.size)} → ${formatBytes(repairedFile.size)}。`,
      );
      setStatus("ready");
      setMessage("");
      setTranscript("");
    } catch (error) {
      if (error instanceof AudioDiagnosticError) setAudioDiagnostics(error.report);
      setAudioToolStatus("error");
      setAudioToolMessage(error instanceof Error ? error.message : "音频修复失败。");
    }
  };

  const diagnoseSelectedAudio = async () => {
    if (!file) return;
    setAudioToolStatus("loading");
    setAudioToolProgress(0);
    setAudioToolMessage("正在准备完整解码扫描…");
    try {
      const report = await diagnoseAudioFile(file, updateAudioToolProgress);
      setAudioDiagnostics(report);
      setAudioToolStatus("done");
      setAudioToolProgress(1);
      setAudioToolMessage("深度检查通过：整段文件可被 FFmpeg 完整解码，SHA-256 已记录。");
    } catch (error) {
      if (error instanceof AudioDiagnosticError) setAudioDiagnostics(error.report);
      setAudioToolStatus("error");
      setAudioToolMessage(error instanceof Error ? error.message : "深度音频检查失败。");
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
    setAudioDiagnostics(null);
    setRequestDebug(null);
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

  const copyDiagnostics = async () => {
    const debugBundle = {
      local_audio: audioDiagnostics,
      provider_response: requestDebug,
      submitted_request: submittedRequestPreviews || requestPreview,
    };
    await navigator.clipboard.writeText(JSON.stringify(debugBundle, null, 2));
    setDiagnosticCopied(true);
    window.setTimeout(() => setDiagnosticCopied(false), 1600);
  };

  const effectiveModel = model;
  const isOpenRouter = provider === "openrouter";
  const isGrokStt = isOpenRouter && effectiveModel === "x-ai/grok-stt-1.0";
  const speakerDiarization = isGrokStt && grokDiarization;
  const supportsMultipleLanguages = provider === "openai" && effectiveModel === "gpt-transcribe";
  const effectiveLanguagePreset =
    !supportsMultipleLanguages && languagePreset.includes(",")
      ? languagePreset.split(",")[0]
      : languagePreset;
  const requestLanguageCodes = languageCodes(effectiveLanguagePreset).map((code) =>
    !supportsMultipleLanguages && code.startsWith("zh-") ? "zh" : code,
  );
  const requestKeywords = splitHints(keywords);
  const effectiveKeywords = isGrokStt
    ? requestKeywords.slice(0, 100).map((keyword) => keyword.slice(0, 50))
    : requestKeywords;
  const availableResponseFormats = isOpenRouter
    ? (["json"] as ResponseFormat[])
    : responseFormatsFor(effectiveModel);
  const effectiveResponseFormat = availableResponseFormats.includes(responseFormat)
    ? responseFormat
    : availableResponseFormats[0];
  const effectiveChunkingStrategy: ChunkingStrategy =
    isOpenRouter || effectiveModel === "whisper-1"
      ? "single"
      : chunkingStrategy;
  const supportsStreaming =
    !isOpenRouter && effectiveModel !== "whisper-1" && effectiveResponseFormat === "json";
  const supportsLogprobs =
    !isOpenRouter && LOGPROB_MODELS.has(effectiveModel) && effectiveResponseFormat === "json";
  const supportsWhisperTimestamps =
    effectiveModel === "whisper-1" && effectiveResponseFormat === "verbose_json";
  const timestampGranularities: TimestampGranularity[] = supportsWhisperTimestamps
    ? [
        ...(wordTimestamps ? (["word"] as TimestampGranularity[]) : []),
        ...(segmentTimestamps ? (["segment"] as TimestampGranularity[]) : []),
      ]
    : [];
  const automaticSegmentTriggerSeconds = isOpenRouter
    ? OPENROUTER_SEGMENT_SECONDS
    : STANDARD_TRANSCRIPTION_MAX_SECONDS;
  const automaticSegmentDurationSeconds = isOpenRouter
    ? OPENROUTER_SEGMENT_SECONDS
    : STANDARD_TRANSCRIPTION_SEGMENT_SECONDS;

  const requestOptionsFor = (selectedFile: File) => ({
    provider,
    file: selectedFile,
    model: effectiveModel,
    languages: requestLanguageCodes,
    prompt,
    keywords: effectiveKeywords,
    temperature,
    chunkingStrategy: effectiveChunkingStrategy,
    vadThreshold: Math.max(0, Math.min(1, vadThreshold)),
    vadPrefixPaddingMs,
    vadSilenceDurationMs,
    responseFormat: effectiveResponseFormat,
    includeLogprobs: includeLogprobs && supportsLogprobs,
    stream: stream && supportsStreaming,
    timestampGranularities,
    speakerDiarization,
    includeTimestamps,
    grokTextFormatting,
    grokFillerWords,
  });
  const previewFile = file || new File([], "[选择录音后填充音频]", { type: "audio/mpeg" });
  const baseRequestPreview = getTranscriptionRequestPreview(requestOptionsFor(previewFile));
  const requestPreview = {
    ...baseRequestPreview,
    client_side_segmentation: {
      enabled: true,
      trigger_duration_seconds: automaticSegmentTriggerSeconds,
      segment_duration_seconds: automaticSegmentDurationSeconds,
      upload_mode: "sequential",
      segmented_request_streaming: false,
      timestamp_merge: "global_offset",
      note: `仅超限时在浏览器本地物理分段；此对象不会提交给${isOpenRouter ? " OpenRouter" : " OpenAI"}`,
    },
  };
  const isAudioProcessing = audioToolStatus === "loading" || audioToolStatus === "processing";
  const fileExceedsUploadLimit = Boolean(file && file.size > OPENAI_FILE_LIMIT);
  const fileWasProcessed = Boolean(file && originalFile && file !== originalFile);
  const canSubmit = Boolean(
    apiKey.trim() &&
    file &&
    !isAudioProcessing &&
    status !== "uploading",
  );
  const providerName = isOpenRouter ? "OpenRouter" : "OpenAI";
  const roundedUploadPercent = Math.round(uploadProgress?.percent || 0);
  const uploadStageLabel = status === "uploading"
    ? segmentBatch?.stage === "preparing"
      ? "正在本地准备长音频分段"
      : segmentBatch
        ? `第 ${segmentBatch.current}/${segmentBatch.total} 段：${
            segmentBatch.stage === "processing" ? `${providerName} 正在转写` : "正在上传"
          }`
        : roundedUploadPercent >= 100
          ? `上传完成，${providerName} 正在处理音频`
          : `正在上传音频到 ${providerName}`
    : status === "done"
      ? "音频上传完成"
      : status === "error"
        ? roundedUploadPercent >= 100 ? "上传完成，转写阶段出错" : "上传已中断"
        : "等待上传";

  const runTranscription = async () => {
    if (!file || !apiKey.trim()) {
      setMessage("请先填写 API Key 并选择音频文件。");
      setStatus("error");
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus("uploading");
    setRequestDebug(null);
    setSubmittedRequestPreviews(null);
    setSegmentBatch({ current: 0, total: 0, fileName: file.name, stage: "preparing" });
    setUploadProgress({
      loaded: 0,
      total: file.size,
      percent: 0,
      computable: !stream || !supportsStreaming,
    });
    setMessage(
      "正在检查音频时长与大小；超限时会先在浏览器本地分段。",
    );
    setTranscript("");
    let segmentationPreparationComplete = false;
    let usedAutomaticSegmentation = false;

    try {
      const prepared = await prepareAudioSegmentsForUpload(
        file,
        automaticSegmentTriggerSeconds,
        automaticSegmentDurationSeconds,
        updateAudioToolProgress,
      );
      segmentationPreparationComplete = true;
      usedAutomaticSegmentation = prepared.processed;

      if (prepared.processed) {
        const totalUploadBytes = prepared.segments.reduce(
          (sum, segment) => sum + segment.file.size,
          0,
        );
        let completedUploadBytes = 0;
        const completedTranscripts: string[] = [];
        setSubmittedRequestPreviews(
          prepared.segments.map((segment) => ({
            ...getTranscriptionRequestPreview({
              ...requestOptionsFor(segment.file),
              stream: false,
              timestampOffsetSeconds: segment.startSeconds,
            }),
            client_segment: {
              index: segment.index + 1,
              total: segment.total,
              start_seconds: segment.startSeconds,
              duration_seconds: segment.durationSeconds,
            },
          })),
        );

        setAudioToolStatus("done");
        setAudioToolProgress(1);
        setAudioToolMessage(
          `已在浏览器本地处理为 ${prepared.segments.length} 段，` +
          `每段不超过 ${Math.round(automaticSegmentDurationSeconds / 60)} 分钟。`,
        );

        for (const segment of prepared.segments) {
          if (controller.signal.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
          }
          setSegmentBatch({
            current: segment.index + 1,
            total: segment.total,
            fileName: segment.file.name,
            stage: "uploading",
          });
          setMessage(
            `正在处理第 ${segment.index + 1}/${segment.total} 段；请保持页面开启。`,
          );

          const result = await transcribeAudio({
            apiKey,
            ...requestOptionsFor(segment.file),
            stream: false,
            timestampOffsetSeconds: segment.startSeconds,
            onUploadProgress: (progress) => {
              const segmentLoaded = progress.computable
                ? Math.min(progress.loaded, segment.file.size)
                : progress.percent >= 100 ? segment.file.size : 0;
              const loaded = completedUploadBytes + segmentLoaded;
              setUploadProgress({
                loaded,
                total: totalUploadBytes,
                percent: totalUploadBytes > 0
                  ? Math.min(100, (loaded / totalUploadBytes) * 100)
                  : 0,
                computable: progress.computable,
              });
              if (progress.percent >= 100) {
                setSegmentBatch({
                  current: segment.index + 1,
                  total: segment.total,
                  fileName: segment.file.name,
                  stage: "processing",
                });
              }
            },
            onRequestDebug: (debug) => {
              setRequestDebug((previous) => {
                if (!previous) return [debug];
                return Array.isArray(previous) ? [...previous, debug] : [previous, debug];
              });
            },
            signal: controller.signal,
          });
          completedUploadBytes += segment.file.size;
          const section = segment.total > 1
            ? ["srt", "vtt"].includes(effectiveResponseFormat)
              ? result
              : `## 片段 ${segment.index + 1}/${segment.total} · ${formatClock(segment.startSeconds)}–${formatClock(segment.startSeconds + segment.durationSeconds)}\n\n${result}`
            : result;
          completedTranscripts.push(section);
          setTranscript(
            mergeTranscriptionSegments(completedTranscripts, effectiveResponseFormat),
          );
        }
      } else {
        setSegmentBatch(null);
        const result = await transcribeAudio({
          apiKey,
          ...requestOptionsFor(file),
          onPartialTranscript: stream && supportsStreaming
            ? (partialText) => setTranscript(partialText)
            : undefined,
          onUploadProgress: setUploadProgress,
          onRequestDebug: setRequestDebug,
          signal: controller.signal,
        });
        setTranscript(result);
      }
      setStatus("done");
      setSegmentBatch(null);
      setMessage(
        usedAutomaticSegmentation
          ? speakerDiarization
            ? "全部片段转写完成。时间戳已合并为原录音时间；跨片段的说话人编号可能重新分配。"
            : "全部自动分段转写完成，结果已按原录音顺序合并。"
          : "完成。你可以直接修改文字，或下载为 Markdown。 ",
      );
    } catch (error) {
      setStatus("error");
      setSegmentBatch(null);
      if (!segmentationPreparationComplete) {
        setAudioToolStatus(controller.signal.aborted ? "idle" : "error");
        setAudioToolProgress(0);
        setAudioToolMessage(
          controller.signal.aborted ? "已取消自动分段。" : "音频自动转码或分段失败。",
        );
      }
      setMessage(
        controller.signal.aborted
          ? "转写已取消。"
          : friendlyError(error),
      );
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
    setAudioDiagnostics(null);
    setRequestDebug(null);
    setSubmittedRequestPreviews(null);
    setTranscript("");
    setMessage("");
    setUploadProgress(null);
    setSegmentBatch(null);
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
          文件准备和结果整理都在浏览器完成。转写时，音频会从你的浏览器直接发送给所选模型提供商，不经过自建服务器。
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
              <div><p className="overline">ACCESS</p><h2>连接模型提供商</h2></div>
            </div>
            <label className="field-label" htmlFor="provider">模型提供商</label>
            <select
              id="provider"
              className="provider-select"
              value={provider}
              onChange={(event) => {
                const nextProvider = event.target.value as ApiProvider;
                setProvider(nextProvider);
                setModel(PROVIDER_DEFAULT_MODELS[nextProvider]);
                setApiKey("");
                setRequestDebug(null);
                setSubmittedRequestPreviews(null);
              }}
            >
              <option value="openai">OpenAI</option>
              <option value="openrouter">OpenRouter</option>
            </select>
            <label className="field-label api-key-label" htmlFor="api-key">
              {providerName} API Key
            </label>
            <div className="key-field">
              <input
                id="api-key"
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={isOpenRouter ? "sk-or-v1-..." : "sk-..."}
                autoComplete="off"
                spellCheck={false}
              />
              <button type="button" onClick={() => setShowKey((value) => !value)}>
                {showKey ? "隐藏" : "显示"}
              </button>
            </div>
            <p className="field-note">
              切换提供商会清空 Key；不会写入 Cookie、Local Storage 或项目文件。关闭页面后即清除。
            </p>
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
              accept=".mp3,.mp4,.mpeg,.mpga,.m4a,.wav,.webm,audio/*"
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
                    {formatBytes(file.size)} · {
                      fileExceedsUploadLimit ? "将自动本地转码分段" : "准备上传"
                    }
                  </span>
                </div>
              ) : (
                <div><strong>把音频拖到这里</strong><span>或点击浏览文件</span></div>
              )}
              <span className="file-limit">MP3 · M4A · WAV · WEBM · API 上限 {formatBytes(OPENAI_FILE_LIMIT)}</span>
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
                  压缩输出为 16 kHz 单声道 MP3/LAME ABR。码率按时长和目标大小计算，并在帧间动态分配；
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
                    兼容修复为 WAV
                  </button>
                  <button
                    type="button"
                    disabled={isAudioProcessing}
                    onClick={diagnoseSelectedAudio}
                  >
                    深度检查文件
                  </button>
                  {isAudioProcessing && (
                    <button type="button" onClick={cancelProcessing}>取消处理</button>
                  )}
                </div>

                <p className="audio-tool-note repair-note">
                  修复会完整解码为 16 kHz 单声道 WAV PCM，不会造成第二次感知有损编码；
                  WAV 通常会显著变大，超过 25 MB 时还需再压缩为 MP3。
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
                  {provider === "openai" ? (
                    <>
                      <option value="gpt-transcribe">OpenAI: GPT Transcribe · 推荐</option>
                      <option value="gpt-4o-mini-transcribe">GPT-4o mini Transcribe</option>
                      <option value="gpt-4o-transcribe">GPT-4o Transcribe</option>
                      <option value="whisper-1">Whisper-1 · 兼容原项目</option>
                    </>
                  ) : (
                    <>
                      <option value="x-ai/grok-stt-1.0">SpaceXAI: Grok STT 1.0 · 多人推荐</option>
                      <option value="openai/whisper-large-v3-turbo">OpenAI: Whisper Large V3 Turbo</option>
                    </>
                  )}
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
                <select
                  value={effectiveLanguagePreset}
                  onChange={(event) => setLanguagePreset(event.target.value)}
                >
                  {LANGUAGE_PRESETS.map((preset) => (
                    <option
                      key={preset.value || "auto"}
                      value={preset.value}
                      disabled={Boolean("multiple" in preset && preset.multiple && !supportsMultipleLanguages)}
                    >
                      {preset.label}
                    </option>
                  ))}
                </select>
              </label>
              <label><span>音频分段</span>
                {isOpenRouter ? (
                  <select value="client-10m" disabled>
                    <option value="client-10m">客户端每 10 分钟自动切段</option>
                  </select>
                ) : (
                  <select
                    value={effectiveChunkingStrategy}
                    disabled={effectiveModel === "whisper-1"}
                    onChange={(event) => setChunkingStrategy(event.target.value as ChunkingStrategy)}
                  >
                    <option value="auto">自动检测语音 · 推荐</option>
                    <option value="single">整段处理</option>
                    <option value="server_vad">手动设置 VAD</option>
                  </select>
                )}
              </label>
            </div>

            <p className="field-note model-note">
              {isGrokStt
                ? "Grok STT 支持逐词时间戳、可选说话人分离与 25+ 种语言；说话人数量由模型自动判断。OpenRouter 若返回逐词 words，网页会按 speaker 编号排版；否则保留纯文字结果。"
                : effectiveModel === "openai/whisper-large-v3-turbo"
                  ? "Whisper Large V3 Turbo 支持 99+ 种语言；通过 OpenRouter 返回纯文字，不提供可靠的说话人标签。"
                : effectiveModel === "gpt-transcribe"
                ? "GPT Transcribe 可转写多人对话，但不会返回可靠的说话人标签；支持多个语言代码和关键词提示。"
                : effectiveModel === "whisper-1"
                  ? "Whisper 可转写多人对话，但不会返回可靠的说话人标签；网页会按整段提交。"
                  : "此模型只使用第一个语言代码，并固定返回 JSON。"}
            </p>

            <p className="field-note language-note">
              {supportsMultipleLanguages
                ? "GPT Transcribe 会把多语言预设作为 languages[] 提交，可提示同一录音中预期出现的多种语言。"
                : "当前模型只接受一个 language 提示；仍可识别其他语言，但不会提交多个语言代码。"}
              {effectiveLanguagePreset === "zh-cn"
                ? ` 中文偏好使用${supportsMultipleLanguages ? "官方区域代码 zh-cn" : "兼容代码 zh"}；模型仍可能根据录音内容决定最终字形。`
                : ""}
            </p>

            <p className="field-note diarization-split-note">
              {isOpenRouter
                ? "OpenRouter 文档标注 60 秒上游处理超时，因此超过 10 分钟或 25 MB 时，网页会先在本机按 10 分钟物理分段，再以 JSON/Base64 顺序上传。"
                : "超过 30 分钟或 25 MB 时，网页会在本机转为 16 kHz 单声道 MP3，按 30 分钟自动物理分段，再逐段上传。"}
            </p>

            {!isOpenRouter && effectiveChunkingStrategy === "server_vad" && (
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

            {(effectiveModel === "gpt-transcribe" || isGrokStt) && (
              <>
                <label className="field-label" htmlFor="keywords">关键词提示</label>
                <textarea
                  id="keywords"
                  value={keywords}
                  onChange={(event) => setKeywords(event.target.value)}
                  placeholder={"每行一个词或短语，例如：\n产品名称\n人物姓名\n专业术语"}
                  rows={3}
                />
                <p className="field-note">
                  {isGrokStt
                    ? "Grok 最多接受 100 个 keyterm，每项不超过 50 个字符；网页会通过 OpenRouter 的 x-ai provider options 转发。"
                    : "关键词是识别提示，不会强制模型输出；请只填写录音中可能出现的词。"}
                </p>
              </>
            )}

            {!isOpenRouter && (
              <>
                <label className="field-label prompt-label" htmlFor="prompt">上下文提示 / 输出风格</label>
                <textarea
                  id="prompt"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  rows={3}
                />
              </>
            )}

            {isGrokStt && (
              <div className="vad-settings" aria-label="Grok 语音活动检测参数">
                <p className="subsection-title">GROK STT / PROVIDER OPTIONS</p>
                <div className="vad-grid grok-vad-grid">
                  <label><span>语音门限</span>
                    <input
                      type="number"
                      min="0"
                      max="1"
                      step="0.05"
                      value={vadThreshold}
                      onChange={(event) => setVadThreshold(Number(event.target.value))}
                    />
                  </label>
                </div>
                <p className="field-note">`vad_threshold` 越低越容易保留轻声或噪声中的语音；0 会关闭语音活动门控。</p>
              </div>
            )}

            <div className="recognition-options" aria-label="高级识别选项">
              {isGrokStt ? (
                <label className="option-card" htmlFor="grok-diarization">
                  <input
                    id="grok-diarization"
                    type="checkbox"
                    aria-label="说话人分离"
                    checked={grokDiarization}
                    onChange={(event) => setGrokDiarization(event.target.checked)}
                  />
                  <span>
                    <strong>说话人分离</strong>
                    <small>提交 diarize=true；自动判断人数并尝试读取逐词 speaker 编号</small>
                  </span>
                </label>
              ) : (
                <div className="option-card capability-card">
                  <span className="capability-indicator" aria-hidden="true">—</span>
                  <span><strong>普通多人转写</strong><small>能识别多人内容，但不会标记每句话属于谁</small></span>
                </div>
              )}

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

              {isGrokStt && (
                <>
                  <label className="option-card" htmlFor="grok-formatting">
                    <input
                      id="grok-formatting"
                      type="checkbox"
                      aria-label="数字与单位格式化"
                      checked={grokTextFormatting}
                      disabled={!effectiveLanguagePreset}
                      onChange={(event) => setGrokTextFormatting(event.target.checked)}
                    />
                    <span><strong>数字与单位格式化</strong><small>有语言提示时提交 format=true</small></span>
                  </label>
                  <label className="option-card" htmlFor="grok-filler-words">
                    <input
                      id="grok-filler-words"
                      type="checkbox"
                      aria-label="保留填充词"
                      checked={grokFillerWords}
                      onChange={(event) => setGrokFillerWords(event.target.checked)}
                    />
                    <span><strong>保留填充词</strong><small>保留“嗯、呃、uh、um”等口语填充词</small></span>
                  </label>
                </>
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
              {status === "uploading" ? (
                <><span className="spinner" />{roundedUploadPercent < 100 ? "正在上传" : "正在转写"}</>
              ) : <>开始转写 <span aria-hidden="true">→</span></>}
            </button>
            {status === "uploading" ? (
              <button
                className="text-button"
                type="button"
                onClick={() => {
                  abortRef.current?.abort();
                  cancelAudioProcessing();
                  if (isAudioProcessing) {
                    setAudioToolStatus("idle");
                    setAudioToolProgress(0);
                    setAudioToolMessage("已取消自动分段。再次处理时需要重新加载音频核心。");
                  }
                }}
              >
                取消
              </button>
            ) : file ? (
              <button className="text-button" type="button" onClick={reset}>重新选择</button>
            ) : null}
          </div>

          {uploadProgress && (
            <div className={`upload-progress-card ${status === "error" ? "is-error" : ""}`} aria-live="polite">
              <div className="upload-progress-heading">
                <span>{uploadStageLabel}</span>
                <strong>
                  {uploadProgress.computable || roundedUploadPercent >= 100
                    ? `${roundedUploadPercent}%`
                    : "计算中"}
                </strong>
              </div>
              <progress
                max="100"
                value={uploadProgress.computable || roundedUploadPercent >= 100
                  ? roundedUploadPercent
                  : undefined}
                aria-label="音频上传进度"
              />
              <div className="upload-progress-meta">
                {uploadProgress.computable && uploadProgress.total > 0 ? (
                  <span>
                    {formatBytes(Math.min(uploadProgress.loaded, uploadProgress.total))}
                    {" / "}{formatBytes(uploadProgress.total)}
                  </span>
                ) : (
                  <span>流式模式下浏览器不提供精确上传字节</span>
                )}
                <span>{segmentBatch?.fileName || file?.name}</span>
              </div>
            </div>
          )}

          {(audioDiagnostics || requestDebug) && (
            <details className="request-preview debug-preview">
              <summary>
                <span>查看深度诊断信息</span>
                <small>SHA-256 / 完整解码 / Provider Request ID</small>
              </summary>
              <div className="debug-preview-toolbar">
                <span>
                  本地解码：{audioDiagnostics?.ffmpeg_full_decode === "passed" ? "通过" : audioDiagnostics ? "失败" : "未运行"}
                </span>
                <button type="button" onClick={copyDiagnostics}>
                  {diagnosticCopied ? "已复制" : "复制诊断 JSON"}
                </button>
              </div>
              <pre><code>{JSON.stringify({
                local_audio: audioDiagnostics,
                provider_response: requestDebug,
                submitted_request: submittedRequestPreviews || requestPreview,
              }, null, 2)}</code></pre>
            </details>
          )}
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
            <span>音频直接发送至 {providerName} API</span>
            <a
              href={isOpenRouter ? "https://openrouter.ai/settings/keys" : "https://platform.openai.com/api-keys"}
              target="_blank"
              rel="noreferrer"
            >
              管理 {providerName} API Key ↗
            </a>
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
