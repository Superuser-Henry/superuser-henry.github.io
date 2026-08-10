export type ChunkingStrategy = "single" | "auto" | "server_vad";
export type ResponseFormat =
  | "json"
  | "text"
  | "srt"
  | "verbose_json"
  | "vtt"
  | "diarized_json";
export type TimestampGranularity = "word" | "segment";

export type TranscriptionRequestOptions = {
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
};

export type TranscriptionOptions = TranscriptionRequestOptions & {
  apiKey: string;
  onPartialTranscript?: (text: string) => void;
  onUploadProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
};

export type UploadProgress = {
  loaded: number;
  total: number;
  percent: number;
  computable: boolean;
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
  body: FormData;
  preview: Record<string, unknown>;
};

const ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
const LOGPROB_MODELS = new Set([
  "gpt-4o-transcribe",
  "gpt-4o-mini-transcribe",
  "gpt-4o-mini-transcribe-2025-12-15",
]);

export function getTranscriptionRequestPreview(
  options: TranscriptionRequestOptions,
): Record<string, unknown> {
  return buildRequestParts(options).preview;
}

export async function transcribeAudio({
  apiKey,
  signal,
  onPartialTranscript,
  onUploadProgress,
  ...requestOptions
}: TranscriptionOptions): Promise<string> {
  const { body } = buildRequestParts(requestOptions);

  if (!requestOptions.stream || requestOptions.model === "whisper-1") {
    const raw = await sendTranscriptionWithUploadProgress(
      body,
      apiKey,
      signal,
      onUploadProgress,
    );
    return parseTranscriptionResponse(raw, requestOptions);
  }

  onUploadProgress?.({
    loaded: 0,
    total: requestOptions.file.size,
    percent: 0,
    computable: false,
  });
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey.trim()}` },
    body,
    signal,
  });

  if (!response.ok) {
    throw await createRequestError(response);
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
    onPartialTranscript,
  );
}

function parseTranscriptionResponse(
  raw: string,
  options: TranscriptionRequestOptions,
): string {
  if (["text", "srt", "vtt"].includes(options.responseFormat)) {
    return raw.trim();
  }

  let payload: TranscriptionBody;
  try {
    payload = JSON.parse(raw) as TranscriptionBody;
  } catch {
    throw new Error("OpenAI 返回了无法解析的转写结果。");
  }
  if (typeof payload.text !== "string") {
    throw new Error("OpenAI 返回了无法识别的转写结果。");
  }

  if (options.speakerDiarization && Array.isArray(payload.segments)) {
    const formatted = formatDiarizedTranscript(
      payload.segments,
      options.includeTimestamps,
    );
    if (formatted) return formatted;
  }

  return payload.text.trim();
}

function sendTranscriptionWithUploadProgress(
  body: FormData,
  apiKey: string,
  signal?: AbortSignal,
  onUploadProgress?: (progress: UploadProgress) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abortRequest = () => request.abort();
    const cleanup = () => signal?.removeEventListener("abort", abortRequest);

    request.open("POST", ENDPOINT);
    request.setRequestHeader("Authorization", `Bearer ${apiKey.trim()}`);
    request.upload.onprogress = (event) => {
      const total = event.lengthComputable ? event.total : 0;
      onUploadProgress?.({
        loaded: event.loaded,
        total,
        percent: total > 0 ? Math.min(100, (event.loaded / total) * 100) : 0,
        computable: event.lengthComputable,
      });
    };
    request.upload.onload = () => {
      onUploadProgress?.({
        loaded: body.get("file") instanceof File ? (body.get("file") as File).size : 0,
        total: body.get("file") instanceof File ? (body.get("file") as File).size : 0,
        percent: 100,
        computable: true,
      });
    };
    request.onload = () => {
      cleanup();
      if (request.status >= 200 && request.status < 300) {
        resolve(request.responseText);
      } else {
        reject(createRequestErrorFromRaw(request.status, request.responseText));
      }
    };
    request.onerror = () => {
      cleanup();
      reject(new TypeError("Network request failed"));
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

function buildRequestParts(options: TranscriptionRequestOptions): RequestParts {
  const body = new FormData();
  const submitted: Record<string, unknown> = {};
  const add = (name: string, value: string, previewValue: unknown = value) => {
    body.append(name, value);
    if (name.endsWith("[]")) {
      const previous = submitted[name];
      submitted[name] = Array.isArray(previous)
        ? [...previous, previewValue]
        : [previewValue];
    } else {
      submitted[name] = previewValue;
    }
  };

  body.append("file", options.file, options.file.name);
  submitted.file = {
    name: options.file.name,
    type: options.file.type || "application/octet-stream",
    size_bytes: options.file.size,
  };
  add("model", options.model);
  add("response_format", options.responseFormat);
  add("temperature", String(options.temperature), options.temperature);

  const languages = options.languages.filter(Boolean);
  if (options.model === "gpt-transcribe") {
    languages.forEach((language) => add("languages[]", language));
    options.keywords
      .filter(Boolean)
      .forEach((keyword) => add("keywords[]", keyword));
  } else if (languages[0]) {
    add("language", languages[0]);
  }

  if (options.model !== "gpt-4o-transcribe-diarize" && options.prompt.trim()) {
    add("prompt", options.prompt.trim());
  }

  // Whisper's matching Python workflow sends the file as one block. Omitting
  // chunking_strategy also prevents unsupported-parameter 400 responses.
  if (options.model !== "whisper-1" && options.chunkingStrategy !== "single") {
    if (options.chunkingStrategy === "auto") {
      add("chunking_strategy", "auto");
    } else {
      const vadConfig = {
        type: "server_vad",
        prefix_padding_ms: options.vadPrefixPaddingMs,
        silence_duration_ms: options.vadSilenceDurationMs,
        threshold: options.vadThreshold,
      };
      add("chunking_strategy", JSON.stringify(vadConfig), vadConfig);
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
    add("stream", "true", true);
  }

  if (options.model === "whisper-1" && options.responseFormat === "verbose_json") {
    options.timestampGranularities.forEach((granularity) =>
      add("timestamp_granularities[]", granularity),
    );
  }

  return {
    body,
    preview: {
      endpoint: ENDPOINT,
      method: "POST",
      content_type: "multipart/form-data",
      authorization: "Bearer [hidden]",
      body: submitted,
    },
  };
}

async function createRequestError(response: Response): Promise<Error> {
  const raw = await response.text();
  return createRequestErrorFromRaw(response.status, raw);
}

function createRequestErrorFromRaw(status: number, raw: string): Error {
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
  ].filter(Boolean);
  const message = apiError?.message || raw.trim() || "未返回错误说明";
  return new Error(
    `OpenAI 请求失败（HTTP ${status}）：${message}${
      details.length ? `\n${details.join(" · ")}` : ""
    }`,
  );
}

async function readTranscriptionStream(
  response: Response,
  speakerDiarization: boolean,
  includeTimestamps: boolean,
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
    return formatDiarizedTranscript(segments, includeTimestamps);
  }
  const result = (finalText || partialText).trim();
  if (!result) throw new Error("OpenAI 的流式响应中没有转写文字。");
  return result;
}

function formatDiarizedTranscript(
  segments: DiarizedSegment[],
  includeTimestamps: boolean,
): string {
  return segments
    .filter((segment) => typeof segment.text === "string" && segment.text.trim())
    .map((segment) => {
      const speaker = segment.speaker?.trim() || "?";
      const label = `说话人 ${speaker}`;
      const timestamp = includeTimestamps
        ? `[${formatTimestamp(segment.start)}–${formatTimestamp(segment.end)}] `
        : "";
      return `${timestamp}${label}：${segment.text?.trim()}`;
    })
    .join("\n\n");
}

function formatTimestamp(seconds?: number): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "--:--";
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(wholeSeconds / 60);
  const remainder = wholeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
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
