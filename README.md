# MoreThanChat
一切皆插件的聊天应用，或许你的企鹅已经过时了！

当前阶段：PC 端聊天原型、可信插件生命周期，以及受监督 PC Host 进程边界验证。

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
```

- [架构与安全边界](docs/architecture.md)
- [插件运行时与示例](docs/plugin-runtime.md)
- [PC Host 协议与进程监督](docs/host-supervision.md)
- [开发路线图](docs/roadmap.md)
- [DeepSeek Harness / Cordis 调研记录](docs/upstream-study.md)

更新本地参考源码：

```powershell
./scripts/update-upstreams.ps1
```
