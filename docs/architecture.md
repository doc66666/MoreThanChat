# MoreThanChat 架构与安全边界

状态：提案，供 PC MVP 实现使用；Android 接口已预留，但两端插件包互不兼容。

## 目标

MoreThanChat 是一个“一切皆插件”的聊天宿主：核心只负责启动、生命周期、权限、事件日志和插件管理；账号、模型、消息协议、存储、搜索、UI 面板与自动化均由插件提供。AI 可以生成插件，但任何生成代码都必须先经过校验、隔离预览和用户审批，再进入可回滚的热更新事务。

## 选型

PC 第一版建议使用：

- **桌面壳：Electron**。Windows 优先，随后支持 macOS/Linux；采用 Electron 自带的固定 Node/Chromium 版本，不依赖用户机器上的运行时。
- **前端：React + TypeScript + Vite**。UI 插件运行在受控的 Renderer realm，通过 slot 注册界面。
- **PC host：Electron utility process + Cordis**。Node 负责 AI 流式协议、插件编译/测试、聊天存储与 PC host 插件；Electron main 只负责窗口、应用生命周期、协议入口和进程监督。
- **协议：类型化 IPC + 版本化事件流**。Renderer、utility process 与未来 Android host 使用同一套 schema，但各自采用平台合适的传输。
- **本地存储：SQLite + append-only session events**。派生视图可以重建，密钥进入系统凭据库而不是数据库正文。

选择 Electron 的首要原因是稳定性：Cordis Loader/HMR 与 Harness host 都以 Node 为主要运行环境，Electron 可以直接承载它们，避免 Rust↔Node sidecar、额外运行时分发和跨语言故障面。Android 本来就使用独立插件产物，因此不以牺牲 PC 稳定性为代价强求共享宿主。

## 稳定性基线

- Electron、Cordis、SQLite 驱动和构建工具全部锁定精确版本；只通过依赖升级 PR 更新，不使用浮动范围。
- Cordis 经过 `runtime-cordis` 适配层使用，并冻结一个已审计快照。升级必须先通过生命周期、HMR、回滚和 Windows 文件占用测试。
- Electron main 不运行第三方插件和模型循环；这些工作进入可重启的 utility process 或独立插件进程。
- Renderer 开启 `contextIsolation` 与 sandbox，关闭 `nodeIntegration`；preload 只暴露生成的最小 IPC API。
- Core UI shell 不允许热替换。开发态 HMR 只服务开发；产品态插件升级必须走 stage/health-check/commit/rollback 事务。
- 首发只承诺 Windows，先固定一套可重复构建和自动更新链路，再扩展 macOS/Linux。

## 分层

```text
apps/desktop (Electron)           apps/android (后续)
        │ typed IPC / events             │ 同一协议族
        ▼                                ▼
packages/protocol  ◄─────────────  Android Host Adapter
        │
        ▼
apps/pc-host (Electron utility process)
        │
        ├─ packages/runtime-cordis   生命周期与依赖适配
        ├─ packages/chat-domain      会话/消息/联系人领域
        ├─ packages/ai-runtime       模型、工具与 agent loop
        ├─ packages/plugin-manager   安装/签名/权限/版本/回滚
        └─ packages/storage-sqlite   事件与投影
```

核心不直接实现业务能力，只声明以下稳定服务：

| Service | 责任 |
|---|---|
| `chat.transport` | 收发某一种消息协议 |
| `chat.store` | 会话事件、附件元数据、投影查询 |
| `identity` | 账号、联系人和设备身份 |
| `model.provider` | OpenAI-compatible/DeepSeek/本地模型流式调用 |
| `agent.runtime` | 提示词、工具调用、取消、token/费用统计 |
| `tool.registry` | 工具 schema、权限声明和执行流水线 |
| `ui.slots` | 侧边栏、会话头、消息节点、输入区、设置页等 keyed slot |
| `capability.broker` | 文件、网络、剪贴板、通知、shell 等授权能力 |
| `plugin.catalog` | 插件发现、版本、安装、启停和诊断 |
| `sync` | 多端同步；首版可以为空实现 |

## 插件包与 ABI

PC 与 Android 使用相同的元数据概念，但使用不同的 `target` 和产物：

```json
{
  "manifestVersion": 1,
  "id": "com.example.weather-card",
  "version": "0.1.0",
  "targets": ["pc-host", "pc-ui"],
  "engine": { "moreThanChat": "^0.1" },
  "entrypoints": {
    "pc-host": "dist/host.js",
    "pc-ui": "dist/ui.js"
  },
  "permissions": ["network:https://api.example.com"],
  "services": {
    "requires": ["tool.registry", "ui.slots"],
    "provides": []
  }
}
```

规则：

- `pc-host`、`pc-ui`、`android-runtime`、`android-ui` 是不同 target，不允许把一个平台产物直接装到另一平台。
- 插件只能通过 capability broker 访问系统能力；manifest 权限是上限，运行时用户授权可以更窄。
- 所有公共调用都经过带版本的 schema；禁止插件依赖 host 内部对象、文件路径或 Cordis Fiber。
- UI 插件只注册声明过的 keyed slots，不能替换根页面或直接获得 Electron IPC/Node 全集。
- 插件版本不可变，以内容哈希寻址；安装记录只切换 active version 指针。

## 热更新事务

“热更新”不是覆盖文件，而是一个可回滚状态机：

```text
生成/下载 → 静态检查 → 权限差异 → 隔离构建与测试 → 用户审批
    → stage 新版本 → snapshot 旧状态 → stop 旧 Fiber
    → start 新 Fiber → 健康检查 → commit 指针
                          └失败→dispose 新版→恢复旧版
```

每个插件必须实现或接受：

- `activate(ctx, config)`：只注册 effect，不在模块顶层产生副作用；
- `deactivate`：通常由 effect 自动合成；有序异步清理放进单个 disposer；
- `healthCheck`：验证关键服务和 UI slot；
- 可选 `migrate(fromVersion, tx)`：只操作自己的命名空间，数据库迁移与 active 指针在同一事务提交；
- 可选 `serializeState/restoreState`：只用于短暂 UI 状态，不替代持久事件。

Cordis HMR 只用于开发态源码反馈。产品态更新由 `plugin-manager` 驱动上述事务，不依赖 Node module cache 的隐式行为。

## AI 写插件流程

AI 不是直接文件编辑器，而是插件工程流水线的一个参与者：

1. `inspect_contracts`：读取当前 ABI、可用服务、slots、示例和权限政策。
2. `create_draft`：生成 manifest、源码、测试与说明；草稿处于隔离 workspace。
3. `validate_draft`：schema、lint、类型检查、依赖白名单、危险 API 和权限一致性检查。
4. `test_draft`：无网络单测 + mock host 集成测试 + UI 截图/交互测试。
5. `preview_draft`：在独立 worker/进程与预览 WebView 中运行，展示将新增的权限。
6. 用户选择“仅本次运行”“安装”或“拒绝”。
7. `install_draft`：签名/记录 provenance，进入热更新事务。
8. 崩溃或健康检查失败自动回滚；AI 读取结构化诊断后只能创建新版本，不能修改已安装版本。

首版只允许 AI 生成受限工具插件和 UI 卡片插件；能够执行 shell、访问任意文件或加载原生库的插件不进入自动安装路径。

## PC 安全模型

至少划分四个信任级别：

| 级别 | 代码来源 | 运行位置 | 默认能力 |
|---|---|---|---|
| Core | 官方随应用签名 | 主 host | 完整但审计 |
| Trusted | 用户明确安装/签名 | 独立 Node worker/utility process | manifest 授权能力 |
| AI Preview | AI 临时生成 | 一次性受限进程 + 预览 WebView | 无 shell、无任意文件、网络默认关闭 |
| Remote Content | 消息 HTML/Markdown | 严格渲染器 | 无脚本 |

关键约束：

- 不把 `node:vm`、WebView 或 TypeScript 类型当作恶意代码安全边界。
- PC host 插件至少进独立进程，使用 OS 级资源限制、超时和 capability RPC；高风险插件再接 Windows AppContainer/低完整性进程等平台沙箱。
- API key 只由凭据服务按 provider 使用，永不交给插件；插件只能请求一次模型调用。
- 网络按 origin allowlist 代理；文件使用用户选择的目录句柄或虚拟路径，不暴露真实任意路径。
- 每次能力调用写审计事件，支持按插件一键撤权和停止。

## Android 预留接口

Android 插件与 PC 插件分开发布。建议 Android host 使用 Kotlin 层的 capability broker，插件逻辑使用受限 JavaScript/Wasm 解释器或声明式工作流，UI 使用受控组件 schema；不要下载 dex/JAR/so，也不要给不可信 WebView JavaScript 暴露通用 `addJavascriptInterface`。

共享内容仅包括：

- manifest 基础字段、插件 id、语义版本、签名和权限词汇；
- `packages/protocol` 生成出的 JSON Schema/事件类型；
- 聊天领域事件格式与同步协议；
- AI 草稿/测试/审批/安装状态机。

Android 端在开发前必须再次做 Google Play 政策评审。即使解释执行 JavaScript 具有例外，动态内容仍不得促成政策违规，并需做来源信任、签名、完整性校验和最小权限。

## 数据与事件

会话是追加式事件流，典型事件包括 `conversation.created`、`message.user`、`message.assistant.delta`、`message.assistant.completed`、`tool.called`、`tool.result`、`plugin.installed`、`plugin.activated`、`plugin.rolled_back`。UI 查询的是投影表，日志是真源。

原则：凡是会改变模型可见上下文、同步结果或审计结论的事实，必须进入事件流；纯动画和面板展开状态不进入。

## 需要尽早冻结的契约

1. `PluginManifestV1` 与 target/permission 命名。
2. Host↔UI 传输无关的消息 envelope、取消与流式事件语义；Electron IPC 和未来 Android RPC 都从它生成。
3. Conversation event union 与 schema version。
4. Service registry 的 id、scope、版本协商和错误码。
5. 热更新事务与回滚错误模型。
6. AI plugin authoring 的工具协议和审批回执。
