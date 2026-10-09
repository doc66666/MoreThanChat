# MoreThanChat
一切皆插件的聊天应用，或许你的企鹅已经过时了！

当前阶段：PC 端聊天原型、可信插件生命周期、受监督 PC Host，以及 Host 内的 OpenAI 兼容流式模型。没有真实 API Key 时使用模拟流，不代表已经调用过线上模型。插件草稿可以检查、创建、校验和诊断。用户确认后，固定 JSON 形状的声明式文本工具或输入框动作会安装到当前 Host，安装后可以立即使用和停用。文本工具和输入框动作都在 Host 重启后恢复，并保留启停状态。再次确认文本工具或输入框动作会追加不可变版本，更新失败时恢复上一版本。任意草稿源码不会执行。聊天模型可以检查、创建、校验和诊断草稿，不能代替用户安装。内置插件和其他已安装 id 不会被替换。

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
pnpm package:dir
```

`pnpm package:dir` 在当前系统生成 unpacked 目录，并检查 Host 依赖位于 `resources/pc-host`、不在 `app.asar` 里。Linux 上的结果不是 Windows 安装包验收。

- [架构与安全边界](docs/architecture.md)
- [插件运行时与示例](docs/plugin-runtime.md)
- [PC Host 协议与进程监督](docs/host-supervision.md)
- [Cordis 适配与 CI 基线](docs/runtime-cordis.md)
- [开发路线图](docs/roadmap.md)
- [DeepSeek Harness / Cordis 调研记录](docs/upstream-study.md)

更新本地参考源码：

```powershell
./scripts/update-upstreams.ps1
```
