# 可用聊天内核阶段（2026-10-10）

本阶段在已有 AI 插件创作 MVP 上实现可靠的本地会话存储、Markdown、失败回复重试和 Token 展示，保持原有聊天/插件 IPC 接口。没有使用真实模型额度。

## 存储与迁移

Main 持有 `ChatStore`，使用随 Electron 43.5.1 的 Node 运行时提供的 `node:sqlite`，无需安装另一个原生驱动。固定开发 Node 为 24.12.0，Electron 运行时已实测支持此 API；该 API 在当前 Node 版本仍标为 experimental，升级运行时必须重跑数据库和目录版验收。参考 [Node SQLite 文档](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)。

`userData/chat.sqlite` 包含 `chat_meta`、`conversations`、`messages` 和 `chat_events`。每次保存通过一个 `BEGIN IMMEDIATE` 事务提交会话/消息投影与变更日志，使用 WAL 和 FULL 同步。未变化的消息不重复写入；流式变更只在日志中记录新增文本，避免反复复制全文。

旧 `chat-state.json` 只在数据库尚无会话时导入。成功提交后保留 `.migrated` 备份，已有备份不覆盖。无效 JSON、非法身份和未来数据库版本会明确报错，不用空会话覆盖原数据。主进程持有单实例锁，避免同一用户目录出现两个写入者。

当前内测仍通过快照 IPC 保存，单份状态上限 8 MiB。日志仅保留最近 10000 条诊断事件，投影保留所有当前会话消息；不能宣称日志能够完整重建全部历史。分页、全文检索、增量存储 API 和用于同步的完整事件源属于下一步。

界面以短间隔持续保存，关闭窗口前另外确认最新状态已提交。明确保存失败时保持窗口打开；未收到保存确认时提示用户选择是否退出。中断的生成回复恢复为取消，中断的发送恢复为失败。字段和常见 Key/Bearer 文字在投影及诊断日志写入前脱敏；系统加密的模型凭据独立存储。

## Markdown 与重试

AI/对端消息支持标题、列表、引用、代码块、行内代码、GFM 表格及删除线。自发消息保持原文。使用 `react-markdown 10.1.0` 和 `remark-gfm 4.0.1`，跳过原始 HTML，不执行脚本；链接只允许无内嵌凭据的 HTTP(S)，由系统浏览器打开。远程图片显示占位文字，不自动发出请求。参考 [react-markdown 的安全说明](https://github.com/remarkjs/react-markdown#security)。

最近一次失败或取消的 AI 回复提供“重新生成”。重试保留原问题与失败记录，创建带 `replyToId`/`retryOfId` 的新回复，并标记旧回复已重试。模型上下文只包含已完成内容和原问题一次，排除失败、取消和流式半截回复。生成中不能重复提交；双击重试也只产生一条新请求。为避免隐式改写后续上下文，仅允许重试当前最后一个问题。

## Token 用量

兼容提供方请求 SSE usage，解析 `prompt_tokens`、`completion_tokens` 和 `total_tokens`；JSON 回应同样支持。工具循环各轮报告的计数相加，随 `model.chat.completed.usage` 进入消息和 SQLite，显示总 Token，悬停可查看输入、输出及报告请求数。

未报告的用量不估算；只有部分工具请求报告时明确标为“部分”。这里统计的是完成回复中接口返回的 Token，不代表全部账户账单或已取消/失败请求的收费。尚未配置价格规则，因此不显示虚构金额。Host 协议和 Android JSON Schema 均增加可选 usage 字段，旧无 usage 事件仍可读取。

## 验收

- 类型检查、112 个单测及生产构建通过。
- 数据库测试覆盖原有数据迁移/备份、无效数据保留、故障注入后的投影与事件共同回滚、重复保存去重和脱敏。
- 模型测试覆盖 SSE/JSON 用量解析、异常计数拒绝、多轮累计与部分报告。
- `verify:chat-ui` 使用本地模拟服务，通过真实设置页和聊天界面验证迁移、Markdown、连接提前结束、重试、取消、Token 保存、退出保存及重启恢复。
- 现有 `verify:ai-ui` 已切换为读取 SQLite，继续验证 AI 插件生成、确认、热更新、停用状态与加密凭据恢复。
- Windows CI 执行开发版及 unpacked 目录版的上述两套验收，并上传应用目录和截图。Linux 验证构建、类型、单测与协议；不宣称 Linux 桌面 UI 已验收。

开发命令：`pnpm verify:chat-ui`。目录版先运行 `pnpm package:dir`，再设置 `MTC_TEST_PACKAGED_EXE` 指向生成的 `MoreThanChat.exe` 并运行 `node scripts/verify-chat-core-ui.mjs`。

SQLite 存储、Markdown、Token 及加密凭据可以继续服务后续受控插件 SDK。真实联系人联网聊天、任意 JS/TS 插件、附件、费用金额、Android Host 与签名安装器未纳入本阶段。
