import {
  baseName,
  targetVbrBitrateKbps,
} from "./audio";

const CORE_VERSION = "0.12.10";
const CORE_BASE_URLS = [
  `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`,
  `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm`,
] as const;

type FFmpegInstance = import("@ffmpeg/ffmpeg").FFmpeg;

export type AudioProcessingStage = "loading" | "processing";

export interface AudioProcessingProgress {
  stage: AudioProcessingStage;
  progress: number;
  message: string;
}

export interface CompressedAudioResult {
  file: File;
  durationSeconds: number;
  targetBitrateKbps: number;
}

async function verifyProcessedDuration(
  file: File,
  expectedDurationSeconds?: number,
): Promise<number> {
  const actualDuration = await readAudioDuration(file);
  if (expectedDurationSeconds) {
    const tolerance = Math.max(3, expectedDurationSeconds * 0.01);
    if (Math.abs(actualDuration - expectedDurationSeconds) > tolerance) {
      throw new Error(
        `处理后的音频时长不完整（原始约 ${Math.round(expectedDurationSeconds)} 秒，` +
        `输出约 ${Math.round(actualDuration)} 秒），已阻止上传。`,
      );
    }
  }
  return actualDuration;
}

let engine: FFmpegInstance | null = null;
let enginePromise: Promise<FFmpegInstance> | null = null;

function safeExtension(filename: string): string {
  const extension = filename.split(".").pop()?.toLowerCase();
  return extension?.replace(/[^a-z0-9]/g, "") || "audio";
}

function uint8ArrayToBlobPart(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  ) as ArrayBuffer;
}

async function loadEngine(
  onProgress?: (progress: AudioProcessingProgress) => void,
): Promise<FFmpegInstance> {
  if (engine) return engine;
  if (enginePromise) return enginePromise;

  enginePromise = (async () => {
    onProgress?.({
      stage: "loading",
      progress: 0,
      message: "首次使用：正在加载约 31 MB 的音频处理核心…",
    });

    const [{ FFmpeg }, { toBlobURL }] = await Promise.all([
      import("@ffmpeg/ffmpeg"),
      import("@ffmpeg/util"),
    ]);
    const nextEngine = new FFmpeg();
    let lastError: unknown;
    let loaded = false;
    for (const baseUrl of CORE_BASE_URLS) {
      try {
        const [coreURL, wasmURL] = await Promise.all([
          toBlobURL(`${baseUrl}/ffmpeg-core.js`, "text/javascript"),
          toBlobURL(`${baseUrl}/ffmpeg-core.wasm`, "application/wasm"),
        ]);
        await nextEngine.load({ coreURL, wasmURL });
        loaded = true;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!loaded) {
      throw new Error(
        `无法下载音频处理核心。请检查网络、广告拦截或稍后再试。${
          lastError instanceof Error ? ` (${lastError.message})` : ""
        }`,
      );
    }
    engine = nextEngine;
    onProgress?.({
      stage: "loading",
      progress: 1,
      message: "音频处理核心已就绪。",
    });
    return nextEngine;
  })().catch((error) => {
    enginePromise = null;
    throw error;
  });

  return enginePromise;
}

export function readAudioDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const audio = document.createElement("audio");
    const objectUrl = URL.createObjectURL(file);
    const cleanup = () => {
      URL.revokeObjectURL(objectUrl);
      audio.removeAttribute("src");
      audio.load();
    };

    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      const duration = audio.duration;
      cleanup();
      if (Number.isFinite(duration) && duration > 0) resolve(duration);
      else reject(new Error("浏览器没有返回有效的音频时长。"));
    };
    audio.onerror = () => {
      cleanup();
      reject(new Error("浏览器无法读取此音频的时长或容器信息。"));
    };
    audio.src = objectUrl;
  });
}

async function processWithEngine(
  file: File,
  outputName: string,
  args: string[],
  mimeType: string,
  onProgress?: (progress: AudioProcessingProgress) => void,
): Promise<File> {
  const ffmpeg = await loadEngine(onProgress);
  const inputName = `input-${crypto.randomUUID()}.${safeExtension(file.name)}`;
  const virtualOutputName = `output-${crypto.randomUUID()}.${outputName.split(".").pop()}`;
  const { fetchFile } = await import("@ffmpeg/util");
  const progressHandler = ({ progress }: { progress: number }) => {
    onProgress?.({
      stage: "processing",
      progress: Math.max(0, Math.min(1, progress)),
      message: "正在本地转码；文件不会上传到第三方服务…",
    });
  };

  ffmpeg.on("progress", progressHandler);
  try {
    await ffmpeg.writeFile(inputName, await fetchFile(file));
    const exitCode = await ffmpeg.exec(["-i", inputName, ...args, virtualOutputName]);
    if (exitCode !== 0) throw new Error(`音频处理失败（FFmpeg exit ${exitCode}）。`);
    const output = await ffmpeg.readFile(virtualOutputName);
    if (typeof output === "string") throw new Error("音频处理返回了无效数据。");
    return new File([uint8ArrayToBlobPart(output)], outputName, {
      type: mimeType,
      lastModified: Date.now(),
    });
  } finally {
    ffmpeg.off("progress", progressHandler);
    await Promise.allSettled([
      ffmpeg.deleteFile(inputName),
      ffmpeg.deleteFile(virtualOutputName),
    ]);
  }
}

export async function compressAudioForUpload(
  file: File,
  targetMb: number,
  minimumBitrateKbps: number,
  onProgress?: (progress: AudioProcessingProgress) => void,
): Promise<CompressedAudioResult> {
  const durationSeconds = await readAudioDuration(file);
  const targetBitrateKbps = targetVbrBitrateKbps(
    targetMb,
    durationSeconds,
    minimumBitrateKbps,
  );
  const outputName = `${baseName(file.name)}-compressed.mp3`;
  const output = await processWithEngine(
    file,
    outputName,
    [
      "-map",
      "0:a:0",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "libmp3lame",
      "-b:a",
      `${targetBitrateKbps}k`,
      "-abr",
      "1",
      "-compression_level",
      "2",
      "-map_metadata",
      "-1",
      "-id3v2_version",
      "3",
      "-write_xing",
      "1",
    ],
    "audio/mpeg",
    onProgress,
  );
  await verifyProcessedDuration(output, durationSeconds);
  return { file: output, durationSeconds, targetBitrateKbps };
}

export async function repairAudioAsWav(
  file: File,
  onProgress?: (progress: AudioProcessingProgress) => void,
): Promise<File> {
  const output = await processWithEngine(
    file,
    `${baseName(file.name)}-repaired.wav`,
    [
      "-map",
      "0:a:0",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      "-map_metadata",
      "-1",
    ],
    "audio/wav",
    onProgress,
  );
  await verifyProcessedDuration(output);
  return output;
}

export function cancelAudioProcessing(): void {
  engine?.terminate();
  engine = null;
  enginePromise = null;
}
