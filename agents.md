# dsh-wolfpack —— Agent 开发与维护手册（仓库级）

> 面向后续接手开发/维护本仓库的 agent 与人类开发者。**先读本文件，再动代码。**
> 每个插件目录下有更细的插件级手册（`agents.md`），动某个插件前先读对应目录的 `agents.md`。

---

## 1. 仓库一句话

DeepSeek Harness（DSH，基于 Cordis 的 agent harness / Web GUI）的自用动态插件集合，已开源。插件以「动态 Cordis 插件」形式运行：浏览器端（`code.client`）+ 宿主端（`code.host`），纯 JS 函数体、无构建，通过 agent 会话内的 `cordis_define` / `cordis_run` 加载。

---

## 2. 目录与文件约定

```
.
├── LICENSE                 Apache-2.0
├── README.md               用户视角：项目总览、插件列表、快速开始
├── agents.md               本文档：仓库级开发/维护约定
└── <plugin>/
    ├── host.js             code.host 源码（函数体片段，非完整模块）
    ├── client.js           code.client 源码（函数体片段，非完整模块）
    ├── README.md           该插件用户功能说明
    ├── agents.md           该插件开发维护手册（硬约束、模块详解、测试清单）
    └── CODE_REVIEW.md      该插件 code review 记录 —— **本地文档，一律不入库**
```

**规则**：
- 每个插件目录内至少包含 `host.js` / `client.js` / `README.md` / `agents.md` 四个文件。
- 插件级 `agents.md` 是动该插件代码前必读的交接文档（包含运行环境硬约束、核心模块、测试清单、变更流程）。
- **`CODE_REVIEW.md` 是本地开发文档，由根 `.gitignore` 忽略，永远不要 `git add` 它。**

---

## 3. 代码与文档一致性（重要教训）

- 动态插件的"运行版本"来自 `cordis_define` 提交的代码，磁盘源文件（`host.js` / `client.js`）是权威备份。
- **任何代码改动必须同时**：改磁盘源文件 + 通过 `cordis_define` 提交新 Package（不可变，勿覆盖旧版本）+ `cordis_run mode:"update"` 热更新。只改一处会导致运行版本与磁盘不一致（历史教训，见 `index-tts-plugin` review 记录）。
- 改动用户可见行为时同步更新插件 `README.md`；改动本文档描述的行为时同步更新本文档。

---

## 4. 动态插件运行环境硬约束（写代码前必读）

两端都是**纯 JS 函数体**（`return { apply(ctx) {...} }`），无构建、无模块系统：

| 约束 | 说明 |
|---|---|
| ❌ 无 JSX / TypeScript / import / require | Client React 一律 `React.createElement(...)`；Host 无模块导入 |
| ❌ `fetch` 被禁用（两端） | 一律用浏览器 `XMLHttpRequest`（Client 端） |
| ❌ `setTimeout/setInterval` 被禁用 | 用 `inject: ['timer']` + `ctx.timeout/ctx.interval`（两端都有 timer 服务） |
| ✅ 插件 `apply` 不能返回普通对象 | 返回 `undefined` / disposer / promise / 可迭代；返回 `{}` 会抛 `Invalid effect` |
| ✅ `harness.handle` 清理 | runner 会把 disposer 记入 run 生命周期，stop/update/失败统一回收，插件无需手动挂 effect |
| ⚠️ 动态插件进程级 | **DSH 进程重启会丢失插件与宿主内存配置**（工作区文件不丢），需用 `cordis_define` 重新加载 |

具体到某个插件时，以其插件级 `agents.md` 的约束为准。

---

## 5. 变更流程

1. 先读仓库根 `agents.md` + 目标插件目录的 `agents.md`。
2. 改磁盘源文件（`host.js` / `client.js`），`node --check` 语法自检。
3. `cordis_define` 提交新 Package（`kind: "existing"`，同 `pluginId`）→ `cordis_run mode:"update"`。
4. 同步插件 `README.md` 与（本地）`CODE_REVIEW.md`；若涉及仓库级约定则同步本文档。
5. 按插件级 `agents.md` 的测试清单回归。
6. 提交信息用中文或英文均可，说明清楚改动内容。

---

## 6. 测试与质量

- 每个插件 `agents.md` 有「测试清单」章节，改任何模块后按清单回归。
- 语法自检示例（Windows PowerShell）：

```powershell
$body = Get-Content client.js -Raw
Set-Content "$env:TEMP\c.js" -Value "(`n$body`n)" -Encoding UTF8
node --check "$env:TEMP\c.js"
```

- 真实 API 路径（上传/合成/播放等）依赖有效 API Key，需在 WebUI 设置页人工验证。

---

## 7. 本机环境备注

- 远程仓库：`https://github.com/xiaoka76/dsh-wolfpack.git`（HTTPS；本仓库 `.git/config` 已设 `http.sslBackend=openssl`，因本机 schannel 不可用）。
- 全局 git 身份：`liyuang` / `liyuang_2007@icloud.com`。
- 当前分支：`main`，跟踪 `origin/main`。
