# IndexTTS 语音朗读插件 —— Agent 开发与维护手册

> 面向后续接手开发/维护的 agent 与人类开发者的交接文档。先读本文件，再动代码。
> 配套文档：`README.md`（用户视角功能说明）、`CODE_REVIEW.md`（四轮 code review + 全部修复记录）。

---

## 1. 项目一句话

DeepSeek Harness Web GUI 上的**动态 Cordis 插件**：在每条 agent 回复末尾加喇叭按钮，把该条回复的**正文**（text 块，不含思考/工具）用优云智算 **IndexTTS-2** API 合成语音并朗读；含文本过滤、渐增分段、并发流水线、段间预载、浏览器音频缓存、音色源文件存档与过期自动续期。

- 官方 API 文档：https://www.compshare.cn/docs/modelverse/models/audio_api/ttts
- API 根：`https://api.modelverse.cn/v1`，模型 `IndexTeam/IndexTTS-2`
- 参考实现（技能版 CLI，Python）：`../skills/index-tts-compshare/`

---

## 2. 架构总览（先建立心智模型）

```
┌─ 浏览器（code.client，全部逻辑在此）──────────────────────────────┐
│ 设置页 settings.section「语音朗读」       播放按钮 assistant-actions │
│   │                                       │ useChat(messageId)     │
│   │ 配置读写 host.call                      │ 取 text 块 → 过滤 → 分段 │
│   ▼                                       ▼                        │
│  XMLHttpRequest 直连 api.modelverse.cn/v1                        │
│    POST /audio/speech  · GET/POST voice/list·upload·delete        │
│  音频缓存 Map(内存,60MB上限) · 音色存档 IndexedDB(持久,自动续期)     │
└───────────────────────────────────────────────────────────────────┘
        ▲ host.call('get-config' | 'set-config')
┌─ Host（code.host，仅配置存储）────────────────────────────────────┐
│ 内存 state：apiKey / voiceId / voiceName / speed / sampleRate / gain │
│ harness.handle → get-config / set-config（含范围校验）              │
└───────────────────────────────────────────────────────────────────┘
```

**关键决策（不要轻易推翻）**：
- 所有网络走**浏览器 XHR**（CORS 已实测开放；`fetch` 在动态沙箱被禁用）。
- Host 只存内存配置（动态插件不引入持久化；音色源文件持久化在**浏览器 IndexedDB**）。
- 播放 =「按段并发合成（每会话 2 并发）→ 保序消费 → main/aux 双 `<audio>` 交替预载」流水线。
- 缓存 key = 请求参数全文（含 apiKey 指纹），防止跨账号/哈希碰撞。

---

## 3. 运行环境硬约束（写代码前必读）

动态插件两端都是**纯 JS 函数体**（async 函数体，`return { apply(ctx) {...} }`），无构建：

| 约束 | 说明 |
|---|---|
| ❌ 无 JSX / TypeScript / import / require | 客户端 React 一律 `React.createElement(...)`；宿主无模块导入 |
| ❌ `fetch` 被禁用（两端） | 一律用浏览器 `XMLHttpRequest` |
| ❌ `setTimeout/setInterval` 被禁用 | 用 `inject: ['timer']` + `ctx.timeout/ctx.interval`（两端都有 timer 服务） |
| ⚠️ 可用环境全局（未遮蔽） | 浏览器端：`XMLHttpRequest/Blob/File/URL/indexedDB/navigator/Audio/TextDecoder` 等均可用；宿主端只有 `ctx/harness/console/btoa/atob/TextEncoder/TextDecoder` |
| ⚠️ Host `atob` 是 UTF-8 解码（非二进制） | 不要用它传二进制；二进制走客户端 Blob/ArrayBuffer |
| ✅ 插件 `apply` 不能返回普通对象 | 返回 `undefined` / disposer / promise / 可迭代；返回 `{}` 会抛 `Invalid effect` |
| ✅ `harness.handle` 清理 | runner 会把 disposer 记入 `run.handlerDisposers`，stop/update/失败统一回收，**插件无需手动挂 effect** |
| ✅ 动态插件进程级 | **DSH 进程重启会丢失插件与宿主内存配置**（工作区文件不丢），需用 `cordis_define` 重新加载 |

---

## 4. 目录与文件

| 文件 | 作用 | 与运行版本的一致性 |
|---|---|---|
| `host.js` | code.host 源码（配置存储） | 与运行版本一致 |
| `client.js` | code.client 源码（全部功能） | 与运行版本一致（改完必须同步） |
| `README.md` | 用户功能说明 | 改功能后同步 |
| `CODE_REVIEW.md` | 四轮 review + 每轮修复记录表 | 修完追加记录 |
| `agents.md` | 本文档 | — |

> ⚠️ 教训（第三轮 review 抓到的 bug）：**只改 define 代码、不同步磁盘源文件**会导致「运行版本与磁盘不一致」。任何改动两者都要同步。

---

## 5. 核心模块详解（client.js 自上而下）

### 5.1 文本过滤 `filterText(text)`
- `stripKaomoji`：JS 移植技能版 `text.py` 的颜文字清洗（括号组判定 + 尾部装饰符剔除），保留 `(开心)` 等正常括号、保留 `～~` 语气。
- `EMOJI_RE`：整段剔除 emoji 及其 ZWJ 序列（含 `❤️‍🔥` 这种 VS16 在 ZWJ 前的形态）、变体选择符/键帽（`1️⃣`）、旗帜（`\p{Regional_Indicator}{2}`）、肤色；**独立 ZWJ 保留**（不破坏阿拉伯/印度语合字）。
- `stripMarkdown`：剥离代码块/行内代码/链接/图片/粗斜体/删除线/标题/列表/引用/表格竖线等。
- 输出：保留段落结构（不清换行），供分段用。

### 5.2 分段 `splitForTts(text, max)` —— 渐增块大小
- `SEGMENT_SIZES = [100, 200, 400]`，之后固定 `max(600)`；`budget()` 按已 flush 的块数取当前块上限。
- 段落（`\n+`）→ 超长段落按句子（`。！？!?；;`）切开 → 贪心打包到当前预算；单句仍超预算则**按当前预算硬切**（每次 flush 后重新取 `budget()`，见 review #9）。
- 设计目的：首段小=快速开播；前几段播放时间为后续大段合成留足提前量（实测 100 字段播完时 600 字段还没好 → 渐增解决）。

### 5.3 请求层
- `xhrRaw(method, path, apiKey, body, responseType, timeoutMs)`：单次请求。`settled` 守卫防重复 settle；429/5xx/网络/超时标记 `retryable`；`status===0` 的 loadend 直接返回（交给 onerror/ontimeout）。
- `xhrJson(...)`：通用重试（列表/删除等），重试最多 3 次（共 4 次尝试），2s→4s→8s。
- `xhrJsonSynth(payload, apiKey, session)`：**合成专用**，带优先级：
  - `high`（`!session || session.isCurrent`，即用户当前要播的）：重试 3 次 1s→2s→4s；
  - `low`（后台/残留会话的缓存填充）：重试 2 次 4s→8s，并在 429 触发的 8s 冷却期内让路；
  - `session.stopped` 后不再发起新重试（review #1/#10）；**例外（第八轮复审 A）**：原会话已停止但该在途请求正被新 `currentSession` 复用（`getAudioCached` 在途去重）时，重试决策改以新会话为准（`effectiveSession()`，high/low 与停止检查均重新判定）；无新会话接管则照常停止重试。
- `synth(text, cfg, session)`：拼 payload（model/input/voice/speed/sample_rate/gain），`responseType='arraybuffer'` 拿 WAV。
- `listVoices/uploadVoice/deleteVoice`：音色管理（multipart 上传、JSON 删除）。

### 5.4 音频缓存 `audioCache`（内存，字节预算）
- key = `requestKey(text, cfg)` = 参数字符串全文（含 `ak` 指纹）。
- 值 = `{ url: blobURL, bytes: byteLength }`；`cacheBytes` 记账。
- 上限：段数 `CACHE_MAX=60` + **总字节 `CACHE_BYTES_MAX=60MB`**（WAV 大：600 字段@44100Hz≈10MB）。
- LRU：命中 `delete+set` 刷新；淘汰最旧时**跳过 `inUseUrls` 中正在播放/预载的 URL**（挪到最新再试，attempts 上限防死循环）。
- 仅内存，刷新页面清空；设置页显示「N 段 / X MB」，每次合成 console 输出。

### 5.5 播放流水线 `playSegments(segments, cfg, session)`
- `pump`：**有界并发 2**（每会话），按段序启动 `getAudioCached`，结果写入保序数组 `results[i]`；对每个 task 预挂 `then/catch` 防 unhandledrejection（review #5）；会话停止后不再启动新段，在途段完成仍写缓存。
- `playOne(url, target)`：`main`/`aux` 双 `<audio>` **按段交替**（review R2-1 修正）：正常播完 `playedEl===curEl` 交换，自动播放策略回退 main 则停留 main；`session.playingEl` 记录实际播放元素。
- **预载**：第 i 段开始播放时就 `results[i+1].then(预载到 otherEl)`，写入前检查 `session.playingEl !== preTarget`（回退场景不打断播放），预载 URL 计入 `session.urls` 防 LRU 提前 revoke。
- **停止**：`session.stopSignal`（Promise），`wait(p) = Promise.race([p, stopSignal])`；`stopSession` 置 `stopped`、清 `urls`、pause+清两个 audio 的 src。
- 全局同一时间只播一条：`currentSession` + `requestStopAll`。
- `startPlay` 内 `runPlay` 封装**音色过期自动续期**：仅当合成报错为明确 HTTP 400/404 **且** 文案命中 `invalid_voice_id` / voice id 无效·不存在·未找到 / 音色不存在·无效·失效（第八轮复审：已不再用宽泛 `/voice|invalid|not.?found|音色/i`，5xx/网络/限流/其它 4xx 不触发）且未重试过 → `reuploadFromArchive` → 更新 host 配置 → `generation+1` 作废旧流水线（旧 pump 停止调度、旧 voiceId 不再消耗额度）→ 重试前先 `pause()` 两个 audio 元素（防御）→ 用新 voiceId 重试整段；续期期间用户已停止则不再重试，外层 catch 只显示「已停止」不闪现错误文案。

### 5.6 音色存档（IndexedDB，持久）与自动续期
- DB `itts-voice-archive` / store `voices`，keyPath `voiceId`；记录 `{voiceId, name, fileName, blob, uploadedAt}`。
- 上传成功即 `archivePut`（源文件 File 直接存）；删除平台音色时 `archiveDelete` 同步清理。
- `reuploadFromArchive(oldVoiceId, apiKey)`：读存档 → 重新 `uploadVoice` → 新 id 入档、旧 id 删除 → 返回 `{ok, id, name}`。
- 触发点：
  1. 设置页 `refreshVoices` 后发现当前选中 voiceId 不在平台列表 → 自动续期并更新 host 配置（无存档则提示手动上传）；
  2. 播放合成报 voice 相关错误 → `runPlay` 兜底续期一次。
- `archiveListKeys()` 返回已存档 id 集合 → 设置页下拉框对命中项标「· 可续期」。
- 启动时 `navigator.storage.persist()` 请求持久配额（尽力而为）。

### 5.7 设置页 `SettingsView` 与播放按钮 `PlayButton`
- 设置页：API Key / 上传音色（含存档）/ 音色下拉（带可续期标记、选择即 commit）/ 刷新 / 删除 / 语速 / 采样率 / 增益（保存前本地校验）/ 试听（**不走缓存**，每次真实调 API）/ 缓存占用显示。
- 播放按钮：`useChat` 取 `messageId` 对应 assistant 节点的 text 块拼接 → 空文本不渲染按钮 → 点击播放/再点停止；按钮旁小字显示 合成/播放 n/N 或错误。

---

## 6. 加载 / 运行 / 调试

### 6.1 重新加载插件（进程重启后必做）
动态插件进程级，重启即丢。重新加载：
1. `cordis_define`：`kind: 'new'`（或已有则 `{kind:'existing', pluginId}`），`code.host` = `host.js` 从 `return {` 起的内容，`code.client` = `client.js` 从 `return {` 起的内容（**不含文件头注释**）。
2. `cordis_run`：首次 `mode:'run'`，更新 `mode:'update'`；客户端半部需用户在 GUI 批准。
3. 重填 API Key / 重选音色（宿主内存配置不持久；IndexedDB 音色存档仍在，选回带「可续期」的音色即可自动续期）。

### 6.2 排查运行状态
- `cordis_inspect_self`（无参=插件列表；`pluginId`=版本指针；`pluginId+packageId`=源码与诊断）。
- 客户端渲染崩溃会以「Client UI ... failed while rendering Slot ...」消息推送，读 message 定位。
- 常见宿主失败：`Invalid effect` = apply 返回了普通对象（见 §3）。
- 浏览器端调试：DevTools Console 看 `[itts]` 日志；Application → IndexedDB 看存档；设置页看缓存 MB。

### 6.3 语法自检（改完 client.js 后）
```powershell
$body = Get-Content client.js -Raw
Set-Content "$env:TEMP\c.js" -Value "(`n$body`n)" -Encoding UTF8
node --check "$env:TEMP\c.js"
```

---

## 7. 测试清单（改任何模块后回归）

- [ ] 上传音色 → 下拉出现「· 可续期」；IndexedDB 出现 `itts-voice-archive`
- [ ] 点喇叭 → 首段很快出声；多段（>600 字）无段间明显停顿
- [ ] 重复播同一条 → 第二次无「合成中」等待（缓存命中），设置页 MB 不增长
- [ ] 播放中点停止 → 立即停、无报错
- [ ] 平台删除当前音色 → 回设置页刷新 → 自动续期提示 + 新 id 标可续期
- [ ] 试听每次真实合成（换 Key/音色后能立刻验证）
- [ ] 颜文字/emoji/markdown 不被朗读；思考过程（reasoning 块）不朗读
- [ ] 缓存超 60MB 或 60 段时正常淘汰、播放中不中断
- [ ] 断网/错 Key：按钮旁显示明确错误，不崩溃

---

## 8. 已知限制与可扩展方向

**已知限制**：
- 宿主配置（API Key/音色/语速等）只存内存，插件重载/进程重启后需重填。
- 动态插件随 DSH 进程消失（需重新 define）。
- 播放音频缓存仅内存（刷新清空）；合成音频未持久化。
- 平台音色 7 天有效；自动续期依赖浏览器 IndexedDB 源文件存在。
- 语速/情感等 API 能力未全量暴露（见下）。

**可扩展方向**（按需实现）：
1. **情感控制**：`synth` 目前不传 `emo_*`（method 0，音色自带情绪，用户确认现阶段正确）。将来可加设置项：`emo_control_method:3` + `emo_text` + `emo_weight`（建议 0.3）。
2. **配置持久化**：把 host 配置落到本地存储（或改静态插件随部署加载），避免重启重填。
3. **固化为静态插件**：动态插件重启丢失 → 可写进宿主组合配置（cordis.yml / agent preset）成为常驻插件。
4. **合成音频持久化**：把播放过的音频也存 IndexedDB（需控制配额，如只存较新 N 条），跨刷新秒播。
5. **音色本地重命名/管理**：平台无重命名接口，可加「删旧传新」辅助。
6. **API 能力扩展**：`interval_silence`（分块间隔静音）、`emo_random`、`gain` 语义细化等。

---

## 9. 变更流程（保持一致性）

1. 改 `client.js` / `host.js`（磁盘）→ `node --check` 语法自检。
2. `cordis_define`（`kind:'existing'`，同 `pluginId`）提交新 Package（不可变，勿覆盖旧版本）→ `cordis_run mode:'update'`。
3. 同步 `README.md`（用户可见行为）与 `CODE_REVIEW.md`（在末尾追加修复记录表，标注行号/原因/处置）。
4. 回归 §7 测试清单。
5. 若改动了本文档描述的行为，同步更新本文件。

---

## 10. 快速索引

| 想找 | 位置 |
|---|---|
| API 端点与 payload | `client.js` §5.3；技能版 `skills/index-tts-compshare/scripts/ttslib/api.py` |
| 文本过滤规则 | `client.js` `filterText` / `stripKaomoji` / `EMOJI_RE` / `stripMarkdown` |
| 分段策略 | `splitForTts` + `SEGMENT_SIZES` |
| 播放流水线/预载/停止 | `playSegments` / `playOne` / `stopSession` / `startPlay.runPlay` |
| 缓存与内存控制 | `audioCache` / `cacheBytes` / `CACHE_BYTES_MAX` / `inUseUrls` |
| 音色存档与续期 | `ARCHIVE_DB` / `archive*` / `reuploadFromArchive` / `refreshVoices` 续期分支 |
| 设置页/播放按钮 UI | `SettingsView` / `PlayButton` |
| 四轮 review 全部问题与修复 | `CODE_REVIEW.md`（含 R2-1 交替写反、磁盘不同步等教训） |
