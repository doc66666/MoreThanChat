# MoreThanChat
一切皆插件的聊天应用，或许你的企鹅已经过时了！

当前阶段：Windows AI 聊天与受限 AI 插件创作内测版。已用真实 DeepSeek `deepseek-flash` 验证生成大写转换插件、确认安装、修订为小写转换、更新和重启恢复；真实桌面聊天中的创建、确认与执行也已实测。

用户在设置中配置 API、模型和 Key，在 More AI 会话中描述需要的插件，再到插件面板确认安装。当前支持固定文本、输入框文本追加，以及大写/小写/首尾空白转换。模型读取实际契约和样例，通过工具创建、校验与修订；用户掌握安装和更新决定。插件启停与版本会保存，失败更新可恢复旧版并继续提交修订。

聊天内核已接入 SQLite 事务存储，自动迁移旧会话并保留备份；退出前确认保存。AI 回复支持 Markdown、代码块、表格、失败/取消后重新生成，以及接口报告的 Token 用量。重试保留原问题和失败记录，不重复发送问题到会话列表。

Key 由 Electron Main 的系统加密服务保存，Host 通过私有 RPC 获取运行时凭据；不使用明文文件回退。任意 JS/TS 代码、文件/网络权限插件、真实联系人联网聊天、Android 与正式签名安装器仍属后续阶段。

## 当前可运行原型

仓库已经包含一个 Electron 桌面聊天原型，支持会话切换、搜索、新建会话、发送消息、本地持久化和插件启停。两个可信 UI 插件提供本地演示传输与快捷问候；独立 PC Host 运行时间工具插件，支持面板启停、结果写入输入框与崩溃后恢复启停选择。Renderer 保持沙箱与最小 Preload API。

```powershell
pnpm install
pnpm dev
```

验证：

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm verify:plugin-ui
pnpm verify:host
pnpm verify:protocol
pnpm verify:ai-ui
pnpm verify:chat-ui
pnpm package:dir
```

`pnpm package:dir` 在当前系统生成 unpacked 目录，并检查 Host 依赖位于 `resources/pc-host`、不在 `app.asar` 里。Linux 上的结果不是 Windows 安装包验收。

Windows CI 验证目录版中的聊天/插件/加密凭据恢复，成功后上传 `MoreThanChat-windows-x64` 产物；下载解压后运行 `MoreThanChat.exe`，需要保留整个目录。尚未签名，属于内测分发版本。

真实 API 测试需要交互输入 Key，不使用命令参数或提交到 Git：

```powershell
pnpm test:live-ai
# Windows 桌面真实模型验收：
pnpm build
node scripts/verify-ai-ui.mjs --live
```

- [架构与安全边界](docs/architecture.md)
- [插件运行时与示例](docs/plugin-runtime.md)
- [PC Host 协议与进程监督](docs/host-supervision.md)
- [Cordis 适配与 CI 基线](docs/runtime-cordis.md)
- [开发路线图](docs/roadmap.md)
- [AI 插件创作与加密凭据](docs/ai-plugin-mvp.md)
- [Windows 内测阶段验收与使用](docs/stage-acceptance-2026-10-10.md)
- [SQLite、Markdown、重试与 Token 阶段](docs/chat-core-stage-2026-10-10.md)
- [DeepSeek Harness / Cordis 调研记录](docs/upstream-study.md)

更新本地参考源码：

```powershell
./scripts/update-upstreams.ps1
```
