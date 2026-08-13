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
  "Transcribe the recording faithfully. When Chinese is spoken, prefer Simplified Chinese. Recognize these terms accurately: OpenAI, Whisper, API.";

type Locale = "en" | "zh";

const LANGUAGE_PRESETS = [
  { value: "", en: "Auto-detect", zh: "自动检测语言" },
  { value: "zh-cn", en: "Chinese · Simplified preferred", zh: "中文（偏好简体）" },
  { value: "en", en: "English", zh: "英文" },
  { value: "ja", en: "Japanese", zh: "日语" },
  { value: "fr", en: "French", zh: "法语" },
  { value: "it", en: "Italian", zh: "意大利语" },
  { value: "zh-cn,en", en: "Chinese + English · multilingual", zh: "中文 + 英文（多语言）", multiple: true },
  { value: "zh-cn,en,ja,fr,it", en: "ZH / EN / JA / FR / IT · multilingual", zh: "中 / 英 / 日 / 法 / 意（多语言）", multiple: true },
] as const;

const RESPONSE_FORMAT_LABELS: Record<ResponseFormat, Record<Locale, string>> = {
  json: { en: "JSON · plain text", zh: "JSON · 纯文字" },
  text: { en: "Text · plain text", zh: "Text · 纯文字" },
  srt: { en: "SRT · subtitles", zh: "SRT · 字幕" },
  verbose_json: { en: "Verbose JSON · timestamps", zh: "Verbose JSON · 含时间信息" },
  vtt: { en: "VTT · subtitles", zh: "VTT · 字幕" },
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

const STATUS_COPY: Record<Status, Record<Locale, string>> = {
  idle: { en: "Waiting for audio", zh: "等待音频" },
  ready: { en: "Ready", zh: "准备就绪" },
  uploading: { en: "Transcribing", zh: "正在转写" },
  done: { en: "Complete", zh: "转写完成" },
  error: { en: "Needs attention", zh: "需要处理" },
};

function localizeRuntimeMessage(message: string, locale: Locale): string {
  if (locale === "zh") return message;
  const exact: Record<string, string> = {
    "正在准备浏览器音频处理器…": "Preparing the browser audio processor…",
    "正在准备完整解码扫描…": "Preparing a full decode scan…",
    "音频压缩失败。": "Audio compression failed.",
    "音频修复失败。": "Audio repair failed.",
    "深度音频检查失败。": "Deep audio inspection failed.",
    "已取消。再次处理时需要重新加载音频核心。": "Cancelled. The audio engine will reload before the next operation.",
    "已恢复最初选择的文件。": "Restored the originally selected file.",
    "转写已取消。": "Transcription cancelled.",
    "转写失败，请稍后重试。": "Transcription failed. Please try again.",
    "首次使用：正在加载约 31 MB 的音频处理核心…": "First use: loading the approximately 31 MB audio engine…",
    "音频处理核心已就绪。": "Audio engine ready.",
    "正在本地转码；文件不会上传到第三方服务…": "Transcoding locally; the file is not being uploaded…",
    "正在完整解码扫描音频并计算 SHA-256…": "Running a full audio decode scan and calculating SHA-256…",
  };
  if (exact[message]) return exact[message];
  return message
    .replace(
      /暂不支持此格式。请选择 (.+) 文件。/,
      "This format is not supported. Choose a $1 file.",
    )
    .replace(/正在本地切分长音频为 (\d+) 分钟片段；文件尚未上传…/, "Splitting the audio locally into $1-minute segments; nothing has been uploaded yet…")
    .replace(/本地分段完成，共 (\d+) 段。/, "Local segmentation complete: $1 segments.")
    .replace(/无法连接 (OpenAI|OpenRouter)。请检查网络、浏览器隐私设置或 API Key 后重试。/, "Could not connect to $1. Check your network, browser privacy settings, and API key, then try again.");
}

export function TranscriptionWorkbench() {
  const [locale, setLocale] = useState<Locale>("en");
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

  const ui = (english: string, chinese: string) => locale === "en" ? english : chinese;

  useEffect(() => () => {
    abortRef.current?.abort();
    cancelAudioProcessing();
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale === "en" ? "en" : "zh-CN";
  }, [locale]);

  const acceptFile = (nextFile?: File) => {
    if (!nextFile) return;
    const validation = validateAudio(nextFile);
    setFileError(validation ? localizeRuntimeMessage(validation, locale) : "");
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
    setAudioToolMessage(localizeRuntimeMessage(progress.message, locale));
  };

  const compressSelectedAudio = async () => {
    if (!file) return;
    setAudioToolStatus("loading");
    setAudioToolProgress(0);
    setAudioToolMessage(ui("Preparing the browser audio processor…", "正在准备浏览器音频处理器…"));
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
        ui(
          `Converted to mono MP3 ABR at a target average of ${result.targetBitrateKbps} kbps: ` +
          `${formatBytes(file.size)} → ${formatBytes(result.file.size)}.`,
          `已转为单声道 MP3 ABR：目标平均 ${result.targetBitrateKbps} kbps，` +
          `${formatBytes(file.size)} → ${formatBytes(result.file.size)}。`,
        ),
      );
      setStatus("ready");
      setMessage("");
      setTranscript("");
    } catch (error) {
      if (error instanceof AudioDiagnosticError) setAudioDiagnostics(error.report);
      setAudioToolStatus("error");
      setAudioToolMessage(localizeRuntimeMessage(
        error instanceof Error ? error.message : "音频压缩失败。",
        locale,
      ));
    }
  };

  const repairSelectedAudio = async () => {
    if (!file) return;
    setAudioToolStatus("loading");
    setAudioToolProgress(0);
    setAudioToolMessage(ui("Preparing the browser audio processor…", "正在准备浏览器音频处理器…"));
    try {
      const result = await repairAudioAsWav(file, updateAudioToolProgress);
      const repairedFile = result.file;
      setFile(repairedFile);
      setAudioDiagnostics(result.diagnostics);
      setFileError("");
      setAudioToolStatus("done");
      setAudioToolProgress(1);
      setAudioToolMessage(
        ui(
          `Re-decoded as compatible WAV PCM: ${formatBytes(file.size)} → ${formatBytes(repairedFile.size)}.`,
          `已重新解码为兼容 WAV PCM：${formatBytes(file.size)} → ${formatBytes(repairedFile.size)}。`,
        ),
      );
      setStatus("ready");
      setMessage("");
      setTranscript("");
    } catch (error) {
      if (error instanceof AudioDiagnosticError) setAudioDiagnostics(error.report);
      setAudioToolStatus("error");
      setAudioToolMessage(localizeRuntimeMessage(
        error instanceof Error ? error.message : "音频修复失败。",
        locale,
      ));
    }
  };

  const diagnoseSelectedAudio = async () => {
    if (!file) return;
    setAudioToolStatus("loading");
    setAudioToolProgress(0);
    setAudioToolMessage(ui("Preparing a full decode scan…", "正在准备完整解码扫描…"));
    try {
      const report = await diagnoseAudioFile(file, updateAudioToolProgress);
      setAudioDiagnostics(report);
      setAudioToolStatus("done");
      setAudioToolProgress(1);
      setAudioToolMessage(ui(
        "Deep inspection passed: FFmpeg decoded the entire file and recorded its SHA-256.",
        "深度检查通过：整段文件可被 FFmpeg 完整解码，SHA-256 已记录。",
      ));
    } catch (error) {
      if (error instanceof AudioDiagnosticError) setAudioDiagnostics(error.report);
      setAudioToolStatus("error");
      setAudioToolMessage(localizeRuntimeMessage(
        error instanceof Error ? error.message : "深度音频检查失败。",
        locale,
      ));
    }
  };

  const cancelProcessing = () => {
    cancelAudioProcessing();
    setAudioToolStatus("idle");
    setAudioToolProgress(0);
    setAudioToolMessage(ui(
      "Cancelled. The audio engine will reload before the next operation.",
      "已取消。再次处理时需要重新加载音频核心。",
    ));
  };

  const restoreOriginalAudio = () => {
    if (!originalFile) return;
    setFile(originalFile);
    setAudioToolStatus("idle");
    setAudioToolProgress(0);
    setAudioToolMessage(ui("Restored the originally selected file.", "已恢复最初选择的文件。"));
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
  const providerName = isOpenRouter ? "OpenRouter" : "OpenAI";
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
  const previewFile = file || new File([], ui("[audio added after selection]", "[选择录音后填充音频]"), { type: "audio/mpeg" });
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
      note: ui(
        `Client-side segmentation metadata; this object is not sent to ${providerName}.`,
        `仅超限时在浏览器本地物理分段；此对象不会提交给 ${providerName}`,
      ),
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
  const roundedUploadPercent = Math.round(uploadProgress?.percent || 0);
  const uploadStageLabel = status === "uploading"
    ? segmentBatch?.stage === "preparing"
      ? ui("Preparing long-audio segments locally", "正在本地准备长音频分段")
      : segmentBatch
        ? ui(
            `Segment ${segmentBatch.current}/${segmentBatch.total}: ${
              segmentBatch.stage === "processing" ? `${providerName} is transcribing` : "uploading"
            }`,
            `第 ${segmentBatch.current}/${segmentBatch.total} 段：${
              segmentBatch.stage === "processing" ? `${providerName} 正在转写` : "正在上传"
            }`,
          )
        : roundedUploadPercent >= 100
          ? ui(`Upload complete; ${providerName} is processing the audio`, `上传完成，${providerName} 正在处理音频`)
          : ui(`Uploading audio to ${providerName}`, `正在上传音频到 ${providerName}`)
    : status === "done"
      ? ui("Audio upload complete", "音频上传完成")
      : status === "error"
        ? roundedUploadPercent >= 100
          ? ui("Upload complete; transcription failed", "上传完成，转写阶段出错")
          : ui("Upload interrupted", "上传已中断")
        : ui("Waiting to upload", "等待上传");

  const runTranscription = async () => {
    if (!file || !apiKey.trim()) {
      setMessage(ui("Enter an API key and select an audio file first.", "请先填写 API Key 并选择音频文件。"));
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
      ui(
        "Checking audio duration and size; oversized files will be segmented locally first.",
        "正在检查音频时长与大小；超限时会先在浏览器本地分段。",
      ),
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
          ui(
            `Prepared ${prepared.segments.length} segments locally, each no longer than ` +
            `${Math.round(automaticSegmentDurationSeconds / 60)} minutes.`,
            `已在浏览器本地处理为 ${prepared.segments.length} 段，` +
            `每段不超过 ${Math.round(automaticSegmentDurationSeconds / 60)} 分钟。`,
          ),
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
            ui(
              `Processing segment ${segment.index + 1}/${segment.total}; keep this page open.`,
              `正在处理第 ${segment.index + 1}/${segment.total} 段；请保持页面开启。`,
            ),
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
              : `## ${ui("Segment", "片段")} ${segment.index + 1}/${segment.total} · ${formatClock(segment.startSeconds)}–${formatClock(segment.startSeconds + segment.durationSeconds)}\n\n${result}`
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
            ? ui(
                "All segments are complete. Timestamps use the original timeline; speaker numbers may be reassigned between segments.",
                "全部片段转写完成。时间戳已合并为原录音时间；跨片段的说话人编号可能重新分配。",
              )
            : ui(
                "All automatically segmented audio is complete and merged in the original order.",
                "全部自动分段转写完成，结果已按原录音顺序合并。",
              )
          : ui(
              "Complete. You can edit the transcript or download it as Markdown.",
              "完成。你可以直接修改文字，或下载为 Markdown。",
            ),
      );
    } catch (error) {
      setStatus("error");
      setSegmentBatch(null);
      if (!segmentationPreparationComplete) {
        setAudioToolStatus(controller.signal.aborted ? "idle" : "error");
        setAudioToolProgress(0);
        setAudioToolMessage(
          controller.signal.aborted
            ? ui("Automatic segmentation cancelled.", "已取消自动分段。")
            : ui("Automatic audio transcoding or segmentation failed.", "音频自动转码或分段失败。"),
        );
      }
      setMessage(
        controller.signal.aborted
          ? ui("Transcription cancelled.", "转写已取消。")
          : localizeRuntimeMessage(friendlyError(error), locale),
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
        <a className="brand" href="../" aria-label={ui("Return to Henry Huang's homepage", "返回 Henry Huang 主页")}>
          <span className="brand-name">HENRY<span>.H</span></span>
          <span className="brand-product">/ Whisper Desk</span>
        </a>
        <div className="topbar-actions">
          <div className="language-switch" role="group" aria-label={ui("Interface language", "界面语言")}>
            <button
              type="button"
              className={locale === "en" ? "is-active" : ""}
              aria-pressed={locale === "en"}
              onClick={() => setLocale("en")}
            >
              EN
            </button>
            <span aria-hidden="true">/</span>
            <button
              type="button"
              className={locale === "zh" ? "is-active" : ""}
              aria-pressed={locale === "zh"}
              onClick={() => setLocale("zh")}
            >
              中
            </button>
          </div>
          <div className="privacy-pill">
            <span className="privacy-dot" aria-hidden="true" />
            {ui("Key stays in page memory only", "Key 仅保存在当前页面内存")}
          </div>
          <a className="home-link" href="../">{ui("Home", "返回主页")}</a>
        </div>
      </header>

      <section className="hero" id="top">
        <p className="eyebrow">PERSONAL TOOL / AUDIO TRANSCRIPTION</p>
        <h1>
          {locale === "en" ? (
            <>Turn every voice<br /><em>into clear words.</em></>
          ) : (
            <>让每一段声音，<br /><em>清晰落在纸上。</em></>
          )}
        </h1>
        <p className="hero-copy">
          {ui(
            "File preparation and result assembly happen in your browser. Audio is sent directly to the selected model provider, with no custom server in between.",
            "文件准备和结果整理都在浏览器完成。转写时，音频会从你的浏览器直接发送给所选模型提供商，不经过自建服务器。",
          )}
        </p>
        <div className="hero-meta" aria-label={ui("Product highlights", "产品特点")}>
          <span>{ui("No install", "无需安装")}</span>
          <span>{ui("No key storage", "不保存密钥")}</span>
          <span>{ui("Editable results", "结果可编辑")}</span>
        </div>
      </section>

      <section className="workspace" aria-label={ui("Audio transcription workspace", "音频转写工作台")}>
        <div className="control-column">
          <section className="panel setup-panel">
            <div className="panel-heading">
              <span className="step-number">01</span>
              <div><p className="overline">ACCESS</p><h2>{ui("Connect a provider", "连接模型提供商")}</h2></div>
            </div>
            <label className="field-label" htmlFor="provider">{ui("Model provider", "模型提供商")}</label>
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
                {showKey ? ui("Hide", "隐藏") : ui("Show", "显示")}
              </button>
            </div>
            <p className="field-note">{ui(
              "Switching providers clears the key. It is never written to cookies, local storage, or project files, and disappears when the page closes.",
              "切换提供商会清空 Key；不会写入 Cookie、Local Storage 或项目文件。关闭页面后即清除。",
            )}</p>
          </section>

          <section className="panel file-panel">
            <div className="panel-heading">
              <span className="step-number">02</span>
              <div><p className="overline">SOURCE</p><h2>{ui("Choose a recording", "选择录音")}</h2></div>
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
              aria-label={ui("Choose or drop an audio file", "选择或拖放音频文件")}
            >
              <span className="drop-glyph" aria-hidden="true">↗</span>
              {file ? (
                <div className="file-summary">
                  <strong>{file.name}</strong>
                  <span>
                    {formatBytes(file.size)} · {
                      fileExceedsUploadLimit
                        ? ui("will be transcoded and segmented locally", "将自动本地转码分段")
                        : ui("ready to upload", "准备上传")
                    }
                  </span>
                </div>
              ) : (
                <div>
                  <strong>{ui("Drop audio here", "把音频拖到这里")}</strong>
                  <span>{ui("or click to browse", "或点击浏览文件")}</span>
                </div>
              )}
              <span className="file-limit">
                MP3 · M4A · WAV · WEBM · {ui("API limit", "API 上限")} {formatBytes(OPENAI_FILE_LIMIT)}
              </span>
            </div>
            {fileError && <p className="error-copy" role="alert">{fileError}</p>}
            {file && (
              <div className="audio-tools" aria-label={ui("In-browser audio processing", "浏览器端音频处理")}>
                <div className="audio-tools-heading">
                  <div>
                    <p className="overline">LOCAL AUDIO LAB</p>
                    <h3>{ui("Compression & compatibility", "压缩与兼容修复")}</h3>
                  </div>
                  <span className="local-only-badge">{ui("Local only", "仅在本机处理")}</span>
                </div>

                <div className="compression-controls">
                  <label>
                    <span>{ui("Target size", "压缩目标")}</span>
                    <div className="number-suffix-field">
                      <input
                        type="number"
                        min="1"
                        max="24"
                        step="0.5"
                        value={targetSizeMb}
                        disabled={isAudioProcessing}
                        onChange={(event) => setTargetSizeMb(Math.max(1, Math.min(24, Number(event.target.value))))}
                        aria-label={ui("Compression target size in MB", "压缩目标大小 MB")}
                      />
                      <span>MB</span>
                    </div>
                  </label>
                  <label>
                    <span>{ui("Minimum bitrate", "最低码率")}</span>
                    <select
                      value={minimumBitrateKbps}
                      disabled={isAudioProcessing}
                      onChange={(event) => setMinimumBitrateKbps(Number(event.target.value))}
                    >
                      <option value="16">16 kbps · {ui("very long audio", "极长录音")}</option>
                      <option value="24">24 kbps · {ui("recommended", "推荐")}</option>
                      <option value="32">32 kbps · {ui("clearer", "更清晰")}</option>
                      <option value="48">48 kbps · {ui("high-fidelity speech", "高保真语音")}</option>
                    </select>
                  </label>
                </div>

                <p className="audio-tool-note">{ui(
                  "Compression outputs 16 kHz mono MP3 using LAME ABR. Bitrate is calculated from duration and target size, then distributed dynamically across frames. The minimum bitrate may make the final file slightly larger than the target.",
                  "压缩输出为 16 kHz 单声道 MP3/LAME ABR。码率按时长和目标大小计算，并在帧间动态分配；最低码率可能使最终文件略大于目标。",
                )}</p>

                <div className="audio-tool-actions">
                  <button
                    className="audio-tool-primary"
                    type="button"
                    disabled={isAudioProcessing}
                    onClick={compressSelectedAudio}
                  >
                    {ui("Compress to about", "压缩到约")} {targetSizeMb} MB
                  </button>
                  <button
                    type="button"
                    disabled={isAudioProcessing}
                    onClick={repairSelectedAudio}
                  >
                    {ui("Repair as WAV", "兼容修复为 WAV")}
                  </button>
                  <button
                    type="button"
                    disabled={isAudioProcessing}
                    onClick={diagnoseSelectedAudio}
                  >
                    {ui("Deep-inspect file", "深度检查文件")}
                  </button>
                  {isAudioProcessing && (
                    <button type="button" onClick={cancelProcessing}>{ui("Cancel", "取消处理")}</button>
                  )}
                </div>

                <p className="audio-tool-note repair-note">{ui(
                  "Repair fully decodes the audio to 16 kHz mono WAV PCM without another perceptual lossy encode. WAV files are usually much larger and may still need MP3 compression above 25 MB.",
                  "修复会完整解码为 16 kHz 单声道 WAV PCM，不会造成第二次感知有损编码；WAV 通常会显著变大，超过 25 MB 时还需再压缩为 MP3。",
                )}</p>

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
                    <button type="button" onClick={downloadProcessedAudio}>{ui("Download processed audio", "下载处理后的音频")}</button>
                    <button type="button" onClick={restoreOriginalAudio}>{ui("Restore original", "恢复原文件")}</button>
                  </div>
                )}

                <p className="audio-engine-note">{ui(
                  "The first audio operation loads approximately 31 MB of single-threaded ffmpeg.wasm from a CDN. GitHub Pages needs no backend.",
                  "首次点击会从 CDN 按需加载约 31 MB 的单线程 ffmpeg.wasm；GitHub Pages 无需后端。",
                )}</p>
              </div>
            )}
          </section>

          <section className="panel settings-panel">
            <div className="panel-heading compact">
              <span className="step-number">03</span>
              <div><p className="overline">DETAILS</p><h2>{ui("Recognition settings", "调整识别")}</h2></div>
            </div>
            <div className="field-grid">
              <label><span>{ui("Model", "模型")}</span>
                <select value={model} onChange={(event) => setModel(event.target.value)}>
                  {provider === "openai" ? (
                    <>
                      <option value="gpt-transcribe">OpenAI: GPT Transcribe · {ui("recommended", "推荐")}</option>
                      <option value="gpt-4o-mini-transcribe">GPT-4o mini Transcribe</option>
                      <option value="gpt-4o-transcribe">GPT-4o Transcribe</option>
                      <option value="whisper-1">Whisper-1 · {ui("legacy compatible", "兼容原项目")}</option>
                    </>
                  ) : (
                    <>
                      <option value="x-ai/grok-stt-1.0">SpaceXAI: Grok STT 1.0 · {ui("speaker-aware", "多人推荐")}</option>
                      <option value="openai/whisper-large-v3-turbo">OpenAI: Whisper Large V3 Turbo</option>
                    </>
                  )}
                </select>
              </label>
              <label><span>{ui("Response format", "返回格式")}</span>
                <select
                  value={effectiveResponseFormat}
                  disabled={availableResponseFormats.length === 1}
                  onChange={(event) => setResponseFormat(event.target.value as ResponseFormat)}
                >
                  {availableResponseFormats.map((format) => (
                    <option key={format} value={format}>{RESPONSE_FORMAT_LABELS[format][locale]}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="field-grid">
              <label><span>{ui("Language hint", "语言提示")}</span>
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
                      {preset[locale]}
                    </option>
                  ))}
                </select>
              </label>
              <label><span>{ui("Audio segmentation", "音频分段")}</span>
                {isOpenRouter ? (
                  <select value="client-10m" disabled>
                    <option value="client-10m">{ui("Client-side · every 10 minutes", "客户端每 10 分钟自动切段")}</option>
                  </select>
                ) : (
                  <select
                    value={effectiveChunkingStrategy}
                    disabled={effectiveModel === "whisper-1"}
                    onChange={(event) => setChunkingStrategy(event.target.value as ChunkingStrategy)}
                  >
                    <option value="auto">{ui("Automatic speech detection · recommended", "自动检测语音 · 推荐")}</option>
                    <option value="single">{ui("Single request", "整段处理")}</option>
                    <option value="server_vad">{ui("Manual VAD", "手动设置 VAD")}</option>
                  </select>
                )}
              </label>
            </div>

            <p className="field-note model-note">
              {isGrokStt
                ? ui(
                    "Grok STT supports word timestamps, optional speaker diarization, and 25+ languages. It detects speaker count automatically. If OpenRouter returns word data, the page formats it by speaker; otherwise it keeps the plain transcript.",
                    "Grok STT 支持逐词时间戳、可选说话人分离与 25+ 种语言；说话人数量由模型自动判断。OpenRouter 若返回逐词 words，网页会按 speaker 编号排版；否则保留纯文字结果。",
                  )
                : effectiveModel === "openai/whisper-large-v3-turbo"
                  ? ui(
                      "Whisper Large V3 Turbo supports 99+ languages. Through OpenRouter it returns plain text without reliable speaker labels.",
                      "Whisper Large V3 Turbo 支持 99+ 种语言；通过 OpenRouter 返回纯文字，不提供可靠的说话人标签。",
                    )
                : effectiveModel === "gpt-transcribe"
                ? ui(
                    "GPT Transcribe handles multi-speaker conversations but does not return reliable speaker labels. It supports multiple language codes and keyword hints.",
                    "GPT Transcribe 可转写多人对话，但不会返回可靠的说话人标签；支持多个语言代码和关键词提示。",
                  )
                : effectiveModel === "whisper-1"
                  ? ui(
                      "Whisper can transcribe multi-speaker conversations but does not return reliable speaker labels. The page submits it as one block unless client-side size segmentation is required.",
                      "Whisper 可转写多人对话，但不会返回可靠的说话人标签；网页会按整段提交。",
                    )
                  : ui("This model uses only the first language code and returns JSON.", "此模型只使用第一个语言代码，并固定返回 JSON。")}
            </p>

            <p className="field-note language-note">
              {supportsMultipleLanguages
                ? ui(
                    "GPT Transcribe submits multilingual presets as languages[] to hint that several languages may appear in one recording.",
                    "GPT Transcribe 会把多语言预设作为 languages[] 提交，可提示同一录音中预期出现的多种语言。",
                  )
                : ui(
                    "This model accepts one language hint. It may still recognize other languages, but only one code is submitted.",
                    "当前模型只接受一个 language 提示；仍可识别其他语言，但不会提交多个语言代码。",
                  )}
              {effectiveLanguagePreset === "zh-cn"
                ? ui(
                    ` Chinese uses ${supportsMultipleLanguages ? "the regional code zh-cn" : "the compatible code zh"}; the model may still choose character forms from the recording context.`,
                    ` 中文偏好使用${supportsMultipleLanguages ? "官方区域代码 zh-cn" : "兼容代码 zh"}；模型仍可能根据录音内容决定最终字形。`,
                  )
                : ""}
            </p>

            <p className="field-note diarization-split-note">
              {isOpenRouter
                ? ui(
                    "OpenRouter documents a 60-second upstream processing timeout. Audio over 10 minutes or 25 MB is therefore split locally into 10-minute segments and uploaded sequentially as JSON/Base64.",
                    "OpenRouter 文档标注 60 秒上游处理超时，因此超过 10 分钟或 25 MB 时，网页会先在本机按 10 分钟物理分段，再以 JSON/Base64 顺序上传。",
                  )
                : ui(
                    "Audio over 30 minutes or 25 MB is converted locally to 16 kHz mono MP3, split into 30-minute segments, and uploaded sequentially.",
                    "超过 30 分钟或 25 MB 时，网页会在本机转为 16 kHz 单声道 MP3，按 30 分钟自动物理分段，再逐段上传。",
                  )}
            </p>

            {!isOpenRouter && effectiveChunkingStrategy === "server_vad" && (
              <div className="vad-settings" aria-label={ui("Manual VAD parameters", "手动 VAD 参数")}>
                <p className="subsection-title">{ui("VOICE ACTIVITY DETECTION", "语音活动检测")} / SERVER VAD</p>
                <div className="vad-grid">
                  <label><span>{ui("Sensitivity threshold", "灵敏度阈值")}</span>
                    <input
                      type="number"
                      min="0"
                      max="1"
                      step="0.05"
                      value={vadThreshold}
                      onChange={(event) => setVadThreshold(Number(event.target.value))}
                    />
                  </label>
                  <label><span>{ui("Prefix padding ms", "前置保留 ms")}</span>
                    <input
                      type="number"
                      min="0"
                      step="50"
                      value={vadPrefixPaddingMs}
                      onChange={(event) => setVadPrefixPaddingMs(Number(event.target.value))}
                    />
                  </label>
                  <label><span>{ui("Silence cutoff ms", "静音判停 ms")}</span>
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
                <label className="field-label" htmlFor="keywords">{ui("Keyword hints", "关键词提示")}</label>
                <textarea
                  id="keywords"
                  value={keywords}
                  onChange={(event) => setKeywords(event.target.value)}
                  placeholder={ui(
                    "One word or phrase per line, for example:\nProduct name\nPerson's name\nTechnical term",
                    "每行一个词或短语，例如：\n产品名称\n人物姓名\n专业术语",
                  )}
                  rows={3}
                />
                <p className="field-note">
                  {isGrokStt
                    ? ui(
                        "Grok accepts up to 100 keyterms of 50 characters each. The page forwards them through OpenRouter's x-ai provider options.",
                        "Grok 最多接受 100 个 keyterm，每项不超过 50 个字符；网页会通过 OpenRouter 的 x-ai provider options 转发。",
                      )
                    : ui(
                        "Keywords guide recognition but do not force output. Enter only terms likely to occur in the recording.",
                        "关键词是识别提示，不会强制模型输出；请只填写录音中可能出现的词。",
                      )}
                </p>
              </>
            )}

            {!isOpenRouter && (
              <>
                <label className="field-label prompt-label" htmlFor="prompt">{ui("Context / output style", "上下文提示 / 输出风格")}</label>
                <textarea
                  id="prompt"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  rows={3}
                />
              </>
            )}

            {isGrokStt && (
              <div className="vad-settings" aria-label={ui("Grok voice activity parameters", "Grok 语音活动检测参数")}>
                <p className="subsection-title">GROK STT / PROVIDER OPTIONS</p>
                <div className="vad-grid grok-vad-grid">
                  <label><span>{ui("Speech threshold", "语音门限")}</span>
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
                <p className="field-note">{ui(
                  "A lower vad_threshold preserves quieter or noisier speech; 0 disables the voice-activity gate.",
                  "`vad_threshold` 越低越容易保留轻声或噪声中的语音；0 会关闭语音活动门控。",
                )}</p>
              </div>
            )}

            <div className="recognition-options" aria-label={ui("Advanced recognition options", "高级识别选项")}>
              {isGrokStt ? (
                <label className="option-card" htmlFor="grok-diarization">
                  <input
                    id="grok-diarization"
                    type="checkbox"
                    aria-label={ui("Speaker diarization", "说话人分离")}
                    checked={grokDiarization}
                    onChange={(event) => setGrokDiarization(event.target.checked)}
                  />
                  <span>
                    <strong>{ui("Speaker diarization", "说话人分离")}</strong>
                    <small>{ui(
                      "Sends diarize=true, detects speaker count automatically, and attempts to read word-level speaker IDs",
                      "提交 diarize=true；自动判断人数并尝试读取逐词 speaker 编号",
                    )}</small>
                  </span>
                </label>
              ) : (
                <div className="option-card capability-card">
                  <span className="capability-indicator" aria-hidden="true">—</span>
                  <span>
                    <strong>{ui("Standard multi-speaker transcription", "普通多人转写")}</strong>
                    <small>{ui("Recognizes multiple voices but does not label who said each line", "能识别多人内容，但不会标记每句话属于谁")}</small>
                  </span>
                </div>
              )}

              {speakerDiarization && (
                <label className="option-card" htmlFor="include-speaker-timestamps">
                  <input
                    id="include-speaker-timestamps"
                    type="checkbox"
                    aria-label={ui("Show segment times", "显示分段时间")}
                    checked={includeTimestamps}
                    onChange={(event) => setIncludeTimestamps(event.target.checked)}
                  />
                  <span>
                    <strong>{ui("Show segment times", "显示分段时间")}</strong>
                    <small>{ui("Add start and end times to each speaker segment", "给每个说话人片段加入开始与结束时间")}</small>
                  </span>
                </label>
              )}

              {isGrokStt && (
                <>
                  <label className="option-card" htmlFor="grok-formatting">
                    <input
                      id="grok-formatting"
                      type="checkbox"
                      aria-label={ui("Format numbers and units", "数字与单位格式化")}
                      checked={grokTextFormatting}
                      disabled={!effectiveLanguagePreset}
                      onChange={(event) => setGrokTextFormatting(event.target.checked)}
                    />
                    <span>
                      <strong>{ui("Format numbers & units", "数字与单位格式化")}</strong>
                      <small>{ui("Sends format=true when a language hint is selected", "有语言提示时提交 format=true")}</small>
                    </span>
                  </label>
                  <label className="option-card" htmlFor="grok-filler-words">
                    <input
                      id="grok-filler-words"
                      type="checkbox"
                      aria-label={ui("Keep filler words", "保留填充词")}
                      checked={grokFillerWords}
                      onChange={(event) => setGrokFillerWords(event.target.checked)}
                    />
                    <span>
                      <strong>{ui("Keep filler words", "保留填充词")}</strong>
                      <small>{ui("Keep fillers such as uh and um", "保留“嗯、呃、uh、um”等口语填充词")}</small>
                    </span>
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
                  aria-label={ui("Stream response", "流式返回")}
                  checked={stream && supportsStreaming}
                  disabled={!supportsStreaming}
                  onChange={(event) => setStream(event.target.checked)}
                />
                <span>
                  <strong>{ui("Stream response", "流式返回")}</strong>
                  <small>{ui("Show text while it is recognized; unavailable for Whisper", "边识别边显示文字；Whisper 不支持")}</small>
                </span>
              </label>

              <label
                className={`option-card ${supportsLogprobs ? "" : "is-disabled"}`}
                htmlFor="include-logprobs"
              >
                <input
                  id="include-logprobs"
                  type="checkbox"
                  aria-label={ui("Return log probabilities", "返回 Logprobs")}
                  checked={includeLogprobs && supportsLogprobs}
                  disabled={!supportsLogprobs}
                  onChange={(event) => setIncludeLogprobs(event.target.checked)}
                />
                <span>
                  <strong>{ui("Return log probabilities", "返回 Logprobs")}</strong>
                  <small>{ui("Available only for GPT-4o Transcribe JSON responses", "仅 GPT-4o Transcribe 系列 JSON 响应支持")}</small>
                </span>
              </label>

              {supportsWhisperTimestamps && (
                <>
                  <label className="option-card" htmlFor="word-timestamps">
                    <input
                      id="word-timestamps"
                      type="checkbox"
                      aria-label={ui("Word timestamps", "词级时间戳")}
                      checked={wordTimestamps}
                      onChange={(event) => setWordTimestamps(event.target.checked)}
                    />
                    <span>
                      <strong>{ui("Word timestamps", "词级时间戳")}</strong>
                      <small>{ui("More precise, with additional processing latency", "更精细，但会增加处理延迟")}</small>
                    </span>
                  </label>
                  <label className="option-card" htmlFor="segment-timestamps">
                    <input
                      id="segment-timestamps"
                      type="checkbox"
                      aria-label={ui("Segment timestamps", "段落时间戳")}
                      checked={segmentTimestamps}
                      onChange={(event) => setSegmentTimestamps(event.target.checked)}
                    />
                    <span>
                      <strong>{ui("Segment timestamps", "段落时间戳")}</strong>
                      <small>{ui("Return a time range for each speech segment", "返回每个语音片段的时间范围")}</small>
                    </span>
                  </label>
                </>
              )}
            </div>
            <div className="temperature-row">
              <label htmlFor="temperature">{ui("Temperature", "随机度")}</label>
              <input id="temperature" type="range" min="0" max="1" step="0.1" value={temperature} onChange={(event) => setTemperature(Number(event.target.value))} />
              <output>{temperature.toFixed(1)}</output>
            </div>
            <p className="field-note temperature-note">{ui(
              "0 is focused and deterministic; higher values increase output variation.",
              "0 更专注、结果更确定；数值越高，模型输出的随机性越大。",
            )}</p>
          </section>

          <details className="request-preview">
            <summary>
              <span>{ui("View parameters sent to the model", "查看提交给模型的参数")}</span>
              <small>{ui("JSON / API key and audio hidden", "JSON / 已隐藏 API Key 与音频内容")}</small>
            </summary>
            <pre><code>{JSON.stringify(requestPreview, null, 2)}</code></pre>
          </details>

          <div className="action-row">
            <button className="primary-button" type="button" disabled={!canSubmit} onClick={runTranscription}>
              {status === "uploading" ? (
                <><span className="spinner" />{roundedUploadPercent < 100 ? ui("Uploading", "正在上传") : ui("Transcribing", "正在转写")}</>
              ) : <>{ui("Start transcription", "开始转写")} <span aria-hidden="true">→</span></>}
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
                    setAudioToolMessage(ui(
                      "Automatic segmentation cancelled. The audio engine must reload before the next operation.",
                      "已取消自动分段。再次处理时需要重新加载音频核心。",
                    ));
                  }
                }}
              >
                {ui("Cancel", "取消")}
              </button>
            ) : file ? (
              <button className="text-button" type="button" onClick={reset}>{ui("Choose again", "重新选择")}</button>
            ) : null}
          </div>

          {uploadProgress && (
            <div className={`upload-progress-card ${status === "error" ? "is-error" : ""}`} aria-live="polite">
              <div className="upload-progress-heading">
                <span>{uploadStageLabel}</span>
                <strong>
                  {uploadProgress.computable || roundedUploadPercent >= 100
                    ? `${roundedUploadPercent}%`
                    : ui("Calculating", "计算中")}
                </strong>
              </div>
              <progress
                max="100"
                value={uploadProgress.computable || roundedUploadPercent >= 100
                  ? roundedUploadPercent
                  : undefined}
                aria-label={ui("Audio upload progress", "音频上传进度")}
              />
              <div className="upload-progress-meta">
                {uploadProgress.computable && uploadProgress.total > 0 ? (
                  <span>
                    {formatBytes(Math.min(uploadProgress.loaded, uploadProgress.total))}
                    {" / "}{formatBytes(uploadProgress.total)}
                  </span>
                ) : (
                  <span>{ui("Exact uploaded bytes are unavailable in streaming mode", "流式模式下浏览器不提供精确上传字节")}</span>
                )}
                <span>{segmentBatch?.fileName || file?.name}</span>
              </div>
            </div>
          )}

          {(audioDiagnostics || requestDebug) && (
            <details className="request-preview debug-preview">
              <summary>
                <span>{ui("View deep diagnostics", "查看深度诊断信息")}</span>
                <small>{ui("SHA-256 / full decode / provider request ID", "SHA-256 / 完整解码 / Provider Request ID")}</small>
              </summary>
              <div className="debug-preview-toolbar">
                <span>
                  {ui("Local decode: ", "本地解码：")}{
                    audioDiagnostics?.ffmpeg_full_decode === "passed"
                      ? ui("passed", "通过")
                      : audioDiagnostics ? ui("failed", "失败") : ui("not run", "未运行")
                  }
                </span>
                <button type="button" onClick={copyDiagnostics}>
                  {diagnosticCopied ? ui("Copied", "已复制") : ui("Copy diagnostic JSON", "复制诊断 JSON")}
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
              <h2>{ui("Transcript", "转写稿")}</h2>
            </div>
            <div className={`status-badge status-${status}`}><span />{STATUS_COPY[status][locale]}</div>
          </div>

          {status === "uploading" && (
            <div className="processing-card">
              <div className="wave" aria-hidden="true">{[1,2,3,4,5,6,7,8,9].map((bar) => <i key={bar} />)}</div>
              <strong>{ui("Listening to your recording…", "正在听取你的录音…")}</strong>
              <span>{ui("Keep this page open", "请保持页面开启")}</span>
            </div>
          )}

          {transcript ? (
            <>
              <textarea
                className="transcript-editor"
                aria-label={ui("Transcription result", "转写结果")}
                value={transcript}
                onChange={(event) => setTranscript(event.target.value)}
              />
              <div className="transcript-actions">
                <span>
                  {transcript.length.toLocaleString(locale === "en" ? "en-US" : "zh-CN")} {ui("characters", "字符")}
                </span>
                <div>
                  <button type="button" onClick={copyTranscript}>{copied ? ui("Copied", "已复制") : ui("Copy all", "复制全文")}</button>
                  <button className="download-button" type="button" onClick={downloadTranscript}>{ui("Download .md", "下载 .md")}</button>
                </div>
              </div>
            </>
          ) : status !== "uploading" ? (
            <div className="empty-transcript">
              <span className="quote-mark" aria-hidden="true">“</span>
              <p>{ui("Your transcript will appear here.", "转写结果会出现在这里。")}</p>
              <span>{ui("Complete the three steps, then start transcription.", "完成前三步，然后开始转写。")}</span>
            </div>
          ) : null}

          {message && <p className={`status-message ${status === "error" ? "is-error" : ""}`}>{message}</p>}

          <footer className="transcript-footer">
            <span>{ui("Audio is sent directly to", "音频直接发送至")} {providerName} API</span>
            <a
              href={isOpenRouter ? "https://openrouter.ai/settings/keys" : "https://platform.openai.com/api-keys"}
              target="_blank"
              rel="noreferrer"
            >
              {ui("Manage", "管理")} {providerName} API Key ↗
            </a>
          </footer>
        </section>
      </section>

      <footer className="page-footer">
        <span>HENRY.H / WHISPER DESK</span>
        <p>{ui(
          "Designed for a personal, private, and direct transcription workflow.",
          "为个人、私密且直接的转写工作流而设计。",
        )}</p>
      </footer>
    </main>
  );
}
