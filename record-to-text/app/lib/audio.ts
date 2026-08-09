export const OPENAI_FILE_LIMIT = 25 * 1024 * 1024;

export const SUPPORTED_EXTENSIONS = [
  "mp3",
  "mp4",
  "mpeg",
  "mpga",
  "m4a",
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
  if (file.size > OPENAI_FILE_LIMIT) {
    return `文件为 ${formatBytes(file.size)}，超过 OpenAI 的 25 MB 上传限制。请先用原项目的压缩工具处理后再选择。`;
  }
  return null;
}

export function baseName(filename: string): string {
  return filename.replace(/\.[^.]+$/, "") || "transcript";
}
