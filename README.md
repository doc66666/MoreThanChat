# MoreThanChat
一切皆插件的聊天应用，或许你的企鹅已经过时了！

当前阶段：Windows 聊天、中心服务与插件扩展内测版。已有全局签名身份、好友/群聊、离线暂存与收件确认清除、群插件审批及同步。默认开发服务为 `http://localhost:8787`，可在设置切换同一程序运行的私服。AI 聊天与受限草稿创作功能继续保留。

用户在设置中配置 API、模型和 Key，在 More AI 会话中描述需要的插件，再到插件面板确认安装。当前支持固定文本、输入框文本追加，以及大写/小写/首尾空白转换。模型读取实际契约和样例，通过工具创建、校验与修订；用户掌握安装和更新决定。插件启停与版本会保存，失败更新可恢复旧版并继续提交修订。

聊天内核已接入 SQLite 事务存储，自动迁移旧会话并保留备份；退出前确认保存。AI 回复支持 Markdown、代码块、表格、失败/取消后重新生成，以及接口报告的 Token 用量。重试保留原问题和失败记录，不重复发送问题到会话列表。

人与人聊天已增加本机持久发送队列，离线时可排队，重连所属服务器后自动补发，使用原消息 ID 防重。支持送达/已读回执、按阅读位置处理未读、每会话草稿恢复、聊天记录搜索与定位、消息复制、会话归档和免打扰。好友申请可取消或拒绝，群可改名、邀请和移出成员、转让管理员、退出或解散；历史记录仍保留在本机。

插件可以注册侧栏、导航、消息区域、详情、输入区或浮层，也预留了可信插件替换输入区的能力。群成员可申请接龙、井字棋和通用同步通道，管理员批准后向同服群成员分发。加号支持文件与表情，右侧按住说话，文件和语音在中心会话内发送。

客户端提供暖白陶橙的白天模式、Tokyo Night Storm 夜间模式，以及跟随系统；设置中选择外观，左下方太阳/月亮按钮快速切换。会记住每个用户的选择，并统一聊天、插件、设置与窗口标题栏的配色。

Key 由 Electron Main 的系统加密服务保存，Host 通过私有 RPC 获取运行时凭据；不使用明文文件回退。当前远程分发是受限声明式包，任意可执行第三方 JS/TS 的沙箱、Android、端到端加密与正式签名安装器仍属后续阶段。

消息界面分批显示历史，搜索当前使用本机 SQLite 子串查询。数据库仍以有界快照对接界面，完整快照上限为 8 MiB；真正的数据库分页/全文索引、大规模历史存储、跨设备身份恢复和实时音视频仍待下一阶段。

## 当前可运行原型

仓库已经包含一个 Electron 桌面聊天原型，支持会话切换、搜索、新建会话、发送消息、本地持久化和插件启停。两个可信 UI 插件提供本地演示传输与快捷问候；独立 PC Host 运行时间工具插件，支持面板启停、结果写入输入框与崩溃后恢复启停选择。Renderer 保持沙箱与最小 Preload API。

```powershell
pnpm install
pnpm central:dev
# 另一个终端打开两个独立用户端：
pnpm demo:clients
# 常规单客户端开发：pnpm dev
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
pnpm verify:central-ui
pnpm verify:appearance-ui
pnpm central:package
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
- [中心服务、群插件和手动双端测试](docs/central-and-plugin-stage-2026-10-11.md)
- [客户端主题与交互验收](docs/ui-appearance-2026-10-12.md)
- [DeepSeek Harness / Cordis 调研记录](docs/upstream-study.md)

更新本地参考源码：

```powershell
./scripts/update-upstreams.ps1
```
