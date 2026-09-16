# MoreThanChat
一切皆插件的聊天应用，或许你的企鹅已经过时了！

当前阶段：PC 端架构验证与插件协议设计。

## 当前可运行原型

仓库已经包含一个 Electron 桌面聊天原型，支持会话切换、搜索、新建会话、发送消息、本地持久化和内置 transport 插件演示。

```powershell
pnpm install
pnpm dev
```

验证：

```powershell
pnpm typecheck
pnpm test
pnpm build
```

- [架构与安全边界](docs/architecture.md)
- [开发路线图](docs/roadmap.md)
- [DeepSeek Harness / Cordis 调研记录](docs/upstream-study.md)

更新本地参考源码：

```powershell
./scripts/update-upstreams.ps1
```
