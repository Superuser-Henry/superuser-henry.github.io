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
  assert.match(workbench, /gpt-4o-transcribe-diarize/);
  assert.match(workbench, /区分说话人/);
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
  assert.match(workbench, /音频上传进度/);
  assert.match(workbench, /正在上传音频到 OpenAI/);
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
  assert.match(processor, /CORE_BASE_URLS/);
  assert.match(packageJson, /@ffmpeg\/ffmpeg/);
  assert.match(packageJson, /@ffmpeg\/util/);
});

test("formats diarized responses and enables automatic chunking", async () => {
  const [transcription, workbench] = await Promise.all([
    readFile(new URL("app/lib/transcription.ts", root), "utf8"),
    readFile(new URL("app/TranscriptionWorkbench.tsx", root), "utf8"),
  ]);

  assert.match(transcription, /add\("response_format", options\.responseFormat\)/);
  assert.match(workbench, /diarized_json/);
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
  assert.match(transcription, /authorization: "Bearer \[hidden\]"/);
  assert.match(transcription, /formatDiarizedTranscript/);
  assert.match(transcription, /说话人/);
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
