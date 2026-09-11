# QwenPaw 默认 `web_search` 工具实现方案

> 本文档梳理 QwenPaw 内置 `web_search` 工具的完整实现：从工具注册、Provider 抽象、到配置与凭据管理。
> 目的：为本插件（web-search-plugin，火山引擎 + Tavily）提供参考对照 —— QwenPaw 是「插件式 Provider + 每 Agent 配置」的 Python 实现，DSH 插件是「动态 Cordis 插件 + Node 直连 API」的 JS 实现，二者解决的是同一类问题。
> 注：本插件已把 Tavily 升级为一等后端（`tavilySearch`，keyless/keyed 自动切换），实现与本文件 §6 的 `TavilyProvider` 对齐。
>
> 参考源码位置：`/Users/xiaoka/project/qwenpaw/src/qwenpaw/`

---

## 1. 总体架构

```
┌─ Agent 会话 ─────────────────────────────────────────────┐
│  LLM 调用 web_search(search_term)                        │
│    └ web_search.py  @tool_descriptor 装饰器自动注册       │
└──────────────────────────────────────────────────────────┘
        │
        ▼
websearch/factory.py  get_search_provider()
  - 从当前 Agent 的 Console 工具配置读取 provider 字段
  - 默认 tavily（免 key 后端），可选 anysearch
        │
        ▼
websearch/base.py  SearchProvider（抽象基类）
  - async def search(query, max_results=5) -> list[dict]
  - _post(): 统一异步 HTTP POST（30s 超时，校验证书）
  - format_search_results(): 统一结果格式化
        ├── websearch/tavily.py    TavilyProvider  （keyless 默认后端）
        └── websearch/anysearch.py AnySearchProvider（API Key + 配额自动处理）
        │
        ▼
web_search 返回 ToolChunk（SUCCESS / ERROR + 文本）
```

核心分层：

1. **工具入口**（`web_search.py`）：只做参数校验、调 provider、格式化、包 `ToolChunk`。
2. **Provider 抽象**（`websearch/base.py`）：定义 `SearchProvider` 接口，屏蔽后端差异。
3. **后端实现**（`tavily.py` / `anysearch.py`）：各自实现 HTTP 调用、鉴权、错误处理。
4. **选路工厂**（`websearch/factory.py`）：按当前 Agent 的配置决定用哪个后端。

---

## 2. 文件清单

| 文件 | 职责 |
|---|---|
| `agents/tools/web_search.py` | `web_search` / `web_fetch` 两个内置工具本体 |
| `agents/tools/websearch/__init__.py` | 导出 Provider 与工厂，声明 `__all__` |
| `agents/tools/websearch/base.py` | `SearchProvider` 抽象基类、`_post`、`format_search_results` |
| `agents/tools/websearch/tavily.py` | Tavily keyless 后端（默认） |
| `agents/tools/websearch/anysearch.py` | AnySearch 后端（API Key、配额自动注册/重试） |
| `agents/tools/websearch/factory.py` | `get_search_provider()` 选路 |
| `agents/tools/__init__.py` | 通过 import 触发 `@tool_descriptor` 自动收集注册 |
| `app/routers/tools.py` | 内置工具配置字段定义（provider / api_key）与凭据 ref 推导 |
| `config/config.py` | `BuiltinToolConfig` / `ToolsConfig` 模型与默认值 |

---

## 3. 工具注册机制（`@tool_descriptor`）

QwenPaw 的内置工具**不需要手写注册列表**，靠装饰器在 import 时自动收集：

- `web_search.py` 中 `@tool_descriptor(...)` 装饰器在模块导入时执行，把函数注册进全局注册表（`runtime/tool_registry.py`）。
- `agents/tools/__init__.py` 只需 `from .web_search import web_search, web_fetch`（导入即注册），`__all__` 由收集结果自动生成（`_build_all()`）。
- 新增一个内置工具只需两步：① 用 `@tool_descriptor` 装饰；② 在 `tools/__init__.py` import。

`web_search` 的装饰器元数据（`web_search.py` L136-145）：

```python
@tool_descriptor(
    async_execution=True,
    tool_type="network",
    target_param="search_term",
    policy_name="WebSearch",
    default_policy="allow",
    policy_reason="Allow web search",
    ui_description="Search the web for real-time information",
    ui_icon="🔎",
)
```

要点：

- **异步执行**：`async_execution=True`，工具函数是 `async def`。
- **治理标记**：`tool_type="network"`、`policy_name="WebSearch"`、`default_policy="allow"` —— 接入治理/审计体系。
- **UI 元数据**：`ui_description` / `ui_icon` 供 Console 展示。

---

## 4. 工具入口 `web_search`（web_search.py L146-198）

逻辑流程：

1. **参数校验**：`search_term` trim 后为空 → 返回 `ToolChunk(state=ERROR, text="Error: search_term is empty.")`。
2. **取 Provider**：`provider = get_search_provider()`。
3. **执行搜索**：`await provider.search(query, max_results=5)`，固定最多 5 条。
4. **格式化**：`format_search_results(results)`；无结果则 `"No content searched."`。
5. **返回**：
   - 成功 → `ToolChunk(state=SUCCESS, content=[TextBlock(text=...)])`；
   - 任何异常 → `ToolChunk(state=ERROR, text="web_search failed: {exc}\n\n{_SEARCH_FALLBACK_HINT}")`，并给 LLM 一条 fallback 提示（建议改用 `execute_shell_command` + curl 兜底）。

关键设计：

- 工具本身**不感知后端细节**，只依赖 `SearchProvider.search()` 契约；
- **错误信息反哺给 LLM**：失败时把异常文本 + 兜底建议拼进返回值，让模型能自行降级；
- 结果统一为 `ToolChunk` + `TextBlock`（AgentScope 消息模型），不是裸字符串。

同文件还实现了 `web_fetch`（L201-272）：URL 校验（仅 http/https + hostname）→ `httpx` GET（跟随重定向、SSL 失败自动降级为 `verify=False` 重试）→ `html2text` 转可读文本（自动把 `<title>` 变成标题）。它对 URL 内容类型做白名单（text/、application/xhtml、application/xml）。

---

## 5. Provider 抽象（websearch/base.py）

```python
class SearchProvider(ABC):
    name = ""

    @abstractmethod
    async def search(self, query: str, max_results: int = 5) -> list[dict]:
        """Return a list of ``{title, url, snippet, content}`` dicts."""
        raise NotImplementedError
```

- 契约极简：一个 `search()` 方法，返回 `{title, url, snippet, content}` 字典列表。
- 共享传输层 `_post(url, headers, payload)`：`httpx.AsyncClient`，30s 超时，**始终校验 TLS 证书**，POST JSON，`raise_for_status()` 后返回 `resp.json()`。
- 共享格式化 `format_search_results(results)`：把结果渲染成编号列表文本：

```
[1] 标题
    URL: ...
    摘要/正文
```

---

## 6. 默认后端：Tavily（websearch/tavily.py）

- QwenPaw 默认 `web_search` 走 **Tavily keyless** 模式（无需 API Key）。
- 请求 `https://api.tavily.com/search`，Header 带 `X-Tavily-Access-Mode: keyless`。
- body：`{query, max_results, search_depth: "basic"}`。
- 直接从响应 `data["results"]` 取列表返回。

---

## 7. 可选后端：AnySearch（websearch/anysearch.py）

更完整的企业级实现，值得本插件借鉴：

### 7.1 API Key 读取（`_current_agent_anysearch_key`）

- 凭据不在环境变量里，而是从**当前 workspace 的 `credentials.yaml`**（`AsyncCredentialStore`）读取，ref = `tool/web_search/anysearch`。
- **mtime 键控缓存**：凭据文件只有 mtime 变化才重新读取/解密，避免每请求都读盘。
- 通过 `get_current_workspace_dir()` 定位 workspace，与其它工具一致。

### 7.2 配额（402）自动处理（`_handle_quota_exceeded`）

- 请求失败返回 402 时按响应 `message` 分类处理：
  - **自动注册**（message 含 `"automatically generated"`）：响应体里带 `username=... password=... api_key=...`，解析出新 key（正则 `_CRED_LINE_RE`，注意去掉 api_key 行尾的句号），写入 `credentials.yaml` 持久化，然后用新 key 重试；
  - **匿名免费配额**（message 含 `"anonymous free quota"`）：`asyncio.sleep(1)` 后重试一次，再失败则抛带错误码的 `ValueError`；
  - 其它 402：直接抛 `ValueError`。

这套「自动注册 + 配额重试 + 凭据持久化」逻辑是典型的搜索 API 商业化模型处理范式。

---

## 8. 选路工厂（websearch/factory.py）

```python
def get_search_provider() -> SearchProvider:
    agent_id = get_current_agent_id()
    config = load_agent_config(agent_id)
    tool_cfg = config.tools.builtin_tools.get("web_search")
    choice = str(tool_cfg.config.get("provider") or "").strip().lower()
    if choice in {"", "tavily"}:
        return TavilyProvider()
    if choice == "anysearch":
        return AnySearchProvider()
    raise ValueError(...)  # 未知 provider 显式报错，不静默兜底
```

- **每 Agent 配置**：Provider 选择存在 Agent 的 Console 工具配置里（`config.tools.builtin_tools["web_search"].config.provider`），**不读环境变量**。
- 空 / `tavily` → 默认 keyless 后端；`anysearch` → 凭据后端；未知值显式抛 `ValueError`（fail-fast，避免静默路由错误）。
- 配置读取失败时静默回退到默认值 `""`（`except Exception: choice = ""`）。

---

## 9. 配置与凭据管理（app/routers/tools.py）

Console 内置工具配置字段（L97-112）：

```python
_BUILTIN_TOOL_CONFIG_FIELDS = {
    "web_search": [
        {"name": "provider", "label": "Provider", "type": "select",
         "options": ["tavily", "anysearch"], "default": "tavily"},
        {"name": "api_key", "label": "API Key (optional)", "type": "password"},
    ],
}
```

凭据 ref 推导（L115-124）：`_builtin_credential_ref(tool_name, config)` → `tool/{tool_name}/{provider}`（如 `tool/web_search/anysearch`）；**tavily 免 key，ref 返回空串**，调用方跳过凭据读写。

配置模型（`config/config.py`）：`ToolsConfig.builtin_tools: Dict[str, BuiltinToolConfig]`，`BuiltinToolConfig` 含 `name/enabled/description/icon/async_execution/config` 等字段，支持默认值补齐与浏览器工具迁移逻辑。

---

## 10. 可借鉴点（对照 web-search-plugin）

QwenPaw 实现与本插件（DSH 动态插件）的映射关系：

| 关注点 | QwenPaw（Python） | 本插件（DSH JS） | 借鉴价值 |
|---|---|---|---|
| 后端解耦 | `SearchProvider` 抽象基类 + 工厂选路 | Host 里 `search(query, opts)` 统一入口 | 已具备 |
| 默认/可选 Provider | 配置 `provider` 字段选 tavily/anysearch | 通过 `ctx.web` Provider 注册 + 工具直连 | 可参考「未知 provider 显式报错」的 fail-fast 策略 |
| API Key 管理 | 每 Agent `credentials.yaml` + mtime 缓存 | 宿主内存 state + 设置页 | 可参考「文件 mtime 缓存」做持久化优化 |
| 配额处理 | 402 自动注册新 key / 配额重试 | 仅错误文案引导 | **可借鉴**：火山 API 若也有自动发放 key / 限流语义，可加自动重试 |
| 错误反哺 LLM | 异常文本 + fallback 建议拼进返回值 | `{ok:false, error}` | 可参考：工具描述里声明 fallback 到 curl |
| 结果格式化 | `format_search_results` 编号列表 | `formatResult` 文本 | 已具备 |

**结论**：QwenPaw 的 web_search 本质是「**一个极简搜索契约 + 可插拔 Provider + 每 Agent 配置选路 + 错误反哺模型**」。本插件已覆盖等价能力（`web_search_multi` 工具 + 自动路由的火山/Tavily Provider + 设置页，且 Tavily 后端已照搬其 keyless 实现）；若要做增强，优先对齐 QwenPaw 的**配额自动重试**与**凭据 mtime 缓存持久化**两点。
