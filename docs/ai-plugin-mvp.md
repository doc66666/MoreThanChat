# AI 插件创作 MVP（2026-10-09）

## 用户流程

1. 打开模型设置，选择兼容 API，填写 Base URL、模型与自己的 Key。DeepSeek 当前默认 `https://api.deepseek.com` / `deepseek-flash`。
2. 进入 More AI，输入例如：“帮我创建一个把输入框英文转为大写的插件，请实际创建和校验草稿。”
3. 模型使用 `inspect_drafts` 读取 SDK 契约和示例，用 `create_draft` / `validate_draft` / `diagnose_draft` 创建与修订。
4. 打开插件面板确认安装。输入 `Hello AI`，点击新增动作，输入框变成 `HELLO AI`。
5. 停用后动作消失；重新启用、重启应用后仍可使用。要求模型修订成小写动作，确认更新后切换新版。

确认安装与更新属于用户操作，作者工具不提供自动安装。当前定义是受限 JSON 数据，由宿主实现固定操作，不执行模型生成的 JS/TS。

## 声明式契约

Manifest 必须是无权限 `pc-host` 插件，仅依赖 `host.tools`。模型实际收到的例子位于 `apps/pc-host/src/author-contract.ts`；开发者不应依赖框架内部对象。

新增文本转换定义：

```json
{"kind":"composer-transform-action","actionId":"uppercase","label":"英文大写","operation":"uppercase"}
```

`operation` 支持 `uppercase`、`lowercase`、`trim`。转换接收当前输入框文本，返回 `replaceDraft: true` 和结果；空结果也是有效转换。其他两种 `host-text-tool` / `composer-text-action` 继续追加固定文本。RPC 输入/输出最多 16384 字符。

草稿一般校验状态与安装资格是不同概念。`pendingInstall` 依据实际安装约束，普通 JS 草稿不会被虚报为待安装。已安装 id 的合法修订也需要确认。

不可变内部修订先落盘、再提交 current。失败的保留版本不会覆盖，后续更新从所有已保留 revision 的最大值之后分配，避免回滚后无法再更新。完整签名/内容寻址包、数据库迁移与跨进程版本事务仍未开放。

## 模型服务

模型设置更新串行，运行中的回复保存自己的 provider/base URL/model 快照，防止设置变化影响已有请求。作者循环保留真实工具参数供后续修订，不向 Renderer 输出参数或源码。最多 6 轮、每轮最多 4 个工具调用。

兼容接口支持 JSON 回复与 SSE。正常终止需 `[DONE]` 或有效 finish reason；提前 EOF、length/content_filter 等未完成状态不会伪报完成。官方 DeepSeek endpoint 使用非思考模式，避免小插件生成的推理开销与 reasoning_content 历史协议要求；每次请求输出上限 2048 token。其他兼容 endpoint 不注入 DeepSeek 专属字段。

参考：[DeepSeek 当前 Chat Completions 协议](https://api-docs.deepseek.com/api/create-chat-completion/)、[思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)。后续可独立增加推理模式及其他 API 协议。

## 加密凭据

Electron Main 的 `EncryptedCredentialStore` 通过 `safeStorage` 保护 `host-private/model-secret.bin`。Windows 使用系统 DPAPI；同一用户下其他程序的威胁不由此消除。Linux `basic_text` 被拒绝，无法提供系统密钥库时可以使用模拟模式，但不回退为明文保存。

Host 通过私有 `credentials.read/write` request-response 获取凭据，Renderer 未暴露这些方法，主进程也不把响应广播给界面。独立 Node 模型测试默认仅保存在内存。旧 `model-credentials.json` 在成功写入加密数据后删除；中断的迁移可继续。删除 Key 会删除旧、新两种文件。

参考：[Electron safeStorage 平台语义](https://www.electronjs.org/docs/latest/api/safe-storage)。

## 验证

- 标准锁定安装、跨平台类型检查和单测；Windows 符号链接测试使用无管理员要求的目录 junction。
- 回归测试覆盖 SSE 提前 EOF、长度截断、非声明式待安装提示、回滚后新修订，以及转换的空输入/持久恢复。
- 加密适配测试覆盖 ciphertext、删除、旧数据迁移和不可用时保留原数据。
- `verify:ai-ui` 在 Windows 使用本地模拟兼容服务，实际经过聊天工具循环、确认界面、执行、修订、更新和重启；验证取消确认不改变安装状态，停用插件更新后仍停用、版本文件不覆盖，以及加密凭据恢复与删除。
- `test:live-ai` 在隔离临时数据中使用真实模型，验证生成、修订、安装、执行和恢复。Key 交互输入，输出只记录结果和请求数。
- `verify-ai-ui.mjs --live` 已在 Windows 用真实 DeepSeek 验证聊天内生成、确认安装、执行与加密恢复。测试结束清除保存的 Key，不把它写入报告或 Git。
- CI 不使用真实 Key：Windows 执行模拟 UI、目录版 UI 验证并上传可分发目录和截图；Linux 验证构建/协议/契约。

当前 Windows 目录版是未签名内测产物。后续聊天内核阶段已接入 SQLite、Markdown、AI 回复重试和 Token 展示，详见 [实现与验收](chat-core-stage-2026-10-10.md)。费用金额、任意逻辑插件与 Android 留待后续。

2026-10-10 已在开发模式和 Windows 目录版完成上述扩展验收。记录与内测操作见 [阶段验收记录](stage-acceptance-2026-10-10.md)。
