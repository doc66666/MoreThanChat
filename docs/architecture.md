# MoreThanChat 架构与安全边界

状态：提案，供 PC MVP 实现使用；Android 接口已预留，但两端插件包互不兼容。

2026-10-11 实现补充：中心服务、同服好友/群聊、离线中继、群插件审批及通用 UI 插槽已接入。`packages/central-protocol` 是纯数据协议，Android 后续复用认证和中继接口，保持自己的 UI/插件运行器。插件不仅贡献输入框动作；`ui.slots` 和经过群审批的 `chat.network` 是新的能力边界。见 [实现与部署](central-and-plugin-stage-2026-10-11.md)。

## 目标

MoreThanChat 是一个“一切皆插件”的聊天宿主：核心只负责启动、生命周期、权限、事件日志和插件管理；账号、模型、消息协议、存储、搜索、UI 面板与自动化均由插件提供。AI 可以生成插件，但任何生成代码都必须先经过校验、隔离预览和用户审批，再进入可回滚的热更新事务。

## 选型

PC 第一版建议使用：

- **桌面壳：Electron**。Windows 优先，随后支持 macOS/Linux；采用 Electron 自带的固定 Node/Chromium 版本，不依赖用户机器上的运行时。
- **前端：React + TypeScript + Vite**。UI 插件运行在受控的 Renderer realm，通过 slot 注册界面。
- **PC host：Electron utility process + Cordis**。独立进程负责 AI 流式协议与 PC host 插件；Electron Main 负责窗口、生命周期、协议入口、进程监督、系统加密凭据及本机 SQLite 连接。Renderer 通过窄 IPC 接口访问存储。
- **协议：类型化 IPC + 版本化事件流**。Renderer、utility process 与未来 Android host 使用同一套 schema，但各自采用平台合适的传输。
- **本地存储：SQLite 会话/消息投影 + 事务变更日志**。当前日志只保留最近 10000 条诊断事件，完整当前消息由投影保留；后续再增加可重放的完整事件流和同步协议。密钥进入系统加密凭据存储。

选择 Electron 的首要原因是稳定性：Cordis Loader/HMR 与 Harness host 都以 Node 为主要运行环境，Electron 可以直接承载它们，避免 Rust↔Node sidecar、额外运行时分发和跨语言故障面。Android 本来就使用独立插件产物，因此不以牺牲 PC 稳定性为代价强求共享宿主。

## 稳定性基线

- Electron、Cordis、SQLite 驱动和构建工具全部锁定精确版本；只通过依赖升级 PR 更新，不使用浮动范围。
- Cordis 经过 `runtime-cordis` 适配层使用，并冻结一个已审计快照。升级必须先通过生命周期、HMR、回滚和 Windows 文件占用测试。
- Electron main 不运行第三方插件和模型循环；这些工作进入可重启的 utility process 或独立插件进程。
- Renderer 开启 `contextIsolation` 与 sandbox，关闭 `nodeIntegration`；preload 只暴露生成的最小 IPC API。
- Core UI shell 不允许热替换。开发态 HMR 只服务开发；产品态插件升级必须走 stage/health-check/commit/rollback 事务。
- 首发只承诺 Windows，先固定一套可重复构建和自动更新链路，再扩展 macOS/Linux。

## 分层

当前实现已经建立 `apps/pc-host` utility process、`packages/protocol` v1 envelope，以及 Electron Main 中的 Host Supervisor。PC Host 通过 `packages/runtime-cordis` 运行可信时间工具插件，提供清单、启停、执行和退出清理，并在同一进程内完成 OpenAI 兼容模型的流式调用。API Key 由 Main 用 `safeStorage` 加密保存，Host 通过私有 RPC 取得运行时凭据，不进入插件上下文。插件草稿与已安装插件分开存放，创建后不会被动态加载。适配层锁定 `@cordisjs/core 3.18.1`；通用 SDK 负责状态、逆序清理与失败项保留，Cordis 负责每次激活的独立作用域，框架对象不进入插件接口。Main 已接入随固定 Electron 运行时分发的 `node:sqlite`；动态服务依赖与产品级热更新事务仍按后续阶段推进。

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

当前仓库已先落地 `packages/plugin-runtime` 的平台无关生命周期契约，以及 `plugins/hello-world` 的可信 `pc-ui` 示例。它验证动态加载、受控贡献、启停清理和失败回滚；任意磁盘插件、进程隔离与版本热替换仍按下述目标架构实现，不能把当前同 realm 示例视为安全沙箱。

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

### 本机历史备份与合并边界（2026-10-13 实现）

上述完整事件流仍是目标设计；当前完整聊天历史位于 SQLite 投影，诊断日志有界。手动 `.mtchistory` 备份从 SQLite 在线一致性快照遍历全表，不使用最近 50 条的 Renderer 投影。只导出白名单会话、消息、撤回记录和这些消息引用的内容寻址附件，不导出诊断日志、服务器目录、发送／已读队列、身份私钥、设备标识、插件、模型凭据或界面设置。

外层使用固定参数 scrypt 派生密钥、随机盐／IV 与 AES-256-GCM；先验证完整密文，再暴露记录。内层摘要覆盖按序记录，由当前全局身份签名；恢复必须同时满足密码认证、记录及附件哈希校验、签名有效、归档 UID 等于当前身份。这是本机备份的来源与完整性约束，不是中心服务器签发的聊天真实性证明，也不构成消息端到端加密。消息中用户自行输入的敏感正文会保留在加密备份中。

导入使用新建私有暂存目录和独立暂存 SQLite，不执行归档内 SQL、代码或文件路径。附件按哈希／长度验证并以不覆盖方式发布，随后在单个数据库事务内合并；现有同 ID 或同服发送者／客户端消息 ID 的记录优先，跨会话／服务器身份冲突拒绝并回滚，撤回优先且清除原文和引用摘要。新增历史标为本机已读，不新增回执；旧排队／发送中消息变为失败，生成中变为取消，不自动重发或继续 AI 任务。已有会话选项与关系保持不变，新增网络会话为不可发送的只读历史，原中心返回当前目录后才可能恢复可用关系。合并旧历史会重排受影响会话的分页位置，Renderer 必须丢弃旧游标。

身份恢复和历史恢复互相独立：换机先导入 `.mtcidentity` 并切换原 UID，再合并 `.mtchistory`。当前只做用户触发的本机备份，不做定时云同步、跨身份合并或跨设备插件／草稿同步。上限为 1 GiB 编码内容、100 万条历史记录、单条聊天记录 8 MiB、单附件 5 MiB；附件经 Base64 编码也计入总量。数据库合并前的附件发布不是跨文件系统事务，失败可能留下未引用的新附件；不为清理它们删除任何旧文件。备份与暂存需要额外磁盘空间。成功提交后若临时文件清理失败，返回清理警告而不是伪报事务失败，界面仍刷新已合并记录；可能残留的明文快照、解密记录和附件需要按本机聊天数据保护。错误或异常退出也不承诺磁盘上完全不留新暂存文件。尚未在公网真实服务器或 Android 上进行迁移验收。

## 需要尽早冻结的契约

1. `PluginManifestV1` 与 target/permission 命名。
2. Host↔UI 传输无关的消息 envelope、取消与流式事件语义；Electron IPC 和未来 Android RPC 都从它生成。
3. Conversation event union 与 schema version。
4. Service registry 的 id、scope、版本协商和错误码。
5. 热更新事务与回滚错误模型。
6. AI plugin authoring 的工具协议和审批回执。
