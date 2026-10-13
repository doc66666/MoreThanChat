# MoreThanChat 开发路线图

原则：先证明插件内核和回滚，再做完整聊天 UI；先让 AI 在受限范围内稳定写插件，再逐步开放能力。

## Phase 0：架构钉子（1 周）

当前进度（2026-10-10）：已完成 Windows AI 聊天与受限 AI 插件创作 MVP。可信 `pc-ui` 插件生命周期、manifest 校验、v1 Host 协议与 JSON Schema、Electron Main↔utility process 监督及崩溃恢复均已落地。Cordis Core 固定为 `3.18.1`，独立 `pc-host` 时间工具插件通过适配层运行。

模型已支持兼容 API 的流式回复、取消和失败处理，并已用真实 DeepSeek 验证插件生成、修订、执行及恢复。Key 通过 Electron Main 的 `safeStorage` 加密，Host 通过私有 RPC 获取运行时凭据；不再使用明文凭据文件。聊天模型可读取契约、创建、校验、诊断和修订受限 JSON 插件，用户确认后立即启用。支持固定文本、输入追加和 uppercase/lowercase/trim 转换。更新保存不可变版本，失败回滚后可以继续修订；取消确认不会安装或替换，停用状态在更新及重启后保留。

本机 Windows 目录版已完成聊天内生成、确认安装、执行、修订、确认更新和加密凭据恢复的模拟服务验收。CI 对 Windows/Linux 做锁定安装、类型检查、单测、构建及协议验证，并在 Windows 验证目录版、上传可分发目录。Host 与生产依赖位于 `resources/pc-host`，在 `app.asar` 之外。详情见 [阶段验收记录](stage-acceptance-2026-10-10.md)。

本阶段提前实现了 Phase 4 的受限子集；完整路线图仍保留。后续的“可用聊天内核”阶段已接入 SQLite 事务投影和诊断日志、Markdown、AI 回复重试与 Token 元数据，详见 [聊天内核阶段](chat-core-stage-2026-10-10.md)。费用金额、动态服务依赖、签名插件包及完整更新事务、任意逻辑插件、人与人的在线聊天传输和 Android Host 均待后续。目录版是未签名内测分发，正式安装器另列发布阶段。

交付：

- pnpm monorepo、统一 TypeScript/ESLint/Vitest 配置；
- `packages/protocol`：传输无关的命令/事件 envelope、schema 生成和 Electron IPC 绑定；
- `packages/plugin-manifest`：manifest 校验与权限词汇；
- `packages/runtime-cordis`：只暴露我们自己的 `Runtime` 接口；
- 生命周期契约测试：加载、依赖等待、dispose 清理、失败回滚、重复启停；
- 最小 Electron main/renderer/utility-process 三层骨架；
- preload 最小权限桥、类型化 IPC 握手、utility process 崩溃重启；
- 锁定 Electron、Cordis 与 SQLite 依赖版本，记录升级基线。

验收：同一个示例插件可以启动、贡献一个 service、卸载后零残留；utility process 被杀后 main 能拉起新实例，Renderer 重连并显示明确状态；Renderer 无法直接访问 Node API。

## Phase 1：可用聊天内核（2–3 周）

当前核心能力已完成内测实现：会话迁移/事务存储、Markdown、取消与重新生成、Token 用量、加密凭据。日志是有界诊断日志，尚不是用于跨设备同步的完整事件源；费用金额、消息分页/全文检索及真实在线传输继续迭代。

交付：

- SQLite 事件存储和会话投影；
- OpenAI-compatible `ModelProvider`，支持 DeepSeek base URL/API key；
- 流式文本、取消、错误重试、token/费用元数据；
- 基础会话列表、对话流、Markdown、设置页；
- OS 凭据库保存密钥；日志与导出自动脱敏。

验收：重启后可恢复会话；流中断不会留下伪完成消息；API key 不出现在数据库、日志或前端状态中。

## Phase 2：静态插件 SDK（2 周）

交付：

- host/UI 双半插件模板；
- `tool.registry`、`ui.slots`、设置卡片、命令与事件 API；
- 插件目录、启停、配置、权限展示和诊断页；
- SDK 合规测试包，强制 dispose 后无注册残留；
- 三个示例：时间工具、消息导出、会话侧栏卡片。

验收：不改核心代码即可安装三个示例；任意启停 100 次无重复监听器、重复 UI 和句柄泄漏。

## Phase 3：产品级热更新（2 周）

交付：

- 内容寻址插件仓库、active version 指针和安装 provenance；
- stage/activate/health-check/commit/rollback 事务；
- 插件数据命名空间和迁移事务；
- worker/utility process 崩溃隔离；
- HMR/回滚故障注入测试。

验收：在 activate、迁移、UI 装载和健康检查四个阶段分别注入失败，均恢复旧版本且无数据半迁移。

## Phase 4：AI 插件作者（3 周）

交付：

- inspect/create/validate/test/preview/install/diagnose 工具；
- 受控模板、依赖白名单与危险 API 检查；
- 一次性构建进程、mock capability host 和预览 WebView；
- 权限 diff、人工审批、自动回滚；
- AI 只能追加新 revision，不能原地修改已安装包。

验收：自然语言生成一个“天气工具 + 消息卡片”，在无授权时不能联网；授权指定域名后可预览、安装、热更新和回滚。

## Phase 5：聊天平台能力（按产品优先级）

2026-10-13 后续：桌面通知与后台阶段已实现。支持私密/静音默认通知、连续消息合并、免打扰与撤回清理、点击返回会话、可选关窗到托盘、显式退出及按身份持久设置。真实 Electron 双端验收覆盖隐藏窗口接收/ACK、不提前已读、重启恢复，以及通知/保存失败；Windows 目录版同步验收。下一优先级为本机聊天历史备份/迁移及恢复验证，再推进实时音视频与服务运营可靠性。Android 系统推送、开机自启和退出后的常驻服务尚未实现。

2026-10-13：身份加密备份/导入、隔离的本机身份空间和已登记设备的新消息同步已落地。设备独立 ACK、发送者其他设备同步、跨设备已读与撤回、离线/重启补投和设备移除进入验收。最多 8 台设备；新设备只从登记后接收新消息，尚无旧设备历史迁移或跨设备插件/草稿同步。下一优先级为系统通知与后台使用体验，再推进历史迁移、实时音视频及运营可靠性。

2026-10-12：已补齐持久发送队列、送达/已读、焦点与滚动位置对应的未读、会话草稿、置顶/免打扰、本机搜索/定位/复制，以及好友申请管理、群成员管理和管理员转让。按产品要求移除了归档：好友/群固定关系入口，删除好友或退出/解散群后保留可搜索的本机历史。SQLite 游标分页、增量写入、FTS5 trigram 检索和大于 8 MiB 的历史保存也已接入；群消息部分送达后服务器重启的独立 ACK 流程已补测。消息引用/撤回/转发阶段现已完成：来源哈希校验、引用草稿与定位、文字/附件独立转发、两分钟撤回、离线持久通知和防止迟到正文复活均已接入。下一优先级是身份备份/导入与多设备同步，之后是系统通知和实时音视频。

2026-10-11 首版已接入：公共黑名单/私服白名单、全局签名身份、同服好友与群、持久离线中继及按收件人 ACK 清除、群插件审批分发与同步通道。默认开发服务器为 localhost。UI 插槽扩展到输入框之外，文件/表情/按住语音已进入正常聊天输入区。范围、部署与测试见 [中心服务阶段](central-and-plugin-stage-2026-10-11.md)。任意可执行包沙箱、端到端加密、运营级限流/集群、Android 继续作为后续工作。

- 多账号和联系人服务；
- 端到端附件管线；
- 消息 transport 插件；
- 搜索、通知、快捷命令；
- 插件签名、商店/私有源、更新通道；
- 多端同步协议。

## Phase 6：Android 验证

先做运行时 spike，不立刻复刻 PC 插件：

- 在 Android 上验证协议客户端、事件存储与聊天 UI；
- 比较受限 JavaScript、Wasm 和声明式插件的性能/安全/Play 合规性；
- 实现两个 Android 专属示例插件；
- 完成 Play 政策与 WebView bridge 安全评审；
- 复用 AI authoring 状态机，但更换 Android 模板、静态检查和运行器。

## 第一批 issue 建议

1. 初始化 monorepo 和 CI。
2. 定义 `PluginManifestV1`。
3. 定义 Host/UI RPC 与事件 envelope。
4. 实现 `runtime-cordis` 最小适配器。
5. 编写 lifecycle/HMR rollback contract tests。
6. 建立 Electron main↔utility process 监督通道和最小 preload IPC。
7. 实现 SQLite session event store。
8. 实现 OpenAI-compatible provider。
9. 实现最小聊天流 UI。
10. 建立 threat model 与权限词汇表。
