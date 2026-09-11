# 火山引擎（豆包）搜索插件

在 DeepSeek Harness（DSH）里用**火山引擎联网搜索**（又叫豆包搜索）替代默认的 DeepSeek 联网搜索。

**为什么需要它**：DSH 默认 `web_search` 工具路由到 DeepSeek 搜索（`web.searchProvider: deepseek-official`）。如果你没有 DeepSeek 搜索 API、但有火山引擎搜索 API，这个插件让你：

1. **新增模型工具 `byted_web_search`**：agent 可直接调用，走火山引擎 API，返回标题/来源/URL/摘要 —— 不依赖宿主 `web` 服务的 provider 选择，开箱即用；
2. **注册 `ctx.web` 搜索 Provider（id=`volcengine`）**：在宿主把 `web` 服务 `searchProvider` 配成 `volcengine`（或设 `DSH_WEB_SEARCH_PROVIDER=volcengine`）后，内置 `web_search` 工具也走火山引擎；
3. **设置页**（设置 → 火山引擎搜索）：填 API Key、默认参数，并支持「测试搜索」。

## 0 外部依赖

本插件**零外部依赖，完全依赖 DSH 自身运行**：

- 动态插件 Host 沙箱没有 `fetch`，`ctx.web.fetch` 只支持 `{url}` 无法自定义 method/headers/body，不能直接 POST API；
- 插件通过宿主 `ctx.subprocess` 拉起 **DSH 自身所在的 Node 运行时**（`resolveExecutable('node')`），用 Node 内置 `https` 模块直连火山引擎搜索 API —— Node 是 DSH 的运行基础，必然存在，且自带 OpenSSL（不受本机 curl 的 TLS/schannel 问题影响）；
- 请求 JSON body 经 stdin 传入，响应直接解析结构化 JSON。

唯一需要的是**一个火山引擎联网搜索 API Key**（在「设置 → 火山引擎搜索」填写）。

## 配置

| 项 | 说明 | 默认 |
|---|---|---|
| API Key | 火山引擎联网搜索 Key（https://console.volcengine.com/search-infinity/api-key ），**必填** | 空 |
| 默认条数 / 时间范围 / 权威级别 / 查询改写 | 模型工具未显式传参时使用的默认值 | 10 / 空 / 0 / false |

> ⚠️ 仅支持 **API Key（Bearer）** 方式。AK/SK 签名模式需要 HMAC-SHA256，动态沙箱无 crypto 模块无法实现，故不支持。

## 使用

1. 打开「设置 → 火山引擎搜索」，填入 API Key，点「保存设置」；可用「测试搜索」验证。
2. 告诉 agent 使用搜索（agent 会自动看到并调用 `byted_web_search` 工具）。

### 让内置 `web_search` 也走火山引擎（可选）

在宿主配置把 web 服务的搜索 provider 指到本插件：

- 设置环境变量 `DSH_WEB_SEARCH_PROVIDER=volcengine` 后重启 DSH，或
- 在宿主 `cordis.patch.yml` 的 `web` 行把 `searchProvider` 改为 `volcengine`。

> ⚠️ 该插件是动态插件，随 DSH 进程重启而消失；若 host 已把 `searchProvider` 钉到 `volcengine` 但本插件未加载，内置 `web_search` 会报 provider 缺失。推荐以 `byted_web_search` 工具为主。

## 加载

动态插件通过 agent 会话内的 `cordis_define` / `cordis_run` 加载（见仓库根 README）：

1. `cordis_define`：`kind: 'new'`，`code.host` = `host.js` 内容，`code.client` = `client.js` 内容（不含文件头注释）。
2. `cordis_run`：首次 `mode: 'run'`；Client 半部需在 WebUI 批准。
3. 进程重启后需重新加载；API Key 等宿主内存配置需重填。

## 参考

- 火山引擎联网搜索文档：https://docs.volcengine.com/docs/87772/2272953 、https://docs.volcengine.com/docs/87772/2272949 、https://docs.volcengine.com/docs/87772/2548026
- 请求/响应结构与错误码参考 byted-web-search 技能（`scripts/web_search.py`）的 API Key 路径
