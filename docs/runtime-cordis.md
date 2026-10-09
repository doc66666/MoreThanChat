# Cordis 适配与验证基线

PC Host 已使用 `packages/runtime-cordis` 的 `CordisPluginRuntime`。Renderer 和 Android 可继续使用平台无关的 `packages/plugin-runtime`，无需接触 Cordis。

## 固定版本

稳定优先：生产依赖固定为 `@cordisjs/core 3.18.1`，仅安装核心，不加载 CLI、Loader 或开发 HMR。现有 `.research/cordis` 是 4.0 RC 研究快照，不进入应用依赖。

- [审计源码](https://github.com/cordiverse/cordis/tree/4658414e9414464ff1d08d076882fb66c1a3bb1c/packages/core)
- npm integrity：`sha512-yRuATOamFxeD1ztE2L3o1SaHuT2zw5DTXijQYxt9azVNeILbvtomfGG6sLZegrynJO9XZbNvXbOlQ7LBJDOlAg==`
- 传递依赖通过 `pnpm-lock.yaml` 固定，CI 使用 `--frozen-lockfile`；框架升级必须先跑契约测试和桌面 E2E。

## 生命周期分工

`PluginRuntimeOptions.activationDriver` 是宿主侧扩展点，插件获得的 `PluginContext` 保持一致。通用 SDK 仍负责 manifest 快照、按插件串行的生命周期、贡献 owner、健康检查、逆序 effect 清理与失败项重试。

Cordis driver 为每次激活创建独立 Scope，使用已声明的服务依赖，在框架异步任务完成后检查结果。Cordis 3 将错误记录在 Scope 中而不是让 `flush()` 拒绝；适配层会将错误重新抛入 SDK 的回滚流程。插件的异步 disposer 由 SDK 等待和保留，避免依赖框架内部的清理异常处理。

Scope 清理先登记，因而插件 effect 会先清理，随后删除其 Cordis Scope。`close()` 阻止新的安装/激活，等待已接受的工作，对所有插件尝试清理；任一失败都会让关闭失败并可重试，不会漏掉其余插件。诊断只暴露框架版本和 Scope 数量，不公开框架对象。

当前服务由 Host 启动时静态提供；缺失必需服务会拒绝激活。动态 provider 注销、依赖等待与恢复尚未开放。重启同一插件不是版本热更新事务，版本切换与恢复旧版本仍属于后续 plugin-manager。

## 本地验证

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm verify:protocol
pnpm verify:plugin-ui
pnpm verify:host
```

适配契约包括：100 次启停后 Scope/贡献零残留、异步激活失败、健康检查失败、返回异步 disposer 的逆序清理、清理失败重试、缺失依赖拒绝、激活期间关闭、批量关闭失败后重试，以及卸载零残留。PC Host 原有服务测试和 Electron E2E 也通过新适配层执行。

## CI

`.github/workflows/ci.yml` 在 main 推送与 PR 时运行：

- Windows Server 2022 与 Ubuntu 24.04：Node 24.12.0、pnpm 11.21.0、锁定安装、类型检查、单测、构建和 Android JSON Schema 一致性。CI 中的 `pnpm build` 还会用 electron-builder 生成当前系统的 unpacked 目录，并检查 Host 生产依赖在 `app.asar` 之外；
- Windows：真实 Electron UI 插件启停、Host 崩溃恢复与停用选择恢复；
- 截图保留 14 天；actions 固定提交 SHA，工作流权限为 `contents: read`。

QA 崩溃仅在第一代 Host 确认停用插件后触发，不依赖冷启动速度。Linux unpacked 目录只说明布局和依赖能在当前系统加载到 utility process 守卫。正式 Windows 安装包仍需在 Windows 上验收启动。
