# 火山引擎（豆包）搜索插件 —— Agent 开发与维护手册

> 面向后续接手开发/维护的 agent 与人类开发者的交接文档。先读本文件，再动代码。
> 配套文档：`README.md`（用户视角功能说明）；运行时环境底图见仓库 `docs/dynamic-plugin-host-sandbox.md`。

---

## 1. 项目一句话

DeepSeek Harness Web GUI 上的**动态 Cordis 插件**：通过宿主 `ctx.subprocess` 拉起 **DSH 自身所在的 Node 运行时**（`resolveExecutable('node')` + 内联 `-e` 脚本，用 Node 内置 `https` 模块）直连**火山引擎联网搜索** API（0 外部依赖，不需要 curl / Python），注册模型工具 `byted_web_search` 与 `ctx.web` 搜索 Provider（id=`volcengine`），并提供设置页配置 API Key 与默认参数。

---

## 2. 架构总览（先建立心智模型）

```
┌─ 浏览器（code.client，仅设置 UI）────────────────────────────┐
│ 设置页 settings.section「火山引擎搜索」                         │
│   API Key / 默认参数 / 测试搜索                                │
│   └ host.call('get-config'|'set-config'|'test-search')        │
└───────────────────────────────────────────────────────────────┘
        ▲ host.call
┌─ Host（code.host，核心逻辑在此）───────────────────────────────┐
│ 内存 state：apiKey / 默认参数                                  │
│ harness.handle → get-config / set-config / test-search         │
│ harness.defineTool → byted_web_search（模型工具）              │
│ ctx.web.registerSearchProvider({ id:'volcengine', ... })       │
│ ctx.subprocess.spawn(node -e <内联脚本> POST open.feedcoopapi.com/...) │
└───────────────────────────────────────────────────────────────┘
```

**关键决策（不要轻易推翻）**：
- 动态 Host 沙箱**无 `fetch`**（`ctx.web.fetch` 只支持 `{url}`），网络访问的唯一途径是 `ctx.subprocess` 拉起外部进程。
- **0 外部依赖**：外部进程用 **DSH 自身所在的 Node 运行时**（`resolveExecutable('node')` + `node -e` 内联脚本 + Node 内置 `https` 模块），不依赖系统 curl / Python / requests；Node 是 DSH 的运行基础必然存在，且自带 OpenSSL（不受本机 curl 的 TLS/schannel 问题影响）。
- **只用 API Key（Bearer）模式**：AK/SK 签名需要 HMAC-SHA256，动态沙箱无 crypto 模块，无法实现。API Key 是火山引擎联网搜索的推荐鉴权方式。
- 请求 JSON body 经 `stdin: { data: bodyText }` 传入（对应内联脚本读 stdin），避免命令行转义；API Key 经 `spawn.env` 显式条目（`VOLC_API_KEY`）传给子进程，能存活过 subprocess 的敏感变量 scrub。
- 行为与 curl 对齐：任何 HTTP 响应（含 4xx/5xx）都写 body 到 stdout 并以 0 退出，由插件解析 JSON 判断业务错误；只有传输层错误才非 0 退出。
- 响应是结构化 JSON（`ResponseMetadata` + `Result`），直接解析，不做文本再解析。
- `subprocess` 是**硬依赖**（`inject: ['subprocess']`）；`ctx.web` 是**可选依赖**（`ctx.get('web')`），provider 注册失败不影响工具。

---

## 3. 运行环境硬约束（写代码前必读）

动态插件两端都是**纯 JS 函数体**（async 函数体，`return { apply(ctx) {...} }`），无构建：

| 约束 | 说明 |
|---|---|
| ❌ 无 JSX / TypeScript / import / require | 客户端 React 一律 `React.createElement(...)`；宿主无模块导入 |
| ❌ `fetch` 被禁用（两端） | 本插件网络一律走 Host `ctx.subprocess` 拉起 DSH 自身 Node 运行时（内联 `-e` 脚本 + 内置 `https`） |
| ❌ `setTimeout/setInterval` 被禁用 | 若需定时器用 `inject: ['timer']`（本插件暂未用到） |
| ⚠️ 宿主可用全局 | `ctx / harness / console / btoa / atob / TextEncoder / TextDecoder`；无 `process`/`fetch`/`crypto` |
| ⚠️ 客户端可用全局 | `styles / React / host / ctx.get('slots') / XMLHttpRequest` 等 |
| ✅ 插件 `apply` 不能返回普通对象 | 返回 `undefined` / disposer / promise / 可迭代；返回 `{}` 会抛 `Invalid effect` |
| ✅ `harness.handle` / `registerTool` 清理 | runner 统一回收，插件无需手动挂 effect |
| ⚠️ 动态插件进程级 | DSH 进程重启会丢失插件与宿主内存配置，需重新 `cordis_define` + 重填 Key |

---

## 4. 目录与文件

| 文件 | 作用 | 与运行版本的一致性 |
|---|---|---|
| `host.js` | code.host 源码（核心逻辑） | 与运行版本一致 |
| `client.js` | code.client 源码（设置页） | 与运行版本一致（改完必须同步） |
| `README.md` | 用户功能说明 | 改功能后同步 |
| `CODE_REVIEW.md` | code review 记录（本地，不入库） | 修完追加记录 |
| `agents.md` | 本文档 | — |

> ⚠️ 教训（index-tts 第三轮 review 抓到的 bug）：**只改 define 代码、不同步磁盘源文件**会导致「运行版本与磁盘不一致」。任何改动两者都要同步。

---

## 5. 核心模块详解

### 5.1 配置存储（host.js）
- 内存 `state`：`apiKey / defaultCount / defaultTimeRange / defaultAuthLevel / defaultQueryRewrite`。
- `harness.handle('get-config')`：返回 clone。
- `harness.handle('set-config')`：范围校验后合并（apiKey trim、count 1~50、authLevel 0/1、boolean 校验），返回 clone。
- `harness.handle('test-search')`：用当前配置跑一次搜索，返回 `{ok, text}` 或 `{ok:false, error}`。

### 5.2 核心执行 `search(query, opts)`（host.js）
- 常量：`API_URL = 'https://open.feedcoopapi.com/search_api/web_search'`、`TRAFFIC_TAG = 'skill_web_search_common'`（与 byted-web-search 技能 CLI 的 API Key 路径一致）。
- `buildBody`：`{Query, SearchType, Count}`；web 类型加 `NeedSummary:true`、`Filter.AuthInfoLevel`（authLevel>0）、`TimeRange`（有值才加）；`queryRewrite` 加 `QueryControl.QueryRewrite`。
- Node 内联脚本 `NODE_SCRIPT`（`https` 模块）：
  ```
  node -e <NODE_SCRIPT>          # argv: [nodeExe, '-e', NODE_SCRIPT]
    env: { VOLC_API_KEY: <apiKey> }   # 仅配置了 key 时脚本加 Authorization: Bearer <key>
    stdin: <bodyText>                 # 脚本读完整 stdin 作为请求 body
    https.request(POST open.feedcoopapi.com/search_api/web_search, {timeout:25000})
    任何 HTTP 响应 → 写 body 到 stdout 并 exit 0；传输层错误 → stderr + exit 1
  ```
  body 经 `stdio.stdin: { data: bodyText }` 传入。
- `resolveNode()`：`ctx.subprocess.resolveExecutable('node')`（PATH 解析，结果缓存）；解析失败抛「找不到 Node 运行时」。
- `ctx.subprocess.spawn({ argv, cwd: '.', env: {VOLC_API_KEY}, stdio: {stdin:{data}, stdout:{maxBytes:500000}, stderr:{maxBytes:50000}}, graceMs:30000 })`。
- `await handle.done` 拿 `{exitCode}`；`handle.collected.stdout.readFrom(0).text` 读输出。
- 非零退出 → 抛错（优先 stderr）。
- 解析 JSON：`ResponseMetadata.Error` → 抛错（invalid_api_key/10403 给引导文案）；`Result` 为空 → 抛「搜索无返回结果」。

### 5.3 模型工具 `byted_web_search`
- `harness.defineTool` + `harness.registerTool`：
  - 参数：`query`(必填 string)、`count`(integer)、`type`(enum web/image)、`time_range`(string)、`auth_level`(enum 0/1)、`query_rewrite`(boolean)。
  - `output.schema: {type:'string'}`，`render` 返回 text 块。
  - `execute`：`search(args.query, {...})` → `formatResult(data)` 文本。
- 注意参数 DSL 约束：properties 允许 `type/enum/const/required/description/title/default/examples`；`required` 在属性上必须是 `true`。

### 5.4 WebSearchProvider `volcengine`
- `ctx.get('web')` 存在时注册 `{ id:'volcengine', available(){return true}, async search(request, signal){...} }`。
- `search` 返回 `{ content: formatResult(data), sources: toSources(data), truncated:false }`。
- `toSources`：`Result.WebResults`（或 `ImageResults`）映射为 `{url, title, snippet?}`。
- **生效前提**：宿主 `web.searchProvider` 须指向 `volcengine`（base 默认 `deepseek-official`）。动态插件重启即失，宿主钉住 `volcengine` 而插件未加载会导致内置 web_search provider 缺失 —— 文档已提示。

### 5.5 设置页（client.js）
- `styles.insert` 定义 `.vsw-*` 样式；`SettingsView` 用 `React.createElement` 渲染。
- 字段：API Key(password) / 默认条数 / 默认时间范围 / 默认权威级别 / 默认查询改写 + 保存 + 测试搜索。
- `slots.inject('settings.section', () => slots.register({name:'settings.section', id:'volc-search', order:32, label:'火山引擎搜索'}, SettingsView))`。

---

## 6. 加载 / 运行 / 调试

### 6.1 重新加载插件（进程重启后必做）
1. `cordis_define`：`kind:'new'`（或已有则 `{kind:'existing', pluginId}`），`code.host` = `host.js` 从 `return {` 起的内容，`code.client` = `client.js` 从 `return {` 起的内容（**不含文件头注释**）。
2. `cordis_run`：首次 `mode:'run'`；客户端半部需用户在 WebUI 批准。
3. 重填 API Key / 默认参数（宿主内存配置不持久）。

### 6.2 排查运行状态
- `cordis_inspect_self`（无参=插件列表；`pluginId`=版本指针；`pluginId+packageId`=源码与诊断）。
- 客户端渲染崩溃会以「Client UI ... failed while rendering Slot ...」推送，读 message 定位。
- 常见宿主失败：`Invalid effect` = apply 返回了普通对象（见 §3）。
- 搜索失败：先在设置页「测试搜索」看错误文案；invalid_api_key → 检查 Key；网络失败 → 检查能否访问 `open.feedcoopapi.com`（并确认 PATH 里有 `node`）。

### 6.3 语法自检（改完 host.js / client.js 后）
```powershell
$body = Get-Content host.js -Raw
Set-Content "$env:TEMP\h.js" -Value "async function __wrap() {`n$body`n}" -Encoding UTF8
node --check "$env:TEMP\h.js"
$body2 = Get-Content client.js -Raw
Set-Content "$env:TEMP\c.js" -Value "async function __wrap() {`n$body2`n}" -Encoding UTF8
node --check "$env:TEMP\c.js"
```

---

## 7. 测试清单（改任何模块后回归）

- [ ] 设置页能读/写配置（保存后刷新可见）
- [ ] 填了 API Key 后「测试搜索」返回结果文本（标题/URL/摘要）
- [ ] 不填 Key 时「测试搜索」给出 invalid_api_key 引导文案，不崩溃
- [ ] agent 能调用 `byted_web_search` 工具并拿到结果
- [ ] （若配置了 searchProvider=volcengine）内置 `web_search` 走火山引擎
- [ ] 断网 / 错 Key：设置页与工具都显示明确错误，不崩溃

---

## 8. 已知限制与可扩展方向

**已知限制**：
- 宿主配置只存内存，插件重载/进程重启后需重填。
- 仅支持 API Key（Bearer）鉴权；AK/SK 签名模式因沙箱无 crypto 无法实现。
- 依赖 PATH 里的 `node`（DSH 运行在 Node 上，常规部署必然满足；极端场景若 PATH 被裁剪则 `resolveExecutable('node')` 会报错）。
- 动态插件随 DSH 进程消失（需重新 define）。

**可扩展方向**：
1. **配置持久化**：把 host 配置落到本地存储，避免重启重填。
2. **固化为静态插件**：写进宿主组合配置（cordis.yml / agent preset）成为常驻插件，`byted_web_search` 常驻可用；静态插件有完整 fetch，可顺带支持 AK/SK 签名。
3. **图片搜索增强**：`--type image` 已透传，可在工具描述/设置里补充图片专用展示。

---

## 9. 变更流程（保持一致性）

1. 改 `host.js` / `client.js`（磁盘）→ `node --check` 语法自检。
2. `cordis_define`（`kind:'existing'`，同 `pluginId`）提交新 Package（不可变，勿覆盖旧版本）→ `cordis_run mode:'update'`。
3. 同步 `README.md`（用户可见行为）与 `CODE_REVIEW.md`（在末尾追加修复记录表）。
4. 回归 §7 测试清单。
5. 若改动了本文档描述的行为，同步更新本文件。
