# Web 搜索插件（火山引擎 + Tavily）

在 DeepSeek Harness（DSH）里用 **火山引擎联网搜索** 和/或 **Tavily Search** 替代默认的 DeepSeek 联网搜索，可**直接替换** DSH 内置的 `@deepseek-ai/dsh-web-search-deepseek` 插件。

**为什么需要它**：DSH 默认 `web_search` 工具路由到 DeepSeek 搜索（`web.searchProvider: deepseek-official`）。如果你没有 DeepSeek 搜索 API，这个插件让你换用火山引擎 / Tavily：

1. **新增模型工具 `web_search_multi`**：agent 可直接调用，**后端自动路由** —— 填了火山引擎 API Key 用火山引擎；否则填了 Tavily API Key 用 Tavily；**两者都未配置时自动使用 Tavily keyless 免费模式**（无需任何 Key，开箱即用）；
2. **注册 `ctx.web` 搜索 Provider（id=`deepseek-official`）**：与内置插件同 id，把内置插件从宿主组合移除后，**内置 `web_search` 工具无需任何配置**就路由到本插件（真正替换）；同时注册 `web-search`（可用 `DSH_WEB_SEARCH_PROVIDER=web-search` 显式选用）与 `volcengine`（旧版兼容）两个别名 id；
3. **设置页**（设置 → Web 搜索）：只配置火山引擎与 Tavily 两个 API Key（都可留空），外加默认参数与「测试搜索」。

## 0 外部依赖

本插件**零外部依赖，完全依赖 DSH 自身运行**：

- 动态插件 Host 沙箱没有 `fetch`，`ctx.web.fetch` 只支持 `{url}` 无法自定义 method/headers/body，不能直接 POST API；
- 插件通过宿主 `ctx.subprocess` 拉起 **DSH 自身所在的 Node 运行时**（`resolveExecutable('node')`），用 Node 内置 `https` 模块直连火山引擎 / Tavily API —— Node 是 DSH 的运行基础，必然存在，且自带 OpenSSL（不受本机 curl 的 TLS/schannel 问题影响）；
- 请求 JSON body 经 stdin 传入，子进程 stdout 输出 `HTTP状态码\n响应体`，响应直接解析结构化 JSON。

唯一可选的是**两个 API Key**（在「设置 → Web 搜索」填写，都可留空）。

## 后端自动路由规则

| 配置 | 生效后端 |
|---|---|
| 填了火山引擎 API Key | 火山引擎（API Key 模式） |
| 只填了 Tavily API Key | Tavily（API Key 模式） |
| 都没填 | **Tavily keyless 免费模式**（`X-Tavily-Access-Mode: keyless`，无需任何 Key） |

模型工具 / 设置页测试均可通过 `provider=volcengine | tavily | auto` 显式指定后端。

## 配置

| 项 | 说明 | 默认 |
|---|---|---|
| 火山引擎 API Key | https://console.volcengine.com/search-infinity/api-key ，**可选** | 空 |
| Tavily API Key | https://app.tavily.com ，**可选** | 空 |
| 默认条数 | 模型工具未显式传参时的返回条数（火山 web ≤50、image ≤5；Tavily ≤20） | 10 |
| 默认时间范围 | 火山：OneDay/OneWeek/OneMonth/OneYear 或日期区间；Tavily：day/week/month/year/d/w/m/y 或日期区间（自动归一化） | 空 |
| 默认仅权威来源 / 查询改写 | 仅火山引擎生效 | 关 / 关 |
| Tavily 搜索深度 / 主题 | basic/advanced/fast/ultra-fast；general/news/finance | basic / general |

> 火山引擎仅支持 **API Key（Bearer）** 方式；AK/SK 签名模式需要 HMAC-SHA256，动态沙箱无 crypto 模块无法实现，故不支持。

## 使用

1. 打开「设置 → Web 搜索」，可选填火山引擎 / Tavily 的 API Key，点「保存设置」；可用「测试搜索」验证（可指定后端）。**什么都不填也能搜**（Tavily keyless）。
2. 告诉 agent 使用搜索（agent 会自动看到并调用 `web_search_multi` 工具；内置 `web_search` 工具在替换后同样可用）。

### 替换内置 `@deepseek-ai/dsh-web-search-deepseek`（推荐用法）

本插件以 id=`deepseek-official` 注册 Provider。把内置插件从宿主组合移除（或禁用），DSH 重启后加载本插件，宿主默认的 `web.searchProvider: deepseek-official` 就直接路由到本插件 —— **无需改任何 web 配置**。

- 若不想动组合，也可设环境变量 `DSH_WEB_SEARCH_PROVIDER=web-search`（或旧版 `volcengine`）后重启 DSH，显式选用本插件。
- 内置插件仍挂载时，本插件 `deepseek-official` 注册会因 id 被占而跳过（宿主日志有提示），此时 `web_search` 仍走 DeepSeek；改用上述两种方式之一即可切到本插件。

> ⚠️ 本插件是动态插件，随 DSH 进程重启而消失（需重新 `cordis_define` + `cordis_run`，Key 需重填）。宿主若把 `searchProvider` 钉到 `deepseek-official` 而本插件未加载，内置 `web_search` 会报 provider 缺失 —— 推荐以 `web_search_multi` 工具为主。

## 加载

动态插件通过 agent 会话内的 `cordis_define` / `cordis_run` 加载（见仓库根 README）：

1. `cordis_define`：`kind: 'new'`，`code.host` = `host.js` 内容，`code.client` = `client.js` 内容（不含文件头注释）。
2. `cordis_run`：首次 `mode: 'run'`；Client 半部需在 WebUI 批准。
3. 进程重启后需重新加载；两个 API Key 等宿主内存配置需重填。

## 参考

- 火山引擎联网搜索文档：https://docs.volcengine.com/docs/87772/2272953 、https://docs.volcengine.com/docs/87772/2548026
- Tavily keyless 文档：https://docs.tavily.com/documentation/keyless.md
- Tavily Search API：https://docs.tavily.com/documentation/api-reference/endpoint/search.md
- QwenPaw 搜索工具实现对照：`qwenpaw-web-search-implementation.md`（Tavily keyless 后端与之对齐）
