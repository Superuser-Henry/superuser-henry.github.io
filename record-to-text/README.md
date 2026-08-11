# Whisper Desk Web

纯静态的个人音频转写工作台。网页读取本地音频，并从浏览器直接调用 OpenAI 或 OpenRouter 的 Audio Transcriptions API；项目不包含业务后端，也不会把 API Key 写入浏览器存储。构建产物可部署到 GitHub Pages 等静态托管服务。

## 本地运行

需要 Node.js 22.13 或更高版本：

```powershell
npm install
npm run dev
```

打开终端中显示的本地地址，先选择 OpenAI 或 OpenRouter，再临时填写对应提供商的 API Key 并选择音频文件。切换提供商会立即清空已输入的 Key。

## 构建静态站点

```powershell
npm run build
```

构建结果位于 `dist/`，其中包含可直接静态托管的 `index.html`。资源路径使用相对地址，因此可以部署在个人站点的子目录中。

## GitHub Pages 发布

外层个人主页仓库包含 `.github/workflows/pages.yml`。将改动推送到 `main` 后，工作流会：

1. 构建并测试本工具；
2. 保留个人主页原有静态文件；
3. 把本工具的构建产物发布到 `/record-to-text/`。

首次使用该工作流时，请在 GitHub 仓库的 **Settings → Pages → Build and deployment → Source** 中选择 **GitHub Actions**。之后每次推送到 `main` 都会自动发布。

## 支持的能力

- 拖放或选择 MP3、MP4、MPEG、MPGA、M4A、WAV、WEBM 等常见音频格式。
- 在浏览器内按目标大小压缩为 16 kHz 单声道 MP3；按音频时长计算目标平均码率，并使用 LAME ABR 在帧间动态分配。
- 可设置最低码率（默认 24 kbps），避免为了追求体积把长录音压得不可用。
- 可完整解码为 WAV PCM，修复不规范容器或解码兼容问题；WAV 超过 25 MB 时需要再压缩为 MP3。
- 提供商选择位于 API Key 前：OpenAI 默认使用 GPT Transcribe，也可选择 GPT-4o mini Transcribe、GPT-4o Transcribe 或 Whisper-1。
- OpenRouter 提供 `x-ai/grok-stt-1.0` 与 `openai/whisper-large-v3-turbo`；前者支持可选说话人分离，后者侧重快速的 99+ 语言普通转写。
- 语言下拉包含中文（偏好简体）、英文、日语、法语和意大利语；`gpt-transcribe` 还可用多语言预设提交多个 `languages[]`。
- 按模型配置语言提示、关键词、上下文提示、temperature 和返回格式。
- 可选择自动或手动 Server VAD，并调整阈值、前置保留和静音判停时间。
- 支持流式返回、GPT-4o logprobs，以及 Whisper 词级或段落时间戳。
- 折叠展示实际提交给当前提供商的 JSON 风格参数；API Key 与 Base64 音频内容会隐藏。
- Grok STT 1.0 可提交 `diarize=true`、`format`、`keyterm`、`filler_words` 与 `vad_threshold`。人数无需填写；若 OpenRouter 保留 SpaceXAI 的逐词 `words[].speaker` 扩展字段，网页会自动排版说话人段落，否则安全回退为纯文字。OpenRouter 的标准响应契约只保证 `text` 与 `usage`。
- OpenAI 仍使用官方 multipart 文件上传；OpenRouter 使用官方 JSON `input_audio.data` 原始 Base64 请求。
- OpenRouter 文档标注 60 秒上游处理超时，因此录音超过 10 分钟或 25 MB 时会在浏览器本地转为 16 kHz 单声道 MP3，按 10 分钟物理分段后顺序上传。
- OpenAI 模型超过 30 分钟或 25 MB 时，会在浏览器本地按 30 分钟自动分段、顺序上传。
- 分段转写会把时间戳合并回原录音时间轴；Grok 可能在不同片段重新分配说话人编号，因此结果保留片段边界。
- 页面内编辑、复制、下载 Markdown 转写稿。
- 默认请求显示真实上传进度、百分比和已上传字节；上传完成后切换为模型处理状态。
- 支持对整段音频执行 FFmpeg 严格解码扫描，并生成 SHA-256、文件头尾、时长和解码错误诊断 JSON。
- 记录 OpenAI `x-request-id` 或 OpenRouter `X-Generation-Id`、客户端请求 ID、状态码和响应类型，便于定位或提交支持工单。
- 转写期间取消请求。
- API Key 只保存在 React 内存状态；刷新或关闭页面后消失。

## 文件限制

OpenAI multipart 文件转写接口接受最大 25 MB 的文件。OpenRouter 的 JSON/Base64 路径不受同一 multipart 上限约束，但 Base64 会增加浏览器内存与上传体积；因此网页仍以 25 MB 为本地分段触发线。也可以在上传前手动压缩到默认 22 MB 目标，为容器差异预留空间。

OpenRouter 使用前需要在 [API Keys](https://openrouter.ai/settings/keys) 创建 `sk-or-v1-...` Key，并确保账户有可用额度。调用依据 [OpenRouter Speech-to-Text](https://openrouter.ai/docs/guides/overview/multimodal/stt)；Grok 的提供商参数依据 [SpaceXAI Speech to Text](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text)。

浏览器音频处理由单线程 ffmpeg.wasm 完成。主页面不会包含 31 MB 的转码核心；首次点击“压缩”或“修复”时才会从固定版本 CDN 加载，并在当前页面会话中复用。音频处理全部发生在本机内存中。GitHub Pages 无需后端，也无需设置 `SharedArrayBuffer` 安全响应头。

如浏览器设备性能不足，仍可使用仓库根目录中的 Python 压缩工具：

```powershell
python ..\compress_audio.py .\recording.wav --target-mb 23
```

压缩后的文件仍由网页直接上传，Python 工具不会充当服务器。

## 安全边界

这是个人 BYOK 工具。不要把自己的 API Key 写进代码、提交到 Git、分享给其他人，或把预填 Key 的版本部署为公共网页。浏览器扩展和页面中的第三方脚本理论上能够读取页面内存，因此建议使用权限和额度受限的项目 Key，并在不使用时撤销。

## 验证

```powershell
npm test
```
