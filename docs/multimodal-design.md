# 火山引擎全模态接入设计（方案 B + C，仅设计、不落地）

目标：让 DSH 完全支持火山引擎 doubao-seed-2.0-lite 的"文本+图片+视频+音频输入、文本输出"。

前置结论（见 `multimodal-research.md`）：DSH 现有全链路只认识 `text`/`image` 两种输入模态，
视频/音频在核心词汇、附件存储、pi-ai 适配器、会话准入、ACP/MCP、Web UI 六层全部缺失。
本设计分两条线：**B = 通用全模态改造（核心能力）**，**C = 火山专用适配器（wire 翻译）**。
C 依赖 B 的词汇层；B 缺词汇层时 C 只能降级。

---

## 一、方案 B：通用全模态改造

### B-Phase 0 — 核心词汇层（一切的地基，改动集中、风险可控）

文件：`packages/llm/llm/src/types.ts`、`content.ts`、`message.ts` 及 typert/session-log 序列化。

1. **新增内容块**（`ContentBlockMap` 扩展，与 `image`/`file` 同构）：
   ```ts
   export interface VideoBlock {
     type: 'video'
     attachment: VideoAttachmentRef   // 来自附件服务，见 B-Phase 1
   }
   export interface AudioBlock {
     type: 'audio'
     attachment: AudioAttachmentRef
   }
   ```
   - 持久化（session log JSON）、typert schema、Web 渲染、compaction 都要同步认识这两个块。
   - 块可出现在 user 与 tool-result 内容；assistant 侧暂不支持（与 image 现状一致）。

2. **模态枚举扩展**（`ModelModalityMap`）：
   ```ts
   video: 'video'
   audio: 'audio'
   ```
   `LlmModelInfo.inputModalities` 自动随之扩展，无需改 seam。

3. **递归工具函数**（`llm/src/content.ts`，仿 `contentHasImage`/`contentHasFile`）：
   `contentHasVideo`、`contentHasAudio`，供能力门禁、文本降级、compaction 共享，避免语义分叉。

4. **文本降级**（仿 `projectImagesForTextModel`）：
   `projectMediaForTextModel` —— 文本-only 模型收到 video/audio 块时替换为稳定占位文本
   （`[video omitted because this model accepts text only; attachment sha256:…]`）。

### B-Phase 1 — 附件存储与上传

文件：`packages/attachment/attachment/src/types.ts`、`attachment-local/src/*`、
`packages/api/session-controller/src/commands.ts`、`fileUploads` 服务。

5. **新引用类型与媒体类型**：
   ```ts
   type VideoMediaType = 'video/mp4' | 'video/webm' | …   // 按 Ark 支持面收敛
   type AudioMediaType = 'audio/mpeg' | 'audio/wav' | 'audio/mp4' | …
   interface VideoAttachmentRef { attachmentId; mediaType; bytes; width?; height?; durationMs?; name? }
   interface AudioAttachmentRef { attachmentId; mediaType; bytes; durationMs?; name? }
   ```
   - **存储策略：verbatim（原样字节）**，不做转码/重编码——视频音频体积大且无损重编码不现实，
     与 `FileBlock` 的 verbatim 语义一致（而图片走规范化重编码，不可照搬）。
   - 元数据（时长/分辨率）在 admit 时探测并冻结，供 token 估算与 UI。

6. **PromptContentPart / admit**：
   - `PromptContentPart` 增加 `{ type: 'video'; mediaType; … }`、`{ type: 'audio'; … }`；
   - `attachments.admitPromptContent` 与 `session-controller.prompt` 同步支持；
   - 门禁：附视频/音频时校验 `model.inputModalities` 含对应模态（仿 341 行 image 校验）。

7. **上传管道**：复用现有 `fileUploads`（receipt 机制，天然支持大文件流式上传），
   admit 阶段按媒体类型分类为 video/audio 块；Web UI 的 `<input accept>` 扩展
   `video/*,audio/*` 并增加对应预览与消息渲染。

8. **请求预算/降级**（仿 `offloadRequestImagesWithPolicy`，但语义不同）：
   - 视频/音频**默认不内联 base64**（体积太大），一律走 URL/文件引用（见 B-Phase 2 序列化）；
   - 提供路由级 `maxRequestVideoBytes` / `maxRequestVideoCount` 软预算，超限时把最旧媒体替换为
     "省略说明"占位（`offloadedVideoText`/`offloadedAudioText`），保证长会话可持续请求。

### B-Phase 2 — 适配层（全项目最难的决策点）

pi-ai 0.85.1 内容联合类型只有 `TextContent | ThinkingContent | ImageContent`，模型输入模态硬编码
`("text"|"image")[]`，OpenAI-completions 只序列化 `image_url`+base64。三个走向：

| 走向 | 做法 | 评价 |
|---|---|---|
| B1 等上游 | 推 `@earendil-works/pi-ai` 支持 video/audio，DSH 升级依赖 | 不可控、无时间表，不推荐作为主线 |
| B2 fork pi-ai | 仿 vendor/ 目录先例，fork 后扩展 content 联合 + 序列化 `video_url`/`audio_url` | 可行但要长期维护整个库的快照 |
| **B3 旁路（推荐）** | 新增"原生媒体适配器"（仿 `llm-deepseek` 的手写 adapter），**当 route 声明了 `video`/`audio` 模态时走专用序列化路径**；纯文本/图片 route 仍走 pi-ai | 不动第三方库、风险隔离、与方案 C 天然合并 |

9. **B3 序列化目标格式**（第一目标 Ark OpenAI 兼容，设计成可配置）：
   ```jsonc
   { "type": "text", "text": "…" }
   { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,…" } }
   { "type": "video_url", "video_url": { "url": "https://…/video.mp4" } }   // Ark 格式待实测确认
   { "type": "audio_url", "audio_url": { "url": "https://…/audio.mp3" } }
   ```
   - 本地媒体 → **上传到 Ark Files API** 拿 URL/file id（完整照搬 `llm-deepseek/src/files-api.ts` 的
     过期/配额/清理模式，`MAX_FILE_UPLOAD_BYTES` 等常量按 Ark 文档校准）；
   - 或允许用户直接引用公网 URL（不走本地存储，块里放 URL 引用）；
   - 上传按 request 幂等缓存（同 attachmentId 同 route 不重复上传），并随文件过期做重传。

10. **输出侧**：doubao-seed-2.0-lite 是文本输出，`StreamChunk` 无需新增；仅需在 finish/usage 上
    正确回填 token 计量。

### B-Phase 3 — 循环/计量/压缩

11. **`llm/src/index.ts` adapterStream**：`projectFilesToText` 之后、图片投影旁，
    对不含 video/audio 模态的模型执行 `projectMediaForTextModel`（B-Phase 0.4）。
12. **token-meter**：新增媒体 token 估算（视频按时长/分辨率/帧率档位、音频按时长），
    仿 `LlmImageRequestPricing` 增加 `LlmMediaRequestPricing` 路由级定价接口，供测量与账单展示。
13. **compaction**：历史中的 video/audio 块在压缩时策略（保留引用摘要 vs 省略占位），
    与 image 的现状对齐并明确区分。

### B-Phase 4 — 周边协议与 UI

14. **ACP**（`packages/acp/acp/src/content.ts`）：`audio`/`video` prompt 内容从"直接抛错"改为
    走附件 admit（ACP 协议原生有 audio 类型；video 可用 resource 承载）。
15. **MCP 工具结果**（`packages/mcp/mcp-client/src/tools.ts`）：video/audio 块从"替换占位文本"改为
    保留为媒体块（模型工具产出的音视频可直接回传）。
16. **Web UI**：上传 accept、媒体预览、消息渲染、附件状态。

---

## 二、方案 C：专用火山适配器（叠加在 B 之上）

结构完全仿 `packages/llm/llm-deepseek/`：

```
packages/llm/llm-volcengine/
  src/
    index.ts        # 插件入口：settings 段 llm-volcengine、provider 注册、configurable-provider 目录
    adapter.ts      # LlmAdapter 实现：listModels/resolveModel/prepareCall/stream（SSE）
    serialize.ts    # DSH 消息 → Ark content parts（text/image_url/video_url/audio_url/file_url）
    sse.ts          # Ark /chat/completions SSE 解析（照搬 llm-deepseek/src/sse.ts 模式）
    files-api.ts    # Ark Files API 上传/过期/配额/清理（照搬 llm-deepseek/src/files-api.ts）
    media-tokens.ts # 图片/视频/音频 token 估算（仿 image-tokens.ts）
    request-pricing.ts
    types.ts
```

- **认证**：Ark API Key（`Authorization: Bearer`）走现有 `credentials` seam（`apiKeyEnv`）；
  AK/SK 签名作为可选项（Ark 同时支持）。
- **model 字段**：支持 endpoint id 与模型名两种写法（Ark 控制台获取）。
- **settings**：`llm-volcengine:` 段（或复用 `llm-pi-ai.providers.ark` 声明 `api: openai-completions` +
  模态 `input: [text, image, video, audio]`，由 B3 的媒体适配器接管）。
- **baseURL**：`https://ark.cn-beijing.volces.com/api/v3`。
- **能力声明**：`inputModalities: ['text', 'image', 'video', 'audio']`，从而会话准入（B-Phase 1.6）
  与请求组装（B-Phase 3.11）自动放行媒体块。

**C 单独落地（B 未完成）时的降级现实**：FileBlock 在 `adapterStream` 中**无条件投影成文本**
（"no provider receives file blocks natively"），所以 C 拿不到视频/音频字节；单独做 C 只能得到
"用户贴本地路径 + 模型用工具读文件"的弱方案。**真正全模态必须以 B-Phase 0 的词汇层为前置。**

---

## 三、落地顺序（建议）

1. **B-Phase 0**（词汇 + 模态 + 工具函数 + 序列化 + UI 渲染认识新块）：改动集中，是后续一切基石
2. **B-Phase 1**（附件存储 + admit + 上传 + Web UI）
3. **C / B-Phase 2（B3 合并）**：serialize + files-api + SSE，Ark 实测 content part 格式
4. **B-Phase 3**（门禁、计量、compaction）
5. **B-Phase 4**（ACP/MCP）

每一步都可独立合入、可回退；1–3 完成后即可跑通 doubao-seed-2.0-lite 全模态对话。

## 四、风险与待实测项

- **Ark 精确 wire 格式**：`video_url`/`audio_url` 的字段名、URL 长度上限、base64 上限、
  时长/分辨率限制、是否支持 file_url —— 需对照 Ark 文档或实测（本会话无网搜凭据，未核验）。
- **文件有效期与回放**：Ark 上传文件/URL 过期策略未知；历史消息 replay 时引用可能失效，
  需"重传或持久 URL"机制（DeepSeek 先例：1h~30d 过期）。
- **视频 token 计价**：doubao 按帧/时长/分辨率如何计价，决定 token-meter 的档位设计。
- **pi-ai 升级**：B3 旁路后 pi-ai 仍是文本/图片默认路径，升级互不阻塞。
- **体积与配额**：视频常达数百 MB，上传带宽、存储配额、请求预算需要显式默认值
  （如默认 `maxRequestVideoBytes`、单文件上限）。
