# 设计文档：web-search-plugin 替换内置 web 工具链（web_search 薄接口问题）

> 状态：**设计讨论稿**（尚未实施）
> 提出日期：2026-09-11
> 相关插件：web-search-plugin；涉及 DSH 内置包：`@deepseek-ai/dsh-web-search-deepseek`、`@deepseek-ai/dsh-web`、`@deepseek-ai/dsh-tool-web`
> 源码位置均指 DSH 部署 checkout（`/Users/xiaoka/project/deepseek-harness/`）下的相对路径。

---

## 1. 背景与目标

内置 `web_search` 工具（由 `@deepseek-ai/dsh-tool-web` 提供）**接口薄弱**：参数只有一个 `queries: string[]`（1~4 条），模型无法控制返回条数、时间范围、图片搜索、权威来源过滤、后端选择等。web-search-plugin 为此自带了富参数工具 `web_search_multi`，但带来两个工具的冗余。

**目标**：评估把 `@deepseek-ai/dsh-tool-web` 也替换掉（或至少替换其 `web_search` 工具）的成本，让模型只有一个 `web_search` 入口、但参数能力完整（火山引擎 / Tavily 全部可选项），并保持内置 `web_fetch` 的 HTML 渲染质量不丢失。

---

## 2. 现状盘点：内置三层 + 本插件当前角色

```
┌─ 模型入口层 ──────────────────────────────────────────────┐
│ @deepseek-ai/dsh-tool-web（tool-web）                      │
│   web_search（queries 数组，参数极简）                       │
│   web_fetch（URL 抓取 + HTML→Markdown 渲染，~517 行）       │
│   systemPrompt 指引段 + trust notice                        │
├─ 接缝层 ──────────────────────────────────────────────────┤
│ @deepseek-ai/dsh-web（web 服务）                            │
│   registerSearchProvider / registerFetchProvider            │
│   search() 按 searchProvider 选 Provider（默认 deepseek-official）│
│   fetch() 按 fetchProvider 选 Provider（默认 http）          │
├─ 后端层 ──────────────────────────────────────────────────┤
│ @deepseek-ai/dsh-web-search-deepseek → Provider deepseek-official │
│ @deepseek-ai/dsh-web-fetch-http  → Provider http            │
│ web-search-plugin（本插件）→ Provider deepseek-official（替换①）│
└────────────────────────────────────────────────────────────┘
```

**本插件当前角色**：已接管 ①（Provider `deepseek-official` + 设置页）；`web_search`/`web_fetch` 仍由 tool-web 提供；`web_search_multi` 是与内置工具平行的第二条富参数路径。

**本设计只讨论"是否/如何替换工具层（③）"；接缝层（②）与 `web-fetch-http` 在所有方案中都不动。**

---

## 3. 关键事实（源码核实，2026-09-11）

### 3.1 `harness.defineTool` 是 dsh-tools `defineTool` 的完整透传
`packages/extensions/cordis-host-runner/src/guard.ts` 的 `sandboxDefineTool` 把 `...options` 原样交给 `@deepseek-ai/dsh-tools` 的 `defineTool`（`packages/core/tools/src/schema.ts` L545）。因此动态插件**支持**：
- `output.{schema, render, presentationMeta?}`（沙箱额外校验 render 返回内容块数组）
- `timeoutMs` / `isConcurrencySafe` / `presentCall` / `presentResult`（透传，schema.ts L500-535 确认）
- `parameters` 统一 DSL（property 级 `required: true`）

→ **动态插件能 1:1 复刻 tool-web 的注册契约**（同名工具、同输出形状、同卡片 meta），这是方案 A/B 可行的前提。

### 3.2 作用域语义：scoped 会 shadow global
- tool-web 由 agent preset 按会话挂载，`ctx.tools.register` 落在 **session 作用域层**；
- 动态插件 host 半部挂在 `cordis-dynamic` 组（rootCtx 派生，无 scope 标签），`harness.registerTool → ctx.tools.register` 落在 **global 层**（`packages/core/scope/src/store.ts` `NamedEntries.insert`，同层重名才抛错；不同层允许，scoped 遮蔽 global）。

→ **要让插件注册的 `web_search` 对模型可见，必须让 tool-web 的 search 让位**（`search: false` 或整行移除），否则它的 session 作用域 `web_search` 会盖住我们的。

### 3.3 动态 Host 沙箱无 DOM / 无 require（web_fetch 的硬卡点）
可用全局仅 `ctx / harness / console / btoa / atob / TextEncoder / TextDecoder`（`Builtin.listBuiltins` 实测）。tool-web `fetch.ts` 的核心是 HTML→Markdown 转换（turndown + DOM 解析 + 表格渲染 + 深度守卫，L25-L242），**在动态沙箱里跑不起来**，只能退化为 subprocess 正则级 HTML→text（质量/健壮性下降）。

### 3.4 tool-web 的挂载位置与配置开关
- base bundle（`packages/bundle/base/cordis.patch.yml` L450）有 tool-web 行，Web app bundle（`web-app/cordis.patch.yml` L470）将其 `disabled: true`，改由 **agent preset 按会话组合**：
  - `packages/preset/agent-presets/presets/standard/agent.cordis.yml` L248
  - `packages/preset/agent-presets/presets/cordis/agent.cordis.yml` L236（当前会话默认 preset=cordis）
- tool-web `Config`（`packages/web/tool-web/src/index.ts` L54-62）自带开关与限额：
  - `search?: boolean`（默认 true）/ `fetch?: boolean`（默认 true）
  - `searchMaxResults`=8、`searchMaxQueries`=4、`fetchTimeoutMs`=30s、`searchTimeoutMs`=30s（base/preset 配 60s）、`fetchMaxOutputChars`=200_000

### 3.5 tool-web 资产清单（要复刻/保留的内容）
| 资产 | 文件 | 规模 | 替换成本 |
|---|---|---|---|
| `web_search` 工具 | `tool-web/src/search.ts` | 377 行 | 低（schema/校验/合并/格式化/卡片，均可移植） |
| `web_fetch` 工具 | `tool-web/src/fetch.ts` | 517 行 | **高**（HTML→Markdown 转换依赖 DOM，沙箱不可移植） |
| trust notice | `tool-web/src/trust.ts` | 7 行 | 低 |
| systemPrompt 指引 | 两工具各自注册 | 少量 | 低（`ctx.get('systemPrompt').section(...)` 动态可用） |

---

## 4. 方案对比

### 方案 A：只替换 `web_search` 工具，保留 `web_fetch`（推荐）
- **组合改动**：preset 的 tool-web 行 `config` 改为 `{search: false, fetch: true, searchTimeoutMs: 60000}`（关掉内置 web_search，web_fetch 原样保留）。
- **插件改动**：注册**同名** `web_search`，把 `web_search_multi` 的富参数并入本体（见 §5 参数表）；输出形状与 `presentationMeta` 保持 `{content, sources[], truncated}` / `{sources, truncated, answer}`，shell 现有 web 结果卡片（`tool.call.toolview` key=`web_search`）继续工作；补 systemPrompt 指引段。
- **成本**：低（一行 preset + 插件 ~100 行）。`web_fetch` 的 HTML 渲染能力完整保留。
- **风险**：动态插件进程级——DSH 重启后 `web_search` 消失（tool-web search 已关，无回退），需重载插件；此点与现有 `deepseek-official` Provider 同理。

### 方案 B：整体替换 tool-web（web_search + web_fetch）
- 移除 tool-web 行；`web_search` 同方案 A；`web_fetch` 需重写，但 HTML→Markdown 在动态沙箱内无法高质量复刻（§3.3），subprocess 正则降级或只返回原文。
- **成本**：中高，且 web_fetch 质量下降明显——**不建议**。

### 方案 C：固化为静态插件，一拖三（正解，但一次性改动）
- 把 web-search-plugin 改写为宿主组合里的**静态插件行**（`cordis.patch.yml`），同时移除 `web-search-deepseek` + `tool-web` 两行。
- 静态插件有完整 Node：`fetch`、DOM、可引第三方库——`web_fetch` 可完整复刻，Provider/设置页/工具常驻跨重启，不再需要 subprocess 绕路（顺带支持 AK/SK 签名）。
- **成本**：中；需要动宿主组合 + 重启 DSH（一次性）。与仓库 `agents.md`「可扩展方向 #2」一致。

### 成本总表
| 方案 | 替换范围 | 成本 | 主要风险 |
|---|---|---|---|
| A | 只换 `web_search` 工具 | 低 | 动态插件重启即失（每次重启需重载） |
| B | `web_search` + `web_fetch` | 中高 | HTML→Markdown 沙箱内无法高质量复刻 |
| C | 静态插件接管全部 | 中 | 需改宿主组合并重启（一次性） |

---

## 5. 方案 A 详细设计（如实施）

### 5.1 组合改动
当前 preset（cordis）tool-web 行：
```yaml
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    search: false        # ← 新增：关掉内置 web_search，让位给插件
    fetch: true
    searchTimeoutMs: 60000
```
> 改动落在用户实际使用的 preset 上（含从 shipped preset 复制的自管副本）；`packages/bundle/web-app/cordis.patch.yml` 的 disabled 行不用动。

### 5.2 插件注册的 `web_search`（合并后的参数表）
| 参数 | 类型 | 说明 |
|---|---|---|
| `queries` | string[] | 保留数组形态（1~4 条、自动合并去重），兼容模型既有习惯 |
| `provider` | enum auto/volcengine/tavily | 后端选择（auto 按 Key 自动路由） |
| `count` | integer | 返回条数（火山 web≤50/image≤5；Tavily≤20），默认 10 |
| `type` | enum web/image | 图片搜索（仅火山） |
| `time_range` | string | 火山 OneDay/…/日期区间；Tavily day/week/…/日期区间（自动归一化） |
| `auth_level` | enum 0/1 | 仅权威来源（仅火山） |
| `query_rewrite` | boolean | 查询改写（仅火山） |
| `search_depth` | enum basic/advanced/fast/ultra-fast | Tavily 搜索深度 |
| `topic` | enum general/news/finance | Tavily 主题 |

### 5.3 兼容性保证（不破坏现有 UI/习惯）
- 工具名保持 `web_search` → `tool.call.toolview` 的现有卡片 key 直接复用；
- `output.schema` 保持 `{content?, sources[{url,title?,snippet?,publishedAt?}], truncated}`；
- `output.presentationMeta` 保持 `{sources, truncated, answer?}`（= tool-web `searchMetaFromValue` 的形状），回放/日志卡片不坏；
- `timeoutMs: 60000`、`isConcurrencySafe: () => true` 与现状一致；
- systemPrompt 指引段由插件注册（`ctx.get('systemPrompt').section(...)`），措辞沿用 tool-web 的版本并补充新参数说明；
- 移除 `web_search_multi`（富参数并入 web_search 后不再需要第二个工具）。

### 5.4 执行路径
`web_search.execute` → 多 query 并发 → 每个 query 走 `runSearch(query, {…富参数})` → 合并去重、截断 → `{content, sources, truncated}`。火山/Tavily 双后端、错误映射、keyless 兜底全部复用现有 host.js 逻辑。

---

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| DSH 重启后 `web_search` 缺失（tool-web search 已关） | 每次重启重载插件（现状同 Provider 一样）；长期可走方案 C 固化 |
| 参数变多导致模型误用 | 参数均带 default/description；保持 `queries` 数组形态兼容旧习惯 |
| `web_fetch` 与 `web_search` 分别由两个插件提供，状态割裂 | 可接受（fetch 走 `fetchProvider: http`，与搜索后端无关） |
| 若未来改 preset 配置失误，两工具都丢 | 变更前后按测试清单回归 |

---

## 7. 决策记录

- [ ] 待决策：实施哪个方案（推荐 A；零运维选 C）
- [ ] 待决策：`queries` 数组 vs 单 `query`（兼容性优先建议保留数组）
- [ ] 待实施（方案 A）：preset 配置改动 + 插件新 Package（`cordis_define kind:existing` + `cordis_run mode:update`）+ 文档同步
