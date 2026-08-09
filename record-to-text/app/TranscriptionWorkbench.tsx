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
  formatBytes,
  OPENAI_FILE_LIMIT,
  validateAudio,
} from "./lib/audio";
import { friendlyError, transcribeAudio } from "./lib/transcription";

const DEFAULT_PROMPT =
  "这是中文语音转写。请正确识别以下词汇：OpenAI、Whisper、API。";

type Status = "idle" | "ready" | "uploading" | "done" | "error";

const statusCopy: Record<Status, string> = {
  idle: "等待音频",
  ready: "准备就绪",
  uploading: "正在转写",
  done: "转写完成",
  error: "需要处理",
};

export function TranscriptionWorkbench() {
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState("");
  const [model, setModel] = useState("gpt-transcribe");
  const [language, setLanguage] = useState("zh");
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [temperature, setTemperature] = useState(0);
  const [chunkingStrategy, setChunkingStrategy] = useState("auto");
  const [speakerDiarization, setSpeakerDiarization] = useState(false);
  const [includeTimestamps, setIncludeTimestamps] = useState(true);
  const [transcript, setTranscript] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const acceptFile = (nextFile?: File) => {
    if (!nextFile) return;
    const validation = validateAudio(nextFile);
    setFileError(validation || "");
    setFile(validation ? null : nextFile);
    setTranscript("");
    setMessage("");
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

  const canSubmit = Boolean(apiKey.trim() && file && status !== "uploading");

  const runTranscription = async () => {
    if (!file || !apiKey.trim()) {
      setMessage("请先填写 API Key 并选择音频文件。");
      setStatus("error");
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setStatus("uploading");
    setMessage(
      speakerDiarization
        ? "正在转写并区分说话人。大文件可能需要几分钟。"
        : "正在将音频直接发送至 OpenAI。大文件可能需要几分钟。",
    );
    setTranscript("");

    try {
      const result = await transcribeAudio({
        apiKey,
        file,
        model: speakerDiarization ? "gpt-4o-transcribe-diarize" : model,
        language,
        prompt,
        temperature,
        chunkingStrategy,
        speakerDiarization,
        includeTimestamps,
        signal: controller.signal,
      });
      setTranscript(result);
      setStatus("done");
      setMessage("完成。你可以直接修改文字，或下载为 Markdown。 ");
    } catch (error) {
      setStatus("error");
      setMessage(friendlyError(error));
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
    setFile(null);
    setFileError("");
    setTranscript("");
    setMessage("");
    setStatus("idle");
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="../" aria-label="返回 Henry Huang 主页">
          <span className="brand-name">HENRY<span>.H</span></span>
          <span className="brand-product">/ Whisper Desk</span>
        </a>
        <div className="topbar-actions">
          <div className="privacy-pill">
            <span className="privacy-dot" aria-hidden="true" />
            Key 仅保存在当前页面内存
          </div>
          <a className="home-link" href="../">返回主页</a>
        </div>
      </header>

      <section className="hero" id="top">
        <p className="eyebrow">PERSONAL TOOL / AUDIO TRANSCRIPTION</p>
        <h1>让每一段声音，<br /><em>清晰落在纸上。</em></h1>
        <p className="hero-copy">
          文件准备和结果整理都在浏览器完成。转写时，音频会从你的浏览器直接发送给 OpenAI，不经过自建服务器。
        </p>
        <div className="hero-meta" aria-label="产品特点">
          <span>无需安装</span><span>不保存密钥</span><span>结果可编辑</span>
        </div>
      </section>

      <section className="workspace" aria-label="音频转写工作台">
        <div className="control-column">
          <section className="panel setup-panel">
            <div className="panel-heading">
              <span className="step-number">01</span>
              <div><p className="overline">ACCESS</p><h2>连接 OpenAI</h2></div>
            </div>
            <label className="field-label" htmlFor="api-key">OpenAI API Key</label>
            <div className="key-field">
              <input
                id="api-key"
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="sk-..."
                autoComplete="off"
                spellCheck={false}
              />
              <button type="button" onClick={() => setShowKey((value) => !value)}>
                {showKey ? "隐藏" : "显示"}
              </button>
            </div>
            <p className="field-note">不会写入 Cookie、Local Storage 或项目文件。关闭页面后即清除。</p>
          </section>

          <section className="panel file-panel">
            <div className="panel-heading">
              <span className="step-number">02</span>
              <div><p className="overline">SOURCE</p><h2>选择录音</h2></div>
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
              aria-label="选择或拖放音频文件"
            >
              <span className="drop-glyph" aria-hidden="true">↗</span>
              {file ? (
                <div className="file-summary">
                  <strong>{file.name}</strong>
                  <span>{formatBytes(file.size)} · 准备上传</span>
                </div>
              ) : (
                <div><strong>把音频拖到这里</strong><span>或点击浏览文件</span></div>
              )}
              <span className="file-limit">MP3 · M4A · WAV · WEBM · 最大 {formatBytes(OPENAI_FILE_LIMIT)}</span>
            </div>
            {fileError && <p className="error-copy" role="alert">{fileError}</p>}
          </section>

          <section className="panel settings-panel">
            <div className="panel-heading compact">
              <span className="step-number">03</span>
              <div><p className="overline">DETAILS</p><h2>调整识别</h2></div>
            </div>
            <div className="field-grid">
              <label><span>模型</span>
                <select value={model} onChange={(event) => setModel(event.target.value)}>
                  <option value="gpt-transcribe">OpenAI: GPT Transcribe · 推荐</option>
                  <option value="gpt-4o-mini-transcribe">GPT-4o mini Transcribe</option>
                  <option value="gpt-4o-transcribe">GPT-4o Transcribe</option>
                  <option value="whisper-1">Whisper-1 · 兼容原项目</option>
                </select>
              </label>
              <label><span>语言</span>
                <select value={language} onChange={(event) => setLanguage(event.target.value)}>
                  <option value="zh">中文</option>
                  <option value="en">英语</option>
                  <option value="ja">日语</option>
                  <option value="ko">韩语</option>
                  <option value="es">西班牙语</option>
                  <option value="fr">法语</option>
                  <option value="de">德语</option>
                  <option value="">自动识别</option>
                </select>
              </label>
            </div>
            <div className="field-grid">
              <label><span>音频分段</span>
                <select
                  value={speakerDiarization ? "auto" : chunkingStrategy}
                  disabled={speakerDiarization}
                  onChange={(event) => setChunkingStrategy(event.target.value)}
                >
                  <option value="auto">自动检测语音 · 推荐</option>
                  <option value="single">整段处理</option>
                </select>
              </label>
              <div className="setting-summary">
                <span>当前模式</span>
                <strong>{speakerDiarization ? "多人对话" : "普通转写"}</strong>
              </div>
            </div>
            <div className="recognition-options" aria-label="高级识别选项">
              <label className="option-card" htmlFor="speaker-diarization">
                <input
                  id="speaker-diarization"
                  type="checkbox"
                  aria-label="区分说话人"
                  checked={speakerDiarization}
                  onChange={(event) => setSpeakerDiarization(event.target.checked)}
                />
                <span>
                  <strong>区分说话人</strong>
                  <small>自动识别人数，并标记为说话人 A、B、C…</small>
                </span>
              </label>
              <label
                className={`option-card ${speakerDiarization ? "" : "is-disabled"}`}
                htmlFor="include-speaker-timestamps"
              >
                <input
                  id="include-speaker-timestamps"
                  type="checkbox"
                  aria-label="显示分段时间"
                  checked={includeTimestamps}
                  disabled={!speakerDiarization}
                  onChange={(event) => setIncludeTimestamps(event.target.checked)}
                />
                <span>
                  <strong>显示分段时间</strong>
                  <small>在多人转写稿中加入每段开始与结束时间</small>
                </span>
              </label>
            </div>
            {speakerDiarization && (
              <p className="field-note option-note">
                多人模式使用 GPT-4o Transcribe Diarize。人数由模型自动判断；提示词暂不适用于此模型，音频会自动分段。
              </p>
            )}
            <label className="field-label" htmlFor="prompt">提示词 / 专有名词</label>
            <textarea
              id="prompt"
              value={prompt}
              disabled={speakerDiarization}
              onChange={(event) => setPrompt(event.target.value)}
              rows={3}
            />
            <div className="temperature-row">
              <label htmlFor="temperature">随机度</label>
              <input id="temperature" type="range" min="0" max="1" step="0.1" value={temperature} onChange={(event) => setTemperature(Number(event.target.value))} />
              <output>{temperature.toFixed(1)}</output>
            </div>
            <p className="field-note temperature-note">0 更专注、结果更确定；数值越高，模型输出的随机性越大。</p>
          </section>

          <div className="action-row">
            <button className="primary-button" type="button" disabled={!canSubmit} onClick={runTranscription}>
              {status === "uploading" ? <><span className="spinner" />正在转写</> : <>开始转写 <span aria-hidden="true">→</span></>}
            </button>
            {status === "uploading" ? (
              <button className="text-button" type="button" onClick={() => abortRef.current?.abort()}>取消</button>
            ) : file ? (
              <button className="text-button" type="button" onClick={reset}>重新选择</button>
            ) : null}
          </div>
        </div>

        <section className="transcript-panel" aria-live="polite">
          <div className="transcript-toolbar">
            <div>
              <p className="overline">TRANSCRIPT</p>
              <h2>转写稿</h2>
            </div>
            <div className={`status-badge status-${status}`}><span />{statusCopy[status]}</div>
          </div>

          {status === "uploading" && (
            <div className="processing-card">
              <div className="wave" aria-hidden="true">{[1,2,3,4,5,6,7,8,9].map((bar) => <i key={bar} />)}</div>
              <strong>正在听取你的录音…</strong>
              <span>请保持页面开启</span>
            </div>
          )}

          {transcript ? (
            <>
              <textarea
                className="transcript-editor"
                aria-label="转写结果"
                value={transcript}
                onChange={(event) => setTranscript(event.target.value)}
              />
              <div className="transcript-actions">
                <span>{transcript.length.toLocaleString("zh-CN")} 字符</span>
                <div>
                  <button type="button" onClick={copyTranscript}>{copied ? "已复制" : "复制全文"}</button>
                  <button className="download-button" type="button" onClick={downloadTranscript}>下载 .md</button>
                </div>
              </div>
            </>
          ) : status !== "uploading" ? (
            <div className="empty-transcript">
              <span className="quote-mark" aria-hidden="true">“</span>
              <p>转写结果会出现在这里。</p>
              <span>完成前三步，然后开始转写。</span>
            </div>
          ) : null}

          {message && <p className={`status-message ${status === "error" ? "is-error" : ""}`}>{message}</p>}

          <footer className="transcript-footer">
            <span>音频直接发送至 OpenAI API</span>
            <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">管理 API Key ↗</a>
          </footer>
        </section>
      </section>

      <footer className="page-footer">
        <span>HENRY.H / WHISPER DESK</span>
        <p>为个人、私密且直接的转写工作流而设计。</p>
      </footer>
    </main>
  );
}
