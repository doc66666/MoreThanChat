# MoreThanChat
一切皆插件的聊天应用，或许你的企鹅已经过时了！

当前阶段：PC 端聊天原型与可信插件生命周期验证。

## 当前可运行原型

仓库已经包含一个 Electron 桌面聊天原型，支持会话切换、搜索、新建会话、发送消息、本地持久化和插件启停。当前有两个可信内置插件：本地演示传输，以及会向输入框注册“问候”动作的独立 `hello-world` 示例插件。

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
```

- [架构与安全边界](docs/architecture.md)
- [插件运行时与示例](docs/plugin-runtime.md)
- [开发路线图](docs/roadmap.md)
- [DeepSeek Harness / Cordis 调研记录](docs/upstream-study.md)

更新本地参考源码：

```powershell
./scripts/update-upstreams.ps1
```
