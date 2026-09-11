# 动态插件 Host 半部沙箱能力全解

> 面向要写 `code.host` 的开发者。先读本文，再动代码。
> 本文结论来自对 DSH 部署源码（`packages/extensions/cordis-host-runner/src/sandbox.ts` / `guard.ts`）与运行时 `Builtin.listBuiltins` 的实测核查，写于 web-search-plugin（前 volc-search-plugin）开发期间。
> 若与 DSH 升级后的行为冲突，以 `cordis_inspect_query`（Host `Builtin` / `Service`）的实时结果为准。

---

## 1. 一句话

动态插件的 **Host 半部不是普通 Node.js**，而是一个**受限 VM 沙箱**：标准 JS 语法全有，但**只显式提供 7 个全局**，且网络 / 文件 / 进程能力都要靠 `inject` 声明 Cordis 服务通过 `ctx` 获取——不能依赖语言内置的 `fetch` / `require` / 定时器。

> Client 半部（浏览器）是另一套环境：有 `XMLHttpRequest / React / styles / host / ctx.get('slots')` 等，本文不展开（见各插件 `agents.md`）。

---

## 2. 可用全局一览（全部实测确认）

| 全局 | 类型 | 作用与注意 |
|------|------|-----------|
| `ctx` | Proxy 门面 | 受限 Cordis 上下文。**详见 §3** |
| `harness` | 对象 | 注册包私有 RPC / 模型工具。**详见 §4** |
| `console` | 对象 | `console.log(...)` / `console.error(...)`，输出带插件包 ID 标签（如 `[dyn-1]`） |
| `btoa(value)` | 函数 | **UTF-8 文本 → base64**。⚠️ 不是浏览器 Latin-1 语义，中文安全；**不能传二进制** |
| `atob(value)` | 函数 | base64 → **UTF-8 文本**（同上，非二进制） |
| `TextEncoder` | 构造器 | `new TextEncoder()`，标准 UTF-8 编码 |
| `TextDecoder` | 构造器 | `new TextDecoder(label?)`，标准解码（沙箱无 `Buffer`，转字节用它） |

另：`Object/Array/Function/Error/Promise/RegExp/Date/Map/Set` 等标准内置存在，并做了**双 realm `instanceof` 修补**（跨 VM 边界判断类型不出错）。

---

## 3. `ctx` —— 受限 Cordis 上下文（最核心）

`ctx` 是一个 Proxy 门面，**只放行以下操作**，其余一律拒绝（读它内部会得到教学错误）。

### 3.1 服务访问的两条规则（最常踩坑）

| 方式 | 语法 | 何时用 |
|------|------|--------|
| **可选查找** | `ctx.get('web')` | 服务可能不存在；拿到后判空（`if (web === undefined) return`） |
| **硬依赖（inject）** | 插件返回对象上声明 `inject: ['subprocess']`，然后 `ctx.subprocess` | 服务是必须的，且插件应等待它出现 |

- **直接属性访问（`ctx.xxx`）必须先在 `inject` 声明**，否则抛 `service "xxx" is not injected. Declare it: inject: ['xxx', …]`。
- `ctx.get()` 不需要 inject；属性访问必须 inject。
- 服务方法**返回值若是 Cordis Context 会被拒绝**（`denyContext`）——防逃逸，按「返回数据」设计。
- `ctx` 只读：`set` 被拦截（`sandbox ctx is read-only`）。

### 3.2 可用动词（方法）

| 动词 | 作用 |
|------|------|
| `ctx.on(name, listener)` / `ctx.once(...)` | 事件监听，返回 disposer |
| `ctx.provide(name, value)` | 向其他包提供服务 |
| `ctx.effect(callback, label?)` | 注册 fiber 级副作用，stop/update 自动回收 |
| `ctx.timeout / ctx.interval / throttle / debounce` | 定时器/节流/防抖（**需 `inject: ['timer']`**，见 §6） |
| `ctx.tools.register / schemas / get` | 工具注册门面：`register`（标记校验）、`schemas()`、`get(name)` 只返回 **schema 视图，不可调用**（防绕过工具运行时） |

> 框架内部（`root / fiber / registry / extend / plugin / …`）一律不暴露。

---

## 4. `harness` —— 与宿主交互的桥梁

| 方法 | 作用 | Client 对应 |
|------|------|------------|
| `harness.handle(method, handler)` | 注册**包私有 RPC**，handler 收 JSON 参数、返 JSON 值 | `host.call(method, args)` |
| `harness.defineTool(definition)` | 定义**模型可见工具**，返回校验过的 ToolDefinition | — |
| `harness.registerTool(ctx, tool)` | 把 defineTool 产物注册进工具表，agent 下轮即可调用 | — |

- RPC 方向是 **Client→Host**（`host.call` 调 `harness.handle`），**没有反向 Host→Client 同步通道**（这是 web-search-plugin 决定不在浏览器端做网络的原因之一）。
- `harness.handle` / `harness.registerTool` 的 disposer 由 runner 统一回收，插件无需手动挂 effect。

### defineTool 参数 DSL 关键约束

- `parameters` 是扁平属性映射，属性允许 `type / enum / const / required / description / title / default / examples`；`required` 在属性上必须为 `true`。
- 合法类型：`string / number / integer / boolean / null / object / array / json`。
- `output` 必填：`{ schema, render(_args, value) }`；`render` 返回内容块数组（如 `[{ type: 'text', text: value }]`）。
- `execute` 返回 JSON 兼容值（会跨 realm 克隆）；模型看到的是 execute 的返回值，render 只影响 UI 卡片。

### defineTool 能力边界（2026-09-11 实测补充）

- `harness.defineTool` 是 dsh-tools `defineTool`（`packages/core/tools/src/schema.ts`）的**完整透传**（`guard.ts` 的 `sandboxDefineTool` 把 `...options` 原样传入）：`timeoutMs` / `isConcurrencySafe` / `presentCall` / `presentResult` / `output.presentationMeta` **动态插件全部支持**——静态包 `tool-web` 的注册契约（同名工具、同输出形状、同卡片 meta）可被动态插件 1:1 复刻。
- **作用域遮蔽**：tool-web 等 preset 工具注册在 **session 作用域层**，动态插件 `harness.registerTool` 落在 **global 层**（`cordis-dynamic` 组无 scope 标签）。scoped 会 shadow global，**同层重名才抛错**。因此要让动态插件注册的同名工具（如 `web_search`）生效，必须先关闭/移除 preset 里注册同名工具的静态行（如 tool-web `search: false`）。
- 动态 Host 沙箱**无 DOM / 无 `require`**（可用全局仅 `ctx/harness/console/btoa/atob/TextEncoder/TextDecoder`）：依赖 DOM 解析的工具逻辑（如 tool-web `fetch.ts` 的 HTML→Markdown 转换）**无法在动态插件内移植**，只能 subprocess 退化实现或固化为静态插件。

参考：`packages/extensions/cordis-host-runner/src/guard.ts`；可运行示例见 `packages/extensions/cordis-host-runner/tests/helpers.ts`（REVERSE_TOOL_CODE）。

---

## 5. 被「故意禁用」的 API（调用即抛错并提示替代）

| 被禁 | 提示的替代 |
|------|-----------|
| `require` | 用 `ctx` 上的 Cordis 服务，如 `inject: ['fs'] / ['web'] / ['bash']` |
| `fetch` | `inject: ['web']` → `ctx.web`（见 §7：其实不能做任意 API POST） |
| `setTimeout / setInterval / setImmediate / clear*` | `inject: ['timer']` + `ctx.timeout / ctx.interval` |
| `process` / `Buffer` | 是 `undefined`（`typeof process` 探测安全） |

来源：`sandbox.ts` 的 `NODE_API_REDIRECTS` + `nodeApiTraps()`。

---

## 6. 定时器

- **全局 `setTimeout` 禁用**；用 `inject: ['timer']` + `ctx.timeout / ctx.interval`。
- 这些调用是 fiber 效果，stop/update 自动清理，无需手动挂 effect。
- 浏览器端（Client）同样规则。

```js
return {
  inject: ['timer'],
  apply(ctx) {
    ctx.timeout(() => console.log('done'), 300)
  },
}
```

---

## 7. 网络访问路径（web-search-plugin 的核心调研结论）

**这是最容易误解的地方**：动态 Host 没有 `fetch`，那"调外部 API"到底走哪条路？实测结论如下。

### 7.1 三条路的真相

| 路径 | 能不能做「任意 API POST」 | 说明 |
|------|------------------------|------|
| 全局 `fetch` | ❌ | 被 trap，调用即抛错 |
| `ctx.web.fetch(url)` | ❌ | 语义是「抓取网页返回 html/text 内容」走 WebFetchProvider，不能指定 method/headers/body |
| `ctx.web.search()` | ❌（作为手段） | 它**自己就是要注册 provider 才有**的能力，是目标不是手段 |
| `ctx.subprocess.spawn(...)` | ✅ | 拉起外部进程（推荐用 DSH 自身 Node 运行时，见 §7.2） |
| Client 端 `XMLHttpRequest` | ✅（浏览器内） | 但模型工具 execute 跑在 Host，**Host 无法等待浏览器异步返回**，对模型工具不成立 |

### 7.2 结论

动态 Host 要调外部 API，**唯一可行路径是 `subprocess` 服务拉起外部进程**（或 `shell` 服务跑命令）。**推荐用 DSH 自身所在的 Node 运行时**（`ctx.subprocess.resolveExecutable('node')` + `node -e <内联脚本>`，用 Node 内置 `https`/`http` 模块）——这是 web-search-plugin（前 volc-search-plugin）的做法：Node 是 DSH 的运行基础必然存在，自带 OpenSSL（不受本机 curl 的 TLS/schannel 问题影响），且比依赖系统 curl / Python 更干净。内联脚本运行在独立子进程里，`require/process/Buffer` 均可用（不受宿主沙箱限制）。

### 7.3 凭证传递陷阱（重要）

- `subprocess` 子进程环境会 **scrub 掉 `KEY / PASSWORD / SECRET / TOKEN` 形变量**（`SENSITIVE_ENV_PATTERN`），所以：
  - ❌ 不要指望 `WEB_SEARCH_API_KEY` 这类 env 能隐式传给子进程；
  - ✅ 显式传：CLI 的 `--api-key` 参数，或 `spawn` spec 的 `env` 字段（显式条目在 scrub 之后合并，能存活）。
- 子进程 stdout / stderr 用 collect 模式：`stdio: { stdout: { maxBytes: N }, stderr: { maxBytes: N } }`，`await handle.done` 后 `handle.collected.stdout.readFrom(0).text` 读取。

```js
const handle = ctx.subprocess.spawn({
  argv: [pythonExe, scriptPath, query, '--api-key', apiKey],
  cwd: scriptDir(),
  stdio: {
    stdin: 'ignore',
    stdout: { maxBytes: 300000 },
    stderr: { maxBytes: 50000 },
  },
  graceMs: 30000,
})
const outcome = await handle.done
const out = handle.collected.stdout.readFrom(0).text
```

参考：`packages/subprocess/subprocess/src/index.ts`（`scrubbedParentEnv`）、`packages/subprocess/subprocess-local/src/spawn.ts`。

---

## 8. 能力 → 服务速查表

写 `code.host` 时「想要什么能力用什么」：

| 想做 | 用 |
|------|-----|
| 调外部 API / 联网 | 优先 `ctx.subprocess` 拉起 **DSH 自身 Node 运行时**（`resolveExecutable('node')` + `node -e` + 内置 `https`，见 §7.2）；网页抓取可用 `ctx.web.fetch` |
| 执行 shell 命令 | `inject: ['shell']` → `ctx.shell.run(...)` |
| 进程管理 | `inject: ['subprocess']` → `ctx.subprocess.spawn` |
| 读写文件 | `inject: ['fs']` → `ctx.fs.readText / writeText / editText / listDir / stat` |
| 注册模型工具 | `harness.defineTool` + `harness.registerTool` |
| 给 Client 提供数据 | `harness.handle`（Client 用 `host.call` 调） |
| 定时任务 | `inject: ['timer']` + `ctx.timeout / ctx.interval` |
| 事件订阅 | `ctx.on(...)` |
| 编码转换 | `btoa / atob`、`TextEncoder / TextDecoder` |

> 完整服务目录以运行时 `cordis_inspect_query`（Host `Service.listService`）为准；新插件若发现未列入上表的新能力，回填到本文。

---

## 9. 调试

- 宿主失败诊断：`cordis_inspect_self(pluginId, packageId)` 读源码与 message/stack。
- 常见错误：`Invalid effect` = apply 返回了普通对象（应返回 `undefined` / disposer / promise / 可迭代）；`service "x" is not declared` = 用 `ctx.x` 没声明 inject；`cannot get property "timer" without inject` = 定时器没声明。
- 浏览器端 DevTools 按 `[dyn-N]` 标签过滤插件日志。
