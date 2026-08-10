export const OPENAI_FILE_LIMIT = 25 * 1024 * 1024;
export const DEFAULT_COMPRESSION_TARGET_MB = 22;
export const DEFAULT_MINIMUM_BITRATE_KBPS = 24;

export const SUPPORTED_EXTENSIONS = [
  "mp3",
  "mp4",
  "mpeg",
  "mpga",
  "m4a",
  "flac",
  "ogg",
  "wav",
  "webm",
] as const;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

export function isSupportedAudio(file: File): boolean {
  const extension = file.name.split(".").pop()?.toLowerCase();
  return Boolean(extension && SUPPORTED_EXTENSIONS.includes(extension as never));
}

export function validateAudio(file: File): string | null {
  if (!isSupportedAudio(file)) {
    return `暂不支持此格式。请选择 ${SUPPORTED_EXTENSIONS.join("、")} 文件。`;
  }
  return null;
}

export function recommendedTargetMb(fileSize: number): number {
  const sizeMb = fileSize / (1024 * 1024);
  if (sizeMb > 25) return DEFAULT_COMPRESSION_TARGET_MB;
  return Math.max(1, Math.min(DEFAULT_COMPRESSION_TARGET_MB, Math.floor(sizeMb * 0.8)));
}

export function targetVbrBitrateKbps(
  targetMb: number,
  durationSeconds: number,
  minimumKbps: number,
): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("无法读取音频时长，不能计算目标码率。");
  }

  // Reserve roughly 4% for the WebM container. Opus still varies the bitrate
  // from frame to frame; this value is its target average, not constant bitrate.
  const targetAverage = Math.floor(
    (targetMb * 1024 * 1024 * 8 * 0.96) / durationSeconds / 1000,
  );
  return Math.max(minimumKbps, Math.min(192, targetAverage));
}

export function baseName(filename: string): string {
  return filename.replace(/\.[^.]+$/, "") || "transcript";
}
