# MoreThanChat 开发路线图

原则：先证明插件内核和回滚，再做完整聊天 UI；先让 AI 在受限范围内稳定写插件，再逐步开放能力。

## Phase 0：架构钉子（1 周）

当前进度（2026-10-09）：可信 `pc-ui` 插件生命周期、manifest 基础校验、v1 Host 协议与 JSON Schema、Electron Main↔utility process 监督与崩溃恢复已完成。独立 `pc-host` 时间工具插件通过 `runtime-cordis` 运行。Host 已能保存 OpenAI 兼容 / DeepSeek 的 Base URL、模型名和 API Key，并在 Host 进程内流式生成、取消和报告失败；中断回复不会记为正常完成。没有真实密钥时走模拟提供方，不代表线上 API 已实测。插件草稿已能 inspect、create、validate、diagnose。用户确认后可安装声明式文本工具，安装后立即可用、可停用，并在 Host 重启后恢复。任意草稿源码不会执行。保存失败会撤回本次安装。不可变版本、失败的版本切换回滚和 AI 通过工具写草稿仍未完成。SQLite 事件存储、费用元数据和 OS 凭据库仍未接入，当前密钥放在 Host 私有文件。Cordis Core 固定为 `3.18.1`。动态服务提供/撤销、依赖自动等待和安装包 `extraResources` 路径验证仍在后续。

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
