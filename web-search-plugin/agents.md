# Web 搜索插件（火山引擎 + Tavily）—— Agent 开发与维护手册

> 面向后续接手开发/维护的 agent 与人类开发者的交接文档。先读本文件，再动代码。
> 配套文档：`README.md`（用户视角功能说明）；运行时环境底图见仓库 `docs/dynamic-plugin-host-sandbox.md`；
> QwenPaw 搜索工具实现对照见 `qwenpaw-web-search-implementation.md`。

---

## 1. 项目一句话

DeepSeek Harness Web GUI 上的**动态 Cordis 插件**（前身 volc-search-plugin，已更名）：通过宿主 `ctx.subprocess` 拉起 **DSH 自身所在的 Node 运行时**（`resolveExecutable('node')` + 内联 `-e` 脚本，用 Node 内置 `https` 模块）直连**火山引擎联网搜索**与 **Tavily Search** 两个 API（0 外部依赖，不需要 curl / Python）。注册模型工具 `web_search_multi` 与 `ctx.web` 搜索 Provider（优先 id=`deepseek-official`，可替换内置 `@deepseek-ai/dsh-web-search-deepseek`），并提供设置页配置两个 API Key 与默认参数。**后端自动路由：火山 Key → 火山引擎；Tavily Key → Tavily；都不配 → Tavily keyless 免费模式（无需 Key，开箱即用）。**

---

## 2. 架构总览（先建立心智模型）

```
┌─ 浏览器（code.client，仅设置 UI）────────────────────────────┐
│ 设置页 settings.section「Web 搜索」                            │
│   火山 Key / Tavily Key / 默认参数 / 生效后端 / 测试搜索        │
│   └ host.call('get-config'|'set-config'|'test-search')        │
└───────────────────────────────────────────────────────────────┘
        ▲ host.call
┌─ Host（code.host，核心逻辑在此）───────────────────────────────┐
│ 内存 state：volcApiKey / tavilyApiKey / 默认参数               │
│ harness.handle → get-config / set-config / test-search         │
│ harness.defineTool → web_search_multi（模型工具）              │
│ ctx.web.registerSearchProvider                                 │
│   ├ deepseek-official  ← 替换内置插件（id 被占则跳过+提示）     │
│   ├ web-search        ← 本插件自带 id                          │
│   └ volcengine        ← 旧版兼容别名                            │
│ runSearch()：按配置路由到 volcSearch / tavilySearch            │
│   └ ctx.subprocess.spawn(node -e <内联脚本> POST API)          │
└───────────────────────────────────────────────────────────────┘
```

**关键决策（不要轻易推翻）**：
- 动态 Host 沙箱**无 `fetch`**（`ctx.web.fetch` 只支持 `{url}`），网络访问的唯一途径是 `ctx.subprocess` 拉起外部进程。
- **0 外部依赖**：外部进程用 **DSH 自身所在的 Node 运行时**（`resolveExecutable('node')` + `node -e` 内联脚本 + Node 内置 `https` 模块），不依赖系统 curl / Python / requests；Node 是 DSH 的运行基础必然存在，且自带 OpenSSL（不受本机 curl 的 TLS/schannel 问题影响）。
- **统一内联脚本生成器 `buildNodeScript(endpoint, headers, envKeyName, keylessHeader)`**：stdout 输出 `HTTP状态码\n响应体`；任何 HTTP 响应（含 4xx/5xx）都以 0 退出，由插件解析状态码与 JSON 判断业务错误；只有传输层错误才非 0 退出。火山脚本无 keyless 头；Tavily 脚本在未配置 Key 时自动附加 `X-Tavily-Access-Mode: keyless`。
- 请求 JSON body 经 `stdin: { data: bodyText }` 传入（避免命令行转义）；API Key 经 `spawn.env` 显式条目（`VOLC_API_KEY` / `TAVILY_API_KEY`）传给子进程，能存活过 subprocess 的敏感变量 scrub。
- **火山引擎仅用 API Key（Bearer）模式**：AK/SK 签名需要 HMAC-SHA256，动态沙箱无 crypto 模块，无法实现。
- **后端自动路由**（`effectiveBackend()`）：火山 Key → volcengine(keyed)；Tavily Key → tavily(keyed)；都不配 → tavily(keyless)。`provider` 显式指定（volcengine/tavily）优先于自动路由。
- `subprocess` 是**硬依赖**（`inject: ['subprocess']`）；`ctx.web` 是**可选依赖**（`ctx.get('web')`），provider 注册失败不影响工具。
- Provider 注册**三个 id 逐个 try/catch**：`deepseek-official`（替换内置，被占则 console.error 提示并跳过）、`web-search`（本插件 id）、`volcengine`（旧版兼容）。同一 provider 对象按 id 复制后注册。

---

## 3. 运行环境硬约束（写代码前必读）

动态插件两端都是**纯 JS 函数体**（async 函数体，`return { apply(ctx) {...} }`），无构建：

| 约束 | 说明 |
|---|---|
| ❌ 无 JSX / TypeScript / import / require | 客户端 React 一律 `React.createElement(...)`；宿主无模块导入 |
| ❌ `fetch` 被禁用（两端） | 本插件网络一律走 Host `ctx.subprocess` 拉起 DSH 自身 Node 运行时（内联 `-e` 脚本 + 内置 `https`） |
| ❌ `setTimeout/setInterval` 被禁用 | 若需定时器用 `inject: ['timer']`（本插件暂未用到） |
| ⚠️ 宿主可用全局 | `ctx / harness / console / btoa / atob / TextEncoder / TextDecoder`；无 `process`/`fetch`/`crypto` |
| ⚠️ 客户端可用全局 | `styles / React / host / ctx.get('slots')` 等（client Builtins 实测：React/host/styles/console/ctx） |
| ✅ 插件 `apply` 不能返回普通对象 | 返回 `undefined` / disposer / promise / 可迭代；返回 `{}` 会抛 `Invalid effect` |
| ✅ `harness.handle` / `registerTool` 清理 | runner 统一回收，插件无需手动挂 effect |
| ⚠️ 工具重名即抛错 | `ctx.tools.register` 全局层重名抛 duplicate（`NamedEntries.insert`）；本插件工具名 `web_search_multi` 为新增名，不与内置 `web_search`/`web_fetch` 或旧版遗留 `byted_web_search` 冲突 |
| ⚠️ Provider 重名即抛错 | `web.registerSearchProvider` 同 id 抛 `WEB_DUPLICATE_PROVIDER`；注册处已 try/catch 处理 |
| ⚠️ 动态插件进程级 | DSH 进程重启会丢失插件与宿主内存配置，需重新 `cordis_define` + 重填 Key |

---

## 4. 目录与文件

| 文件 | 作用 | 与运行版本的一致性 |
|---|---|---|
| `host.js` | code.host 源码（核心逻辑） | 与运行版本一致 |
| `client.js` | code.client 源码（设置页） | 与运行版本一致（改完必须同步） |
| `README.md` | 用户功能说明 | 改功能后同步 |
| `agents.md` | 本文档 | — |
| `qwenpaw-web-search-implementation.md` | QwenPaw 搜索工具实现调研（参考对照） | 仅调研结论 |
| `DESIGN-tool-web-replacement.md` | 设计文档：替换内置 tool-web（web_search 薄接口）的方案对比（A/B/C） | 决策参考，实施前读 |
| `CODE_REVIEW.md` | code review 记录（本地，不入库） | 修完追加记录 |

> ⚠️ 教训（index-tts 第三轮 review 抓到的 bug）：**只改 define 代码、不同步磁盘源文件**会导致「运行版本与磁盘不一致」。任何改动两者都要同步。

---

## 5. 核心模块详解

### 5.1 配置存储（host.js）
- 内存 `state`：`volcApiKey / tavilyApiKey / defaultCount / defaultTimeRange / defaultAuthLevel / defaultQueryRewrite / defaultSearchDepth / defaultTopic`。
- `harness.handle('get-config')`：返回 clone + `effective`（自动路由结果 `{provider, mode}`）。
- `harness.handle('set-config')`：范围校验后合并（Key trim、count 1~50、authLevel 0/1、boolean 校验、searchDepth/topic 枚举校验），返回 clone + `effective`。
- `harness.handle('test-search')`：`{query, provider?}` → 跑一次搜索，返回 `{ok, provider, mode, text}` 或 `{ok:false, error}`。

### 5.2 内联 Node 脚本 `buildNodeScript(endpoint, headers, envKeyName, keylessHeader)`（host.js）
- 常量脚本骨架（`https` 模块）：读完整 stdin 作为请求 body → `https.request(POST, {timeout:25000})` → **stdout 写 `HTTP状态码\n响应体` 并 exit 0**；传输层错误 → stderr + exit 1。
- 鉴权：`process.env[ENV_KEY]` 非空 → 加 `Authorization: Bearer <key>`；为空且给了 `keylessHeader` → 加免 Key 头。
- 火山：`buildNodeScript(VOLC_URL, {'Content-Type':'application/json','X-Traffic-Tag':TRAFFIC_TAG}, 'VOLC_API_KEY', null)`。
- Tavily：`buildNodeScript(TAVILY_URL, {'Content-Type':'application/json'}, 'TAVILY_API_KEY', {name:'X-Tavily-Access-Mode', value:'keyless'})`。
- ⚠️ 改脚本时必须保持「stdout 首行是状态码」约定，`postNode` 依赖它解析。

### 5.3 统一 POST `postNode(script, env, bodyText)`（host.js）
- `resolveNode()`：`ctx.subprocess.resolveExecutable('node')`（PATH 解析，结果缓存）；解析失败抛「找不到 Node 运行时」。
- `ctx.subprocess.spawn({ argv:[nodeExe,'-e',script], cwd:'.', env, stdio:{stdin:{data}, stdout:{maxBytes:500000}, stderr:{maxBytes:50000}}, graceMs:30000 })`。
- `await handle.done` → `handle.collected.stdout.readFrom(0).text`；非 0 退出 → 抛错（优先 stderr）。
- 解析 `状态码\n响应体` → `{status, body}`；首行非数字 → 抛「无法解析 API 响应头」。

### 5.4 请求 body 构造
- `buildVolcBody(query, opts)`：`{Query, SearchType, Count}`；web 类型加 `NeedSummary:true`、`Filter.AuthInfoLevel`（authLevel>0）、`TimeRange`（有值才加）；`queryRewrite` 加 `QueryControl.QueryRewrite`。Count clamp 1~50。
- `buildTavilyBody(query, opts)`：`{query, max_results(clamp 1~20), search_depth}`；topic≠general 才加 `topic`；`time_range`/`start_date`/`end_date` 由 `mapTavilyTimeRange` 归一化（OneDay→day、日期区间→start/end，其余透传）。

### 5.5 后端路由与核心执行 `runSearch(query, opts)`（host.js）
- `effectiveBackend()`：火山 Key → `{provider:'volcengine', mode:'keyed'}`；Tavily Key → `{provider:'tavily', mode:'keyed'}`；都不配 → `{provider:'tavily', mode:'keyless'}`。
- `resolveBackend(opts)`：`provider=volcengine|tavily` 显式优先，否则 `effectiveBackend().provider`。
- 火山路径：无 Key → 抛引导文案；有 Key → `volcSearch`。
- Tavily 路径：Key 有无皆可（无 Key 自动 keyless）→ `tavilySearch`。
- 返回 `{provider, mode, data}`。

### 5.6 错误处理
- 火山：解析 `ResponseMetadata.Error`；`invalid_api_key|10403` → 引导文案（含 Tavily keyless 替代提示）；否则 `[code]: msg`。`Result` 空 → 「搜索无返回结果」。
- Tavily：HTTP 非 2xx 时解析 `detail`（`detail.error` 或字符串）：401 → Key 无效引导；429 → 限流（keyless 时建议配 Key 或稍后重试）；432/433 → 配额超限；其它 → `HTTP status: detail`。`results` 非数组 → 「搜索无返回结果」。

### 5.7 格式化与 sources
- `formatVolc` / `formatTavily`：编号列表（标题/URL/摘要/发布时间/图片尺寸等），头部 `[后端] <provider> · <mode>`。
- `toSources(provider, data)`：Tavily `results[]` → `{url, title, snippet:content, publishedAt}`；火山 `WebResults|ImageResults` → `{url, title, snippet}`。

### 5.8 模型工具 `web_search_multi`
- `harness.defineTool` + `harness.registerTool`：
  - 参数：`query`(必填)、`provider`(enum auto/volcengine/tavily)、`count`(integer)、`type`(enum web/image，仅火山)、`time_range`(string)、`auth_level`(enum 0/1，仅火山)、`query_rewrite`(boolean，仅火山)、`search_depth`(enum basic/advanced/fast/ultra-fast，仅 Tavily)、`topic`(enum general/news/finance，仅 Tavily)。
  - `output.schema: {type:'string'}`，`render` 返回 text 块；`execute` → `runSearch` → `formatResult`。
- 注意参数 DSL 约束：properties 允许 `type/enum/const/required/description/title/default/examples`；`required` 在属性上必须是 `true`。

### 5.9 WebSearchProvider 注册（替换内置的关键）
- `ctx.get('web')` 存在时逐个注册（同 provider 对象按 id 复制）：
  1. `deepseek-official`：**与内置 `@deepseek-ai/dsh-web-search-deepseek` 同 id** —— 内置插件从宿主组合移除后，宿主默认 `searchProvider: deepseek-official` 直接路由到本插件，内置 `web_search` 无需改配置。
  2. `web-search`：本插件自带 id，`DSH_WEB_SEARCH_PROVIDER=web-search` 可显式选用。
  3. `volcengine`：旧版兼容（已设 `DSH_WEB_SEARCH_PROVIDER=volcengine` 的用户无需改配置）。
- 注册被拒（`WEB_DUPLICATE_PROVIDER` / already registered）→ console.error 提示（内置插件仍挂载或旧版插件遗留），跳过该 id，不影响其它 id。
- `available(){ return true }`（Tavily keyless 兜底，永远可用）；`search(request)` → `runSearch(request.query, {count: request.maxResults})` → `{content: formatResult(...), sources: toSources(...), truncated:false}`。
- **生效前提**：宿主 `web.searchProvider` 指向已注册的 id（base 默认 `deepseek-official`）。动态插件重启即失，宿主钉住某 id 而插件未加载会导致内置 web_search provider 缺失 —— 文档已提示。

### 5.10 设置页（client.js）
- `styles.insert` 定义 `.wsp-*` 样式；`SettingsView` 用 `React.createElement` 渲染。
- 字段：火山 Key(password) / Tavily Key(password) / 生效后端 badge / 默认条数 / 默认时间范围 / 权威来源 / 查询改写 / Tavily 深度 select / Tavily 主题 select + 保存 + 测试搜索（query + provider select auto/volcengine/tavily）。
- `slots.inject('settings.section', () => slots.register({name:'settings.section', id:'web-search', order:32, label:'Web 搜索'}, SettingsView))`。

---

## 6. 加载 / 运行 / 调试

### 6.1 重新加载插件（进程重启后必做）
1. `cordis_define`：`kind:'new'`（或已有则 `{kind:'existing', pluginId}`），`code.host` = `host.js` 从 `return {` 起的内容，`code.client` = `client.js` 从 `return {` 起的内容（**不含文件头注释**）。
2. `cordis_run`：首次 `mode:'run'`；客户端半部需用户在 WebUI 批准。
3. 重填两个 API Key / 默认参数（宿主内存配置不持久；不填也能用 Tavily keyless）。

### 6.2 排查运行状态
- `cordis_inspect_self`（无参=插件列表；`pluginId`=版本指针；`pluginId+packageId`=源码与诊断）。
- 客户端渲染崩溃会以「Client UI ... failed while rendering Slot ...」推送，读 message 定位。
- 常见宿主失败：`Invalid effect` = apply 返回了普通对象（见 §3）；工具/Provider 重名抛错 = 名称被占用（工具名 `web_search_multi` 应与任何现存工具不冲突；Provider 已被 try/catch）。
- 搜索失败：先在设置页「测试搜索」看错误文案；invalid_api_key/401 → 检查 Key；网络失败 → 检查能否访问 `open.feedcoopapi.com` / `api.tavily.com`（并确认 PATH 里有 `node`）。
- 内置 `web_search` 仍走 DeepSeek：说明内置 `web-search-deepseek` 插件仍挂载（`deepseek-official` id 被占），见 §5.9 与 README「替换内置」。

### 6.3 语法自检（改完 host.js / client.js 后）
```bash
node -e "const fs=require('fs');const h=fs.readFileSync('host.js','utf8');fs.writeFileSync('/tmp/h.js','async function __wrap(){\n'+h+'\n}');const c=fs.readFileSync('client.js','utf8');fs.writeFileSync('/tmp/c.js','async function __wrap(){\n'+c+'\n}')"
node --check /tmp/h.js && node --check /tmp/c.js
```

---

## 7. 测试清单（改任何模块后回归）

- [ ] 设置页能读/写配置（保存后刷新可见；生效后端 badge 随 Key 变化）
- [ ] 不填任何 Key：测试搜索（auto）走 Tavily keyless 并返回结果文本
- [ ] 填火山 Key 后：测试搜索（auto）走火山引擎；provider=tavily 仍可强制 Tavily
- [ ] 填错火山 Key / 错 Tavily Key：给出对应引导文案，不崩溃
- [ ] agent 能调用 `web_search_multi` 工具并拿到结果
- [ ] （替换后）内置 `web_search` 走本插件（deepseek-official 路由）
- [ ] 内置插件仍挂载时：插件正常加载，`deepseek-official` 注册被跳过并打日志，其余 id 可用
- [ ] 断网 / 错 Key：设置页与工具都显示明确错误，不崩溃

---

## 8. 已知限制与可扩展方向

**已知限制**：
- 宿主配置只存内存，插件重载/进程重启后需重填（不填也能用 Tavily keyless）。
- 火山引擎仅支持 API Key（Bearer）鉴权；AK/SK 签名模式因沙箱无 crypto 无法实现。
- Tavily keyless 免费模式有限流（429），文档已给引导。
- 依赖 PATH 里的 `node`（DSH 运行在 Node 上，常规部署必然满足；极端场景若 PATH 被裁剪则 `resolveExecutable('node')` 会报错）。
- 动态插件随 DSH 进程消失（需重新 define）；若宿主 `searchProvider` 钉住本插件 id 而插件未加载，内置 `web_search` 报 provider 缺失。
- 工具名从旧版 `byted_web_search` 更名为 `web_search_multi`（旧名被旧会话遗留占用，且名不副实）。

**可扩展方向**：
1. **配置持久化**：把 host 配置落到本地存储，避免重启重填。
2. **固化为静态插件**：写进宿主组合配置（cordis.yml / agent preset）成为常驻插件，`web_search_multi` 常驻可用；静态插件有完整 fetch，可顺带支持 AK/SK 签名。
3. **图片搜索增强**：`--type image` 已透传（仅火山），可在工具描述/设置里补充图片专用展示；Tavily 可加 `include_images` 透传。

---

## 9. 变更流程（保持一致性）

1. 改 `host.js` / `client.js`（磁盘）→ `node --check` 语法自检。
2. `cordis_define`（`kind:'existing'`，同 `pluginId`）提交新 Package（不可变，勿覆盖旧版本）→ `cordis_run mode:'update'`。
3. 同步 `README.md`（用户可见行为）与 `CODE_REVIEW.md`（在末尾追加修复记录表）。
4. 回归 §7 测试清单。
5. 若改动了本文档描述的行为，同步更新本文件。
