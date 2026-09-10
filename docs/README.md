# dsh-wolfpack 开发文档（docs）

面向后续接手开发/维护本仓库的 agent 与人类开发者。仓库级约定见根目录 `agents.md`；本文档目录存放**跨插件共享的运行时调研结论**，是动插件代码前的「环境底图」。

## 文档列表

| 文档 | 内容 | 谁该读 |
|------|------|--------|
| [dynamic-plugin-host-sandbox.md](./dynamic-plugin-host-sandbox.md) | 动态插件 **Host 半部沙箱能力全解**：可用全局、`ctx` 门面规则、禁用 API 与替代、`harness` 用法、能力→服务映射、网络访问路径、凭证传递陷阱 | 任何要写 `code.host` 的开发者，写网络/文件/进程能力前必读 |

## 约定

- 文档中的「源码位置」均指 DSH 部署 checkout（`C:\Users\liyua\project\deepseek-harness\`）下的相对路径，用于自行核实；本仓库不复制 DSH 源码。
- 结论标注「实测 / 源码确认」，与代码行为一致优先于文档措辞；若与 DSH 升级后的行为冲突，以 `cordis_inspect_query` 的实时结果为准。
- 新插件若有跨插件共享的新环境发现（新服务、新限制、新坑），优先沉淀到本文档目录，而不是只写进单个插件的 `agents.md`。
