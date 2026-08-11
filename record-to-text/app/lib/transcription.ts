export type ChunkingStrategy = "single" | "auto" | "server_vad";
export type ApiProvider = "openai" | "openrouter";
export type ResponseFormat =
  | "json"
  | "text"
  | "srt"
  | "verbose_json"
  | "vtt";
export type TimestampGranularity = "word" | "segment";

export type TranscriptionRequestOptions = {
  provider: ApiProvider;
  file: File;
  model: string;
  languages: string[];
  prompt: string;
  keywords: string[];
  temperature: number;
  chunkingStrategy: ChunkingStrategy;
  vadThreshold: number;
  vadPrefixPaddingMs: number;
  vadSilenceDurationMs: number;
  responseFormat: ResponseFormat;
  includeLogprobs: boolean;
  stream: boolean;
  timestampGranularities: TimestampGranularity[];
  speakerDiarization: boolean;
  includeTimestamps: boolean;
  grokTextFormatting: boolean;
  grokFillerWords: boolean;
  timestampOffsetSeconds?: number;
};

export type TranscriptionOptions = TranscriptionRequestOptions & {
  apiKey: string;
  onPartialTranscript?: (text: string) => void;
  onUploadProgress?: (progress: UploadProgress) => void;
  onRequestDebug?: (debug: RequestDebugInfo) => void;
  signal?: AbortSignal;
};

export type UploadProgress = {
  loaded: number;
  total: number;
  percent: number;
  computable: boolean;
};

export type RequestDebugInfo = {
  provider: ApiProvider;
  client_request_id: string;
  server_request_id: string | null;
  http_status: number;
  processing_ms: string | null;
  api_version: string | null;
  response_content_type: string | null;
  captured_at: string;
};

type OpenAIErrorBody = {
  error?: {
    message?: string;
    type?: string;
    param?: string | null;
    code?: string | null;
  };
};

type DiarizedSegment = {
  start?: number;
  end?: number;
  speaker?: string;
  text?: string;
};

type TranscriptionBody = {
  text?: string;
  segments?: DiarizedSegment[];
  words?: Array<{
    text?: string;
    start?: number;
    end?: number;
    speaker?: string | number;
  }>;
};

type StreamEvent = {
  type?: string;
  delta?: string;
  text?: string;
  start?: number;
  end?: number;
  speaker?: string;
};

type RequestParts = {
  preview: Record<string, unknown>;
};

const ENDPOINTS: Record<ApiProvider, string> = {
  openai: "https://api.openai.com/v1/audio/transcriptions",
  openrouter: "https://openrouter.ai/api/v1/audio/transcriptions",
};
const LOGPROB_MODELS = new Set([
  "gpt-4o-transcribe",
  "gpt-4o-mini-transcribe",
  "gpt-4o-mini-transcribe-2025-12-15",
]);

export function getTranscriptionRequestPreview(
  options: TranscriptionRequestOptions,
): Record<string, unknown> {
  return buildRequestPreview(options).preview;
}

export async function transcribeAudio({
  apiKey,
  signal,
  onPartialTranscript,
  onUploadProgress,
  onRequestDebug,
  ...requestOptions
}: TranscriptionOptions): Promise<string> {
  const clientRequestId = crypto.randomUUID();

  if (requestOptions.provider === "openrouter") {
    const body = await buildOpenRouterRequestBody(requestOptions);
    const raw = await sendTranscriptionWithUploadProgress(
      JSON.stringify(body),
      "application/json",
      requestOptions.file.size,
      requestOptions.provider,
      apiKey,
      clientRequestId,
      signal,
      onUploadProgress,
      onRequestDebug,
    );
    return parseTranscriptionResponse(raw, requestOptions);
  }

  const body = buildOpenAIFormData(requestOptions);

  if (!requestOptions.stream || requestOptions.model === "whisper-1") {
    const raw = await sendTranscriptionWithUploadProgress(
      body,
      null,
      requestOptions.file.size,
      requestOptions.provider,
      apiKey,
      clientRequestId,
      signal,
      onUploadProgress,
      onRequestDebug,
    );
    return parseTranscriptionResponse(raw, requestOptions);
  }

  onUploadProgress?.({
    loaded: 0,
    total: requestOptions.file.size,
    percent: 0,
    computable: false,
  });
  const response = await fetch(ENDPOINTS.openai, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      "X-Client-Request-Id": clientRequestId,
    },
    body,
    signal,
  });

  const requestDebug = debugInfoFromHeaders(
    requestOptions.provider,
    clientRequestId,
    response.status,
    (name) => response.headers.get(name),
  );
  onRequestDebug?.(requestDebug);
  if (!response.ok) {
    throw await createRequestError(response, requestOptions.provider, requestDebug);
  }

  onUploadProgress?.({
    loaded: requestOptions.file.size,
    total: requestOptions.file.size,
    percent: 100,
    computable: false,
  });

  return readTranscriptionStream(
    response,
    requestOptions.speakerDiarization,
    requestOptions.includeTimestamps,
    requestOptions.timestampOffsetSeconds || 0,
    onPartialTranscript,
  );
}

function parseTranscriptionResponse(
  raw: string,
  options: TranscriptionRequestOptions,
): string {
  if (["srt", "vtt"].includes(options.responseFormat)) {
    return shiftSubtitleTimestamps(
      raw.trim(),
      options.timestampOffsetSeconds || 0,
      options.responseFormat as "srt" | "vtt",
    );
  }
  if (options.responseFormat === "text") {
    return raw.trim();
  }

  let payload: TranscriptionBody;
  try {
    payload = JSON.parse(raw) as TranscriptionBody;
  } catch {
    throw new Error(`${providerLabel(options.provider)} 返回了无法解析的转写结果。`);
  }
  if (typeof payload.text !== "string") {
    throw new Error(`${providerLabel(options.provider)} 返回了无法识别的转写结果。`);
  }

  if (options.speakerDiarization && Array.isArray(payload.words)) {
    const formatted = formatDiarizedWords(
      payload.words,
      options.includeTimestamps,
      options.timestampOffsetSeconds || 0,
    );
    if (formatted) return formatted;
  }

  if (options.speakerDiarization && Array.isArray(payload.segments)) {
    const formatted = formatDiarizedTranscript(
      payload.segments,
      options.includeTimestamps,
      options.timestampOffsetSeconds || 0,
    );
    if (formatted) return formatted;
  }

  return payload.text.trim();
}

export function mergeTranscriptionSegments(
  transcripts: string[],
  responseFormat: ResponseFormat,
): string {
  if (responseFormat === "srt") {
    let cueNumber = 0;
    return transcripts
      .flatMap((transcript) => transcript.trim().split(/\r?\n\r?\n/))
      .map((block) => {
        const lines = block.split(/\r?\n/);
        if (/^\d+$/.test(lines[0]?.trim() || "")) lines.shift();
        cueNumber += 1;
        return `${cueNumber}\n${lines.join("\n")}`;
      })
      .join("\n\n");
  }
  if (responseFormat === "vtt") {
    const bodies = transcripts.map((transcript) =>
      transcript
        .replace(/^\uFEFF?WEBVTT[^\r\n]*(?:\r?\n){1,2}/, "")
        .trim(),
    );
    return `WEBVTT\n\n${bodies.filter(Boolean).join("\n\n")}`;
  }
  return transcripts.join("\n\n---\n\n");
}

export function shiftSubtitleTimestamps(
  transcript: string,
  offsetSeconds: number,
  responseFormat: "srt" | "vtt",
): string {
  if (!offsetSeconds) return transcript;
  const separator = responseFormat === "srt" ? "," : ".";
  const pattern = responseFormat === "srt"
    ? /\b(\d{2,}):(\d{2}):(\d{2}),(\d{3})\b/g
    : /\b(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})\b/g;
  return transcript.replace(pattern, (_match, first, second, third, milliseconds) => {
    const hasHours = responseFormat === "srt" || first !== undefined;
    const hours = hasHours ? Number(first) : 0;
    const minutes = Number(second);
    const seconds = Number(third);
    const millis = Number(milliseconds);
    const shiftedMilliseconds =
      Math.round(offsetSeconds * 1000) +
      (((hours * 60 + minutes) * 60 + seconds) * 1000) +
      millis;
    const shiftedHours = Math.floor(shiftedMilliseconds / 3_600_000);
    const shiftedMinutes = Math.floor((shiftedMilliseconds % 3_600_000) / 60_000);
    const shiftedSeconds = Math.floor((shiftedMilliseconds % 60_000) / 1000);
    const shiftedMillis = shiftedMilliseconds % 1000;
    const hourPrefix = responseFormat === "srt" || shiftedHours > 0
      ? `${String(shiftedHours).padStart(2, "0")}:`
      : "";
    return `${hourPrefix}${String(shiftedMinutes).padStart(2, "0")}:${String(shiftedSeconds).padStart(2, "0")}${separator}${String(shiftedMillis).padStart(3, "0")}`;
  });
}

function sendTranscriptionWithUploadProgress(
  body: FormData | string,
  contentType: string | null,
  sourceFileSize: number,
  provider: ApiProvider,
  apiKey: string,
  clientRequestId: string,
  signal?: AbortSignal,
  onUploadProgress?: (progress: UploadProgress) => void,
  onRequestDebug?: (debug: RequestDebugInfo) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abortRequest = () => request.abort();
    const cleanup = () => signal?.removeEventListener("abort", abortRequest);

    request.open("POST", ENDPOINTS[provider]);
    request.setRequestHeader("Authorization", `Bearer ${apiKey.trim()}`);
    if (contentType) request.setRequestHeader("Content-Type", contentType);
    if (provider === "openai") {
      request.setRequestHeader("X-Client-Request-Id", clientRequestId);
    }
    request.upload.onprogress = (event) => {
      const total = event.lengthComputable ? event.total : 0;
      const percent = total > 0 ? Math.min(100, (event.loaded / total) * 100) : 0;
      onUploadProgress?.({
        loaded: sourceFileSize * (percent / 100),
        total: sourceFileSize,
        percent,
        computable: event.lengthComputable,
      });
    };
    request.upload.onload = () => {
      onUploadProgress?.({
        loaded: sourceFileSize,
        total: sourceFileSize,
        percent: 100,
        computable: true,
      });
    };
    request.onload = () => {
      cleanup();
      const debug = debugInfoFromHeaders(
        provider,
        clientRequestId,
        request.status,
        (name) => request.getResponseHeader(name),
      );
      onRequestDebug?.(debug);
      if (request.status >= 200 && request.status < 300) {
        resolve(request.responseText);
      } else {
        reject(createRequestErrorFromRaw(request.status, request.responseText, provider, debug));
      }
    };
    request.onerror = () => {
      cleanup();
      reject(new Error(
        `无法连接 ${providerLabel(provider)}。请检查网络、浏览器隐私设置或 API Key 后重试。`,
      ));
    };
    request.onabort = () => {
      cleanup();
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };

    if (signal?.aborted) {
      request.abort();
      return;
    }
    signal?.addEventListener("abort", abortRequest, { once: true });
    request.send(body);
  });
}

function debugInfoFromHeaders(
  provider: ApiProvider,
  clientRequestId: string,
  status: number,
  getHeader: (name: string) => string | null,
): RequestDebugInfo {
  return {
    provider,
    client_request_id: clientRequestId,
    server_request_id: provider === "openrouter"
      ? getHeader("x-generation-id")
      : getHeader("x-request-id"),
    http_status: status,
    processing_ms: getHeader("openai-processing-ms"),
    api_version: getHeader("openai-version"),
    response_content_type: getHeader("content-type"),
    captured_at: new Date().toISOString(),
  };
}

function buildOpenAIFormData(options: TranscriptionRequestOptions): FormData {
  const body = new FormData();
  const add = (name: string, value: string) => body.append(name, value);

  add("model", options.model);
  add("response_format", options.responseFormat);
  add("temperature", String(options.temperature));

  const languages = options.languages.filter(Boolean);
  if (options.model === "gpt-transcribe") {
    languages.forEach((language) => add("languages[]", language));
    options.keywords
      .filter(Boolean)
      .forEach((keyword) => add("keywords[]", keyword));
  } else if (languages[0]) {
    add("language", languages[0]);
  }

  if (options.prompt.trim()) {
    add("prompt", options.prompt.trim());
  }

  // Whisper's matching Python workflow sends the file as one block. Omitting
  // chunking_strategy also prevents unsupported-parameter 400 responses.
  if (options.model !== "whisper-1" && options.chunkingStrategy !== "single") {
    if (options.chunkingStrategy === "auto") {
      add("chunking_strategy", "auto");
    } else {
      add("chunking_strategy", JSON.stringify({
        type: "server_vad",
        prefix_padding_ms: options.vadPrefixPaddingMs,
        silence_duration_ms: options.vadSilenceDurationMs,
        threshold: options.vadThreshold,
      }));
    }
  }

  if (
    options.includeLogprobs &&
    options.responseFormat === "json" &&
    LOGPROB_MODELS.has(options.model)
  ) {
    add("include[]", "logprobs");
  }

  if (options.stream && options.model !== "whisper-1") {
    add("stream", "true");
  }

  if (options.model === "whisper-1" && options.responseFormat === "verbose_json") {
    options.timestampGranularities.forEach((granularity) =>
      add("timestamp_granularities[]", granularity),
    );
  }

  body.append("file", options.file, options.file.name);
  return body;
}

function buildRequestPreview(options: TranscriptionRequestOptions): RequestParts {
  const submitted: Record<string, unknown> = {};
  const add = (name: string, value: unknown) => {
    if (name.endsWith("[]")) {
      const previous = submitted[name];
      submitted[name] = Array.isArray(previous) ? [...previous, value] : [value];
    } else {
      submitted[name] = value;
    }
  };

  const filePreview = {
    name: options.file.name,
    type: options.file.type || "application/octet-stream",
    size_bytes: options.file.size,
  };

  if (options.provider === "openrouter") {
    const body: Record<string, unknown> = {
      model: options.model,
      input_audio: {
        data: "[base64 audio hidden]",
        format: audioFormatFor(options.file),
      },
      temperature: options.temperature,
    };
    if (options.languages[0]) body.language = options.languages[0];
    const grokOptions = openRouterGrokOptions(options);
    if (grokOptions) {
      body.provider = { options: { "x-ai": grokOptions } };
    }
    return {
      preview: {
        endpoint: ENDPOINTS.openrouter,
        method: "POST",
        content_type: "application/json",
        authorization: "Bearer [hidden]",
        local_file_debug: filePreview,
        body,
      },
    };
  }

  add("file", filePreview);
  add("model", options.model);
  add("response_format", options.responseFormat);
  add("temperature", options.temperature);

  const languages = options.languages.filter(Boolean);
  if (options.model === "gpt-transcribe") {
    languages.forEach((language) => add("languages[]", language));
    options.keywords.filter(Boolean).forEach((keyword) => add("keywords[]", keyword));
  } else if (languages[0]) {
    add("language", languages[0]);
  }

  if (options.prompt.trim()) add("prompt", options.prompt.trim());

  if (options.model !== "whisper-1" && options.chunkingStrategy !== "single") {
    add("chunking_strategy", options.chunkingStrategy === "auto"
      ? "auto"
      : {
          type: "server_vad",
          prefix_padding_ms: options.vadPrefixPaddingMs,
          silence_duration_ms: options.vadSilenceDurationMs,
          threshold: options.vadThreshold,
        });
  }

  if (
    options.includeLogprobs &&
    options.responseFormat === "json" &&
    LOGPROB_MODELS.has(options.model)
  ) add("include[]", "logprobs");
  if (options.stream && options.model !== "whisper-1") add("stream", true);
  if (options.model === "whisper-1" && options.responseFormat === "verbose_json") {
    options.timestampGranularities.forEach((granularity) =>
      add("timestamp_granularities[]", granularity));
  }

  return {
    preview: {
      endpoint: ENDPOINTS.openai,
      method: "POST",
      content_type: "multipart/form-data",
      authorization: "Bearer [hidden]",
      body: submitted,
    },
  };
}

async function buildOpenRouterRequestBody(
  options: TranscriptionRequestOptions,
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    model: options.model,
    input_audio: {
      data: arrayBufferToBase64(await options.file.arrayBuffer()),
      format: audioFormatFor(options.file),
    },
    temperature: options.temperature,
  };
  if (options.languages[0]) body.language = options.languages[0];
  const grokOptions = openRouterGrokOptions(options);
  if (grokOptions) body.provider = { options: { "x-ai": grokOptions } };
  return body;
}

function openRouterGrokOptions(
  options: TranscriptionRequestOptions,
): Record<string, unknown> | null {
  if (options.model !== "x-ai/grok-stt-1.0") return null;
  return {
    diarize: options.speakerDiarization,
    format: options.grokTextFormatting && Boolean(options.languages[0]),
    filler_words: options.grokFillerWords,
    vad_threshold: options.vadThreshold,
    ...(options.keywords.length ? { keyterm: options.keywords } : {}),
  };
}

function audioFormatFor(file: File): string {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension && ["wav", "mp3", "flac", "m4a", "ogg", "webm", "aac"].includes(extension)) {
    return extension;
  }
  const mimeFormats: Record<string, string> = {
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/mpeg": "mp3",
    "audio/flac": "flac",
    "audio/mp4": "m4a",
    "audio/ogg": "ogg",
    "audio/webm": "webm",
    "audio/aac": "aac",
  };
  return mimeFormats[file.type] || "mp3";
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function createRequestError(
  response: Response,
  provider: ApiProvider,
  debug?: RequestDebugInfo,
): Promise<Error> {
  const raw = await response.text();
  return createRequestErrorFromRaw(response.status, raw, provider, debug);
}

function createRequestErrorFromRaw(
  status: number,
  raw: string,
  provider: ApiProvider,
  debug?: RequestDebugInfo,
): Error {
  let payload: OpenAIErrorBody = {};
  try {
    payload = JSON.parse(raw) as OpenAIErrorBody;
  } catch {
    // Keep the raw response below when the service does not return JSON.
  }

  const apiError = payload.error;
  const details = [
    apiError?.param ? `参数：${apiError.param}` : "",
    apiError?.code ? `代码：${apiError.code}` : "",
    apiError?.type ? `类型：${apiError.type}` : "",
    debug?.server_request_id ? `Request ID：${debug.server_request_id}` : "",
    debug?.client_request_id ? `Client Request ID：${debug.client_request_id}` : "",
  ].filter(Boolean);
  const message = apiError?.message || raw.trim() || "未返回错误说明";
  return new Error(
    `${providerLabel(provider)} 请求失败（HTTP ${status}）：${message}${
      details.length ? `\n${details.join(" · ")}` : ""
    }`,
  );
}

function providerLabel(provider: ApiProvider): string {
  return provider === "openrouter" ? "OpenRouter" : "OpenAI";
}

async function readTranscriptionStream(
  response: Response,
  speakerDiarization: boolean,
  includeTimestamps: boolean,
  timestampOffsetSeconds: number,
  onPartialTranscript?: (text: string) => void,
): Promise<string> {
  if (!response.body) {
    throw new Error("浏览器无法读取 OpenAI 的流式响应。");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const segments: DiarizedSegment[] = [];
  let buffer = "";
  let partialText = "";
  let finalText = "";

  const consumeBlock = (block: string) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") return;

    let event: StreamEvent;
    try {
      event = JSON.parse(data) as StreamEvent;
    } catch {
      return;
    }

    if (event.type === "transcript.text.delta" && event.delta) {
      partialText += event.delta;
      onPartialTranscript?.(partialText);
    } else if (event.type === "transcript.text.done" && event.text) {
      finalText = event.text;
    } else if (event.type === "transcript.text.segment" && event.text) {
      segments.push(event);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || "";
    blocks.forEach(consumeBlock);
    if (done) break;
  }
  if (buffer.trim()) consumeBlock(buffer);

  if (speakerDiarization && segments.length) {
    return formatDiarizedTranscript(
      segments,
      includeTimestamps,
      timestampOffsetSeconds,
    );
  }
  const result = (finalText || partialText).trim();
  if (!result) throw new Error("OpenAI 的流式响应中没有转写文字。");
  return result;
}

function formatDiarizedTranscript(
  segments: DiarizedSegment[],
  includeTimestamps: boolean,
  timestampOffsetSeconds = 0,
): string {
  return segments
    .filter((segment) => typeof segment.text === "string" && segment.text.trim())
    .map((segment) => {
      const speaker = segment.speaker?.trim() || "?";
      const label = `说话人 ${speaker}`;
      const timestamp = includeTimestamps
        ? `[${formatTimestampWithOffset(segment.start, timestampOffsetSeconds)}–${formatTimestampWithOffset(segment.end, timestampOffsetSeconds)}] `
        : "";
      return `${timestamp}${label}：${segment.text?.trim()}`;
    })
    .join("\n\n");
}

function formatDiarizedWords(
  words: NonNullable<TranscriptionBody["words"]>,
  includeTimestamps: boolean,
  timestampOffsetSeconds = 0,
): string {
  const groups: Array<{
    speaker: string;
    start?: number;
    end?: number;
    words: string[];
  }> = [];

  words.forEach((word) => {
    const text = word.text?.trim();
    if (!text) return;
    const speaker = String(word.speaker ?? "?");
    const current = groups.at(-1);
    if (!current || current.speaker !== speaker) {
      groups.push({
        speaker,
        start: word.start,
        end: word.end,
        words: [text],
      });
      return;
    }
    current.words.push(text);
    current.end = word.end;
  });

  return groups.map((group) => {
    const text = group.words
      .join(" ")
      .replace(/\s+([,.;:!?，。；：！？])/g, "$1");
    const timestamp = includeTimestamps
      ? `[${formatTimestampWithOffset(group.start, timestampOffsetSeconds)}–${formatTimestampWithOffset(group.end, timestampOffsetSeconds)}] `
      : "";
    return `${timestamp}说话人 ${group.speaker}：${text}`;
  }).join("\n\n");
}

function formatTimestampWithOffset(seconds: number | undefined, offset: number): string {
  return formatTimestamp(
    typeof seconds === "number" && Number.isFinite(seconds)
      ? seconds + offset
      : seconds,
  );
}

function formatTimestamp(seconds?: number): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "--:--";
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const remainder = wholeSeconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

export function friendlyError(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "转写已取消。";
  }
  if (error instanceof TypeError) {
    return "无法连接 OpenAI。请检查网络、浏览器隐私设置或 API Key 后重试。";
  }
  return error instanceof Error ? error.message : "转写失败，请稍后重试。";
}
