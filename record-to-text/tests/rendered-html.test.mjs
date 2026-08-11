import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("builds a GitHub Pages-compatible static entry", async () => {
  const html = await readFile(new URL("dist/index.html", root), "utf8");

  assert.match(html, /<title>Whisper Desk/);
  assert.match(html, /<div id="root"><\/div>/);
  assert.match(html, /\.\/assets\//);
  assert.doesNotMatch(html, /_next|vinext|cloudflare/i);
});

test("uses a supported transcription model and keeps credentials ephemeral", async () => {
  const [workbench, packageJson] = await Promise.all([
    readFile(new URL("app/TranscriptionWorkbench.tsx", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
  ]);

  assert.match(workbench, /useState\("gpt-transcribe"\)/);
  assert.match(workbench, /value="gpt-transcribe"/);
  assert.match(workbench, /OpenAI: GPT Transcribe · 推荐/);
  assert.doesNotMatch(workbench, /gpt-4o-transcribe-diarize/);
  assert.match(workbench, /value="openrouter"/);
  assert.match(workbench, /x-ai\/grok-stt-1\.0/);
  assert.match(workbench, /openai\/whisper-large-v3-turbo/);
  assert.match(workbench, /const effectiveModel = model/);
  assert.match(workbench, /自动判断人数并尝试读取逐词 speaker 编号/);
  assert.match(workbench, /中文（偏好简体）/);
  assert.match(workbench, /英文/);
  assert.match(workbench, /日语/);
  assert.match(workbench, /法语/);
  assert.match(workbench, /意大利语/);
  assert.match(workbench, /value: "zh-cn,en"/);
  assert.match(workbench, /supportsMultipleLanguages/);
  assert.doesNotMatch(workbench, /speakerDiarization\s*\?\s*"gpt-4o-transcribe-diarize"/);
  assert.match(workbench, /显示分段时间/);
  assert.match(workbench, /随机度/);
  assert.match(workbench, /关键词提示/);
  assert.match(workbench, /手动设置 VAD/);
  assert.match(workbench, /流式返回/);
  assert.match(workbench, /返回 Logprobs/);
  assert.match(workbench, /查看提交给模型的参数/);
  assert.match(workbench, /压缩到约/);
  assert.match(workbench, /兼容修复为 WAV/);
  assert.match(workbench, /最低码率/);
  assert.match(workbench, /仅在本机处理/);
  assert.match(workbench, /深度检查文件/);
  assert.match(workbench, /查看深度诊断信息/);
  assert.match(workbench, /复制诊断 JSON/);
  assert.match(workbench, /音频上传进度/);
  assert.match(workbench, /正在上传音频到 \$\{providerName\}/);
  assert.match(workbench, /JSON\.stringify\(requestPreview/);
  assert.match(workbench, /type=\{showKey \? "text" : "password"\}/);
  assert.doesNotMatch(workbench, /localStorage|sessionStorage|document\.cookie/);
  assert.doesNotMatch(workbench, /sk-[A-Za-z0-9]{12,}/);
  assert.doesNotMatch(packageJson, /vinext|cloudflare|drizzle|next|tailwind/i);
});

test("processes oversized audio locally with lazy-loaded ffmpeg", async () => {
  const [audio, processor, packageJson] = await Promise.all([
    readFile(new URL("app/lib/audio.ts", root), "utf8"),
    readFile(new URL("app/lib/audioProcessing.ts", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
  ]);

  assert.match(audio, /DEFAULT_COMPRESSION_TARGET_MB = 22/);
  assert.match(audio, /DEFAULT_MINIMUM_BITRATE_KBPS = 24/);
  assert.match(audio, /targetVbrBitrateKbps/);
  assert.doesNotMatch(audio, /file\.size > OPENAI_FILE_LIMIT/);
  assert.match(processor, /import\("@ffmpeg\/ffmpeg"\)/);
  assert.match(processor, /libmp3lame/);
  assert.match(processor, /"-abr",\s*\n\s*"1"/);
  assert.match(processor, /"-ac",\s*\n\s*"1"/);
  assert.match(processor, /"-c:a",\s*\n\s*"pcm_s16le"/);
  assert.match(processor, /verifyProcessedDuration/);
  assert.match(processor, /diagnoseAudioFile/);
  assert.match(processor, /SHA-256/);
  assert.match(processor, /"-xerror"/);
  assert.match(processor, /ffmpeg_full_decode/);
  assert.match(processor, /CORE_BASE_URLS/);
  assert.match(processor, /STANDARD_TRANSCRIPTION_MAX_SECONDS = 1800/);
  assert.match(processor, /STANDARD_TRANSCRIPTION_SEGMENT_SECONDS = 1800/);
  assert.match(processor, /prepareAudioSegmentsForUpload/);
  assert.match(processor, /"-f",\s*\n\s*"segment"/);
  assert.match(processor, /"-segment_time"/);
  assert.match(processor, /ffmpeg\.listDir/);
  assert.match(processor, /segment\.size > OPENAI_FILE_LIMIT/);
  assert.match(packageJson, /@ffmpeg\/ffmpeg/);
  assert.match(packageJson, /@ffmpeg\/util/);
});

test("supports provider-specific requests, diarization, and automatic chunking", async () => {
  const [transcription, workbench] = await Promise.all([
    readFile(new URL("app/lib/transcription.ts", root), "utf8"),
    readFile(new URL("app/TranscriptionWorkbench.tsx", root), "utf8"),
  ]);

  assert.match(transcription, /add\("response_format", options\.responseFormat\)/);
  assert.match(transcription, /https:\/\/openrouter\.ai\/api\/v1\/audio\/transcriptions/);
  assert.match(transcription, /input_audio/);
  assert.match(transcription, /arrayBufferToBase64/);
  assert.match(transcription, /"x-ai": grokOptions/);
  assert.match(transcription, /diarize: options\.speakerDiarization/);
  assert.match(transcription, /filler_words/);
  assert.match(transcription, /vad_threshold/);
  assert.match(transcription, /x-generation-id/);
  assert.match(transcription, /chunking_strategy.*auto/);
  assert.match(transcription, /model === "gpt-transcribe"/);
  assert.match(transcription, /languages\[\]/);
  assert.match(transcription, /keywords\[\]/);
  assert.match(transcription, /model !== "whisper-1"/);
  assert.match(transcription, /server_vad/);
  assert.match(transcription, /include\[\]/);
  assert.match(transcription, /timestamp_granularities\[\]/);
  assert.match(transcription, /createRequestError/);
  assert.match(transcription, /XMLHttpRequest/);
  assert.match(transcription, /request\.upload\.onprogress/);
  assert.match(transcription, /onUploadProgress/);
  assert.match(transcription, /X-Client-Request-Id/);
  assert.match(transcription, /x-request-id/);
  assert.match(transcription, /openai-processing-ms/);
  assert.match(transcription, /authorization: "Bearer \[hidden\]"/);
  assert.match(transcription, /formatDiarizedTranscript/);
  assert.match(transcription, /formatDiarizedWords/);
  assert.match(transcription, /timestampOffsetSeconds/);
  assert.match(transcription, /formatTimestampWithOffset/);
  assert.match(transcription, /mergeTranscriptionSegments/);
  assert.match(transcription, /shiftSubtitleTimestamps/);
  assert.match(transcription, /说话人/);
  assert.match(workbench, /client_side_segmentation/);
  assert.match(workbench, /upload_mode: "sequential"/);
  assert.match(workbench, /segmented_request_streaming: false/);
  assert.match(workbench, /STANDARD_TRANSCRIPTION_MAX_SECONDS/);
  assert.match(workbench, /prepareAudioSegmentsForUpload/);
  assert.match(workbench, /for \(const segment of prepared\.segments\)/);
  assert.match(workbench, /stream: false/);
  assert.match(workbench, /跨片段的说话人编号可能重新分配/);
  assert.match(workbench, /OPENROUTER_SEGMENT_SECONDS = 600/);
});

test("removes server-only starter files", async () => {
  for (const path of [
    ".openai/hosting.json",
    "worker/index.ts",
    "app/layout.tsx",
    "app/chatgpt-auth.ts",
    "next.config.ts",
    "public/og.png",
  ]) {
    await assert.rejects(access(new URL(path, root)));
  }
});

test("includes the outer GitHub Pages deployment workflow", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/pages.yml", import.meta.url),
    "utf8",
  );

  assert.match(workflow, /branches: \[main\]/);
  assert.match(workflow, /working-directory: record-to-text/);
  assert.match(workflow, /record-to-text\/dist/);
  assert.match(workflow, /actions\/deploy-pages@v4/);
});
