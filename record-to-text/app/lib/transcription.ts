export type TranscriptionOptions = {
  apiKey: string;
  file: File;
  model: string;
  language: string;
  prompt: string;
  temperature: number;
  chunkingStrategy: string;
  speakerDiarization: boolean;
  includeTimestamps: boolean;
  signal?: AbortSignal;
};

type OpenAIErrorBody = {
  error?: { message?: string };
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

export async function transcribeAudio({
  apiKey,
  file,
  model,
  language,
  prompt,
  temperature,
  chunkingStrategy,
  speakerDiarization,
  includeTimestamps,
  signal,
}: TranscriptionOptions): Promise<string> {
  const body = new FormData();
  body.append("file", file, file.name);
  body.append("model", model);
  body.append("response_format", speakerDiarization ? "diarized_json" : "json");
  body.append("temperature", String(temperature));

  if (language) {
    if (model === "gpt-transcribe") {
      body.append("languages[]", language);
    } else {
      body.append("language", language);
    }
  }
  if (!speakerDiarization && prompt.trim()) body.append("prompt", prompt.trim());
  if (speakerDiarization || chunkingStrategy === "auto") {
    body.append("chunking_strategy", "auto");
  }

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey.trim()}` },
    body,
    signal,
  });

  const payload = (await response.json().catch(() => ({}))) as
    | TranscriptionBody
    | OpenAIErrorBody;

  if (!response.ok) {
    const message = "error" in payload ? payload.error?.message : undefined;
    throw new Error(message || `OpenAI 请求失败（HTTP ${response.status}）`);
  }

  if (!("text" in payload) || typeof payload.text !== "string") {
    throw new Error("OpenAI 返回了无法识别的转写结果。");
  }

  if (speakerDiarization && "segments" in payload && Array.isArray(payload.segments)) {
    const formatted = formatDiarizedTranscript(payload.segments, includeTimestamps);
    if (formatted) return formatted;
  }

  return payload.text.trim();
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
