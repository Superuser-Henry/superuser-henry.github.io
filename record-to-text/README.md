# Whisper Desk Web

纯静态的个人音频转写工作台。网页读取本地音频，并从浏览器直接调用 OpenAI Audio Transcriptions API；项目不包含业务后端，也不会把 API Key 写入浏览器存储。构建产物可部署到 GitHub Pages 等静态托管服务。

## 本地运行

需要 Node.js 22.13 或更高版本：

```powershell
npm install
npm run dev
```

打开终端中显示的本地地址，在页面里临时填写自己的 OpenAI API Key，然后选择音频文件。

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

- 拖放或选择 MP3、MP4、MPEG、MPGA、M4A、WAV、WEBM。
- 默认使用 OpenAI GPT Transcribe，也可选择 GPT-4o mini Transcribe、GPT-4o Transcribe 或 Whisper-1。
- 配置语言、提示词和 temperature。
- 使用 GPT-4o Transcribe Diarize 自动区分说话人，并可显示分段时间。
- 选择自动语音分段或整段处理；多人模式会自动启用分段。
- 页面内编辑、复制、下载 Markdown 转写稿。
- 转写期间取消请求。
- API Key 只保存在 React 内存状态；刷新或关闭页面后消失。

## 文件限制

OpenAI 文件转写接口接受最大 25 MB 的文件。网页会在选择阶段拦截超限文件。超限录音可以继续使用仓库根目录中的 Python 压缩工具：

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
