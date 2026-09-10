# dsh-wolfpack

我在 **DeepSeek Harness**（DSH，一个基于 Cordis 的 agent harness / Web GUI）上自用的动态插件集合，现已开源。

每个插件以「动态 Cordis 插件」形式运行：浏览器端（`code.client`）+ 宿主端（`code.host`），纯 JS 函数体、无构建。插件面向 DSH Web GUI 的日常使用，代码开源供参考与自取。

## 插件列表

| 插件 | 说明 |
|------|------|
| [index-tts-plugin](./index-tts-plugin/) | **IndexTTS-2 语音朗读**：在每条 agent 回复末尾加喇叭按钮，把回复正文（text 块，不含思考/工具）用优云智算 IndexTTS-2 API 合成语音并朗读；含文本过滤、渐增分段、并发流水线、段间预载、浏览器音频缓存、音色源文件存档与过期自动续期。 |

## 快速开始

DSH 动态插件通过 agent 会话内的 `cordis_define` / `cordis_run` 加载（每个插件目录下有各自的说明）：

1. `cordis_define`：`kind: "new"`（或更新已有时 `{ kind: "existing", pluginId }`），`code.host` = 插件目录 `host.js` 的函数体内容，`code.client` = `client.js` 的函数体内容。
2. `cordis_run`：首次 `mode: "run"`，后续更新 `mode: "update"`；Client 半部需在 WebUI 批准。
3. 具体配置与使用步骤见各插件目录内的 `README.md`。

> 动态插件随 DSH 进程重启而消失（需重新加载），宿主内配置保存在内存中不持久化。

## 目录结构

```
.
├── LICENSE                 Apache-2.0
├── README.md               本文件
├── agents.md               仓库级 Agent 开发与维护手册
└── index-tts-plugin/       IndexTTS-2 语音朗读插件
    ├── host.js             code.host 源码（配置存储）
    ├── client.js           code.client 源码（全部功能）
    ├── README.md           用户功能说明
    └── agents.md           插件级开发维护手册
```

## 文档约定

- 仓库根 `README.md`：项目总览。
- 仓库根 `agents.md`：面向后续接手开发/维护的 agent 的仓库级约定。
- 每个插件目录：`README.md`（用户视角）+ `agents.md`（agent/开发者视角）。
- 各插件的 code review 记录（`CODE_REVIEW.md`）为本地开发文档，按 `.gitignore` 约定一律不入库。

## 许可

[Apache License 2.0](./LICENSE)
