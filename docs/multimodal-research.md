# DSH 全模态支持调研：为火山引擎 doubao-seed-2.0-lite 插件做准备

日期：2026-02 ｜ 依据：deepseek-harness checkout（/Users/xiaoka/project/deepseek-harness）源码 + pi-ai 0.85.1 包内实现

## 结论（TL;DR）

**DSH 自带的模型接口和供应商适配器不支持"全模态"（文本+图片+视频+音频输入、文本输出）。**
当前整个链路只认识两种输入模态：`text` 和 `image`（且 image 仅限 png/jpeg/webp/gif 光栅图）。
视频、音频在任何一层都没有内容块类型、没有附件存储、没有适配器翻译、没有 UI 入口。

**今天就能做到的**：火山方舟（Ark）是 OpenAI 兼容协议，可借运行中已挂载的通用适配器 `llm-pi-ai`
以"手工声明路由"的方式接入 doubao-seed-2.0-lite —— 但只能走 `text`，或声明 `input: [text, image]`
后走文本+图片；**视频/音频输入无法通过任何配置实现**。

## 证据：各层的模态能力

### 1. 核心模型消息词汇（`packages/llm/llm/src/types.ts`）
- `ContentBlockMap`：`text | reasoning | image | file | tool-call | tool-result` —— 无 video/audio 块。
  注释明确"新核心块必须连同 adapter、UI、compaction 支持一起落地"。
- `ModelModalityMap`：`{ text: 'text', image: 'image' }` —— 全系统唯一的模态枚举。
- 输出侧 `StreamChunk`：只有 `text-delta / reasoning-delta / tool-call-delta`（文本输出）。

### 2. 附件/上传（`packages/attachment/attachment/src/types.ts`）
- `ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'`。
- `PromptContentPart` 只允许 `text | image | file`；文件块（FileBlock）从不直发供应商，
  请求组装时一律投影成"文件句柄文本"（`projectFilesToText`，见 `llm/src/content.ts`）。

### 3. 通用供应商适配器 `llm-pi-ai`（基于第三方库 `@earendil-works/pi-ai@0.85.1`）
- pi-ai 自带协议表：`openai-completions / openai-responses / anthropic-messages`（`provider.ts`）。
- pi-ai 的内容联合类型只有 `TextContent | ThinkingContent | ImageContent`；用户消息
  `content: string | (TextContent | ImageContent)[]`（`pi-ai/dist/types.d.ts`）。**无 video/audio。**
- pi-ai 的模型输入模态硬编码为 `input: ("text" | "image")[]`（同文件 728 行）。
- OpenAI-completions 实现里图片只序列化为 `image_url` + `data:base64`（`pi-ai/dist/api/openai-completions.js`），
  无 `video_url / audio_url` 分支。
- DSH 侧模态门禁（`llm-pi-ai/src/catalog.ts`）`MODALITY_GATE = { text, image }`，配置 schema 也只收这两种。
- 转换层（`llm-pi-ai/src/context.ts`）：只处理 text/image/tool-result；图片仅允许出现在 user 角色，
  其他角色直接抛 `UNSUPPORTED_CONTENT`。
- 适配器（`llm-pi-ai/src/adapter.ts`）：`containsImage && !model.input.includes('image')` → 抛错；
  图片经附件服务 `readImageRequest` 缩放/重编码为请求版本后内联 base64。
- pi-ai 内置供应商目录（`dist/providers/`）：openai/anthropic/deepseek/google/groq/mistral/xai/zai/
  kimi/minimax/moonshot/qwen/xiaomi/openrouter/together/… —— **没有 ark/volcengine/doubao**。

### 4. 一供适配器 `llm-deepseek`（DeepSeek 官方适配器，作为"原生适配器"样板）
- 模态校验同样只认 `"text"` 与 `"image"`（`llm-deepseek/src/index.ts` 241 行起：必须只含 text/image）。
- 当前运行实例（`~/.dsh/settings.yaml`）的 deepseek-v4-flash / deepseek-v4-pro 均为 `text`。

### 5. 会话/循环层的模态门禁
- 附件准入（`packages/api/session-controller/src/commands.ts` 341 行）：模型不支持 image 时拒绝带图消息。
- 请求组装（`packages/llm/llm/src/index.ts` 1048 行）：模型不支持 image 时把图片投影成占位文本降级。
- ACP（Agent Client Protocol，`packages/acp/acp/src/content.ts`）：`audio` prompt 内容直接抛
  `"audio prompt content is not supported"`；MCP 工具结果里的 audio 也被替换为占位文本。

### 6. 运行实例
- 当前 Web GUI 组合（`~/.dsh/profiles/web`，bundles: dsh-base + dsh-web-app）同时挂载
  `llm-deepseek`（provider `deepseek-official`）与 `llm-pi-ai`（通用多供应商），由
  `apps/web/tests/shipped-composition.e2e.ts` 佐证。

## 结论映射到火山引擎

- Ark API 为 OpenAI 兼容协议，base URL `https://ark.cn-beijing.volces.com/api/v3`，
  文本+图片可用现有 `openai-completions` 协议直连（需在 Ark 控制台开通模型并取得 API Key，
  用 endpoint id 或 model name 作为 `model`）。【外部事实，本会话无法联网核验，落地前请对照 Ark 文档确认
  doubao-seed-2.0-lite 的视频/音频 content part 的精确 wire 格式，如 `video_url` / `audio_url`。】
- 但 doubao-seed-2.0-lite 的"视频输入、音频输入"无法经 DSH 现有任何层表达：
  核心词汇、附件存储、pi-ai 适配器、会话准入、ACP/MCP、Web UI 全部缺 video/audio。

## 实现选项（供下一步决策）

| 选项 | 范围 | 能拿到什么 | 代价 |
|---|---|---|---|
| A. 配置接入（最快） | 仅改 `~/.dsh/settings.yaml` 的 `llm-pi-ai.providers` | Ark 文本 / 文本+图片对话（视频音频不可用） | 极小，无代码 |
| B. 通用全模态改造 | 改 DSH 核心：ContentBlockMap + ModelModalityMap 增 `video/audio` 块；附件服务增视频/音频存储；pi-ai 适配器（或旁路）+ context 转换增 video/audio content；会话准入、token 计量、compaction、ACP/MCP、Web UI 上传同步支持 | DSH 整体具备全模态能力，任何支持多模态的供应商受益 | 大：跨 6+ 包，需要 pi-ai 上游支持或 fork/旁路 |
| C. 专用火山适配器插件 | 仿 `llm-deepseek` 写独立 adapter（SSE/直连 Ark），在其内部做 doubao 的 content part 序列化 | 火山全模态对话，不动 pi-ai | 中：但消息要进入 agent loop 仍需核心块词汇支持 video/audio，否则只能做"文本描述+文件路径"的降级方案 |

推荐路径：先做 A 验证连通性；若目标是"完全支持全模态"，以 B 为主线（核心词汇先行），
C 作为火山专属的 wire 翻译层叠加在 B 之上。
