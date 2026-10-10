# AI 插件创作 MVP 阶段验收（2026-10-10）

这是 2026-10-09 检查点的收尾：完成 Windows 目录版验收、扩展热更新回归、同步文档并推送远端。上阶段真实 DeepSeek 的 Host 生成/修订/执行验证已通过；本次使用本地兼容模拟服务，没有消耗真实 API 额度。

## 验收范围

`scripts/verify-ai-ui.mjs` 通过应用的设置和聊天界面操作，不直接创建或安装草稿：

1. 用户保存模型配置，Key 进入系统加密存储，输入字段清空。
2. 聊天调用 create/validate 工具生成大写转换草稿，未确认时没有已安装插件。
3. 取消安装确认不改变状态；再次确认后动作可立即使用。
4. 用户在同一聊天中要求小写修订，旧版继续工作；取消更新仍保持旧版。
5. 停用插件，再确认更新，版本升至 0.1.1，动作仍保持停用。
6. 两份不可变版本分别保留大写和小写定义。
7. 重启应用，恢复聊天、加密凭据、新版本和停用状态；重新启用后输入框使用小写转换。
8. 清除 Key 后加密文件删除，聊天状态没有测试凭据。

开发模式与 `.artifacts/desktop-release/win-unpacked/MoreThanChat.exe` 均通过：`requests: 6`、`updatedByChat: true`、`cancelledConfirmation: true`、`disabledUpdateRestored: true`、`immutableVersions: true`。两次验收截图分别为 `.artifacts/ai-plugin-e2e.png` 和 `.artifacts/ai-plugin-packaged-e2e.png`。

Host 崩溃重启、时间插件启停持久化也已通过本机回归。此前检查点的类型检查、单测和构建已通过；本次核心代码没有改动，新增的是端到端覆盖及文档。

已保存的检查点 `7392241` 推送后，Windows 与 Linux 的远端 [CI 38014930180](https://github.com/doc66666/MoreThanChat/actions/runs/38014930180) 均成功，Windows 可运行目录及截图已上传。该次 CI 包括完整类型检查、101 个单测、两平台构建、协议一致性及原有目录版端到端验收。热更新扩展覆盖还需由本次后续提交的 CI 执行。

## 内测操作

Windows CI 成功后在 Actions 页面下载 `MoreThanChat-windows-x64`，解压整个目录并运行 `MoreThanChat.exe`。本地也可执行 `pnpm package:dir` 生成目录版。

在设置中填写自己的兼容 API、模型和 Key，然后进入 More AI：

> 帮我创建一个把输入框英文转成大写的插件，请实际创建并校验草稿，等待我确认安装。

进入插件面板确认，输入 `Hello AI` 并点击新增动作。随后可以在同一会话要求保持插件 id、将版本改为 0.1.1、改为小写转换；确认更新后立即使用新版。插件面板可以停用和启用。

## 边界与后续

当前 AI 插件是受限 JSON 定义，支持固定文本与三种输入框转换，不执行 AI 编写的任意 JS/TS。其他会话仍使用本地演示传输，联系人之间的真实联网聊天尚未实现。

这份目录版支持先验证聊天与插件闭环；下一开发阶段应实现 SQLite 会话存储、Markdown 与消息重试/Token 元数据，再扩展受控插件 SDK 的能力。Android 继续复用协议与作者流程，使用独立插件运行器。签名安装器和插件包来源验证需要在发布阶段完成。

真实 API 的本轮追加回归尚未执行。获得有额度的 Key 后可运行 `node scripts/verify-ai-ui.mjs --live`，交互输入凭据；默认实时验收只做首次生成流程，避免自动扩大请求次数。
