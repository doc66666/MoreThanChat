# PC Host 协议与进程监督

MoreThanChat 已将未来的模型调用、数据库和 PC Host 插件预留到独立 Electron utility process。Electron Main 只负责监督与受控转发，Renderer 不直接获得 Node、进程或通用 IPC 能力。

## 组件

- `packages/protocol`：平台无关的 v1 request/response/event envelope、运行时校验和 JSON Schema；
- `apps/pc-host`：独立进程入口，运行 `CordisPluginRuntime({ target: 'pc-host' })`，处理 handshake、ping、插件控制、工具执行与 shutdown；
- `host-supervisor.ts`：请求关联、超时、generation、崩溃检测、有限退避重启和退出清理；
- `electron-host-process.ts`：对 Electron `utilityProcess.fork()` 的薄适配；
- `preload.ts`：只暴露状态查询、状态事件、ping、插件清单/启停、工具调用，以及模型设置和聊天流事件，不暴露任意 channel，也不回传 API Key；
- Renderer 状态按钮：显示连接中、已连接、重连中、失败或已停止。

## v1 消息

所有消息包含 `protocolVersion` 和明确的 `kind`。请求与响应还包含 `requestId` 和 `method`，响应必须同时匹配二者。

当前方法：

- `host.handshake`：协商协议版本并确认 Host generation；
- `diagnostics.ping`：验证请求关联和往返；
- `host.shutdown`：应用退出前请求优雅关闭。
- `plugins.list`：读取这一代 Host 的插件状态与可用工具；
- `plugins.setEnabled`：启用/停用已安装可信插件；
- `tools.invoke`：按插件 id 与工具 id 执行无参数工具，返回带 generation 的文本结果。
- `model.getSettings` / `model.setSettings`：读取或更新 Base URL、模型名和提供方。响应只有 `hasApiKey`，不回传原始密钥。
- `model.chat.start` / `model.chat.cancel`：在 Host 内开始或取消一次流式回复。
- `pluginDrafts.inspect` / `create` / `validate` / `diagnose`：管理未安装草稿。响应不回传源码或 API Key。

当前事件：

- `host.statusChanged`。
- `model.chat.delta` / `model.chat.completed` / `model.chat.failed` / `model.chat.cancelled`。取消和失败都带已生成的部分文本，不能当成正常完成。

畸形消息、未知 kind/method、错误 payload 和版本不兼容都会被运行时 parser 拒绝。Schema 位于 `packages/protocol/schema/host-protocol-v1.schema.json`，未来 Android Host Adapter 使用同一协议概念。

## Supervisor 状态机

```text
stopped → starting → ready
              │       │ crash / protocol violation / handshake timeout
              └───────┴→ restarting → ready
                                └→ retry budget exhausted → failed
```

每次启动都会增加 generation。旧进程的消息和退出回调不能污染新 generation；进程退出时，该代所有 pending request 都会被拒绝。连续失败采用有限退避，达到预算后稳定进入 `failed`，不会无限快速拉起。

应用退出时，Supervisor 会先禁止重启、取消退避定时器、等待插件资源清理和 Host 退出，并在超时后终止进程。并发 stop 共用 Promise；stop 完成前 start 被拒绝，避免应用关闭后进程复活。Host 只继承必要的系统环境变量，完整 fatal diagnostic report 被丢弃，不转发给 Renderer。

Main 保存本次应用会话内已确认的插件启停选择，每次重启完成握手后先重新应用这些选择，再广播 ready。Renderer 只接受当前 generation 的清单与工具结果。整个应用重启后的启停配置持久化尚未实现。

## 时间工具示例

`plugins/time-tool` 是独立 workspace 插件包，声明 `pc-host` target 和空权限列表。它通过 `host.tools` 服务注册 `current-time` 工具，返回 ISO 8601 时间。插件逻辑不进入 Renderer，UI 只渲染结构化工具描述与文本结果。停用时工具被自动注销，调用被拒绝；Host shutdown 会等待已开始的工具调用后清理插件资源。

## 验证

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm verify:host
```

`verify:host` 会在隔离 QA 用户目录启动 Electron，先停用第一代时间插件，再让 Host 主动退出。第二代启动后验证停用选择已恢复、工具调用被拒绝，再通过插件面板启用/执行/停用/重新启用，并检测 ping。脚本同时确认 `window.require` 与 `window.process` 不可用，并输出 `.artifacts/host-supervision-e2e.png`。

## 当前边界

- PC Host 仅运行随应用内置的可信插件。`plugin-drafts/` 里的草稿按修订号追加保存，校验和诊断只做静态检查，不会执行源码，也不会替换已安装插件；
- API Key 只写在 Host 数据目录的 `model-credentials.json`（权限 0600）。设置快照、聊天记录、插件服务和 Renderer 都不接收原始密钥。模拟模式不会把密钥交给提供方，也不会访问网络；
- utility process 是崩溃隔离与权限收敛边界，但不是完整恶意代码沙箱；
- 当前开发构建从 `apps/pc-host/dist/main.js` 启动，正式安装包还需将 Host bundle 放入 `extraResources` 并验证 ASAR 路径；
- Cordis 适配层和契约测试已接入，CI 配置已建立；下一步是安装包资源路径验证，随后进入 SQLite 与模型 Provider。当前启停是生命周期验证，插件版本更新/失败恢复旧版本的事务仍未实现。
