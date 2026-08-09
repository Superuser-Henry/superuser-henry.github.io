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

  assert.match(workbench, /useState\("gpt-4o-mini-transcribe"\)/);
  assert.match(workbench, /gpt-4o-transcribe-diarize/);
  assert.match(workbench, /区分说话人/);
  assert.match(workbench, /显示分段时间/);
  assert.match(workbench, /随机度/);
  assert.doesNotMatch(workbench, /value="gpt-transcribe"/);
  assert.match(workbench, /type=\{showKey \? "text" : "password"\}/);
  assert.doesNotMatch(workbench, /localStorage|sessionStorage|document\.cookie/);
  assert.doesNotMatch(workbench, /sk-[A-Za-z0-9]{12,}/);
  assert.doesNotMatch(packageJson, /vinext|cloudflare|drizzle|next|tailwind/i);
});

test("formats diarized responses and enables automatic chunking", async () => {
  const transcription = await readFile(
    new URL("app/lib/transcription.ts", root),
    "utf8",
  );

  assert.match(transcription, /response_format.*diarized_json/);
  assert.match(transcription, /chunking_strategy.*auto/);
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
