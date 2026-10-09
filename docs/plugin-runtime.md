# 插件运行时与第一个示例

当前实现完成了可信插件的第一条真实闭环：独立插件包通过版本化 manifest 进入 catalog，应用在运行时动态加载模块，执行 `activate()`，收集其贡献，并可在不重启应用的情况下停用和再次启用。

## 已实现

- `packages/plugin-runtime`：平台无关的 manifest、生命周期、状态订阅和贡献注册表；
- `plugins/hello-world`：独立 workspace 插件包，向 `ui.composer-actions` 注册“问候”动作；
- `apps/desktop/src/renderer/src/plugin-host.ts`：PC UI host，提供受限服务并维护可信插件 catalog；
- 插件面板：显示真实 manifest、版本、target、错误和运行状态，可启用/停用；
- 自动验证：真实动态导入、执行、100 次启停、失败回滚、清理异常、重复 id，以及 Electron UI 交互。

## 生命周期

```text
catalog/install → inactive → activating → active
                                   │          │
                          失败回滚 └→ failed  └→ deactivating → inactive
```

插件只能在 `activate(context)` 中通过 host 服务注册贡献。优先使用 `context.contribute(registry, contribution)`，runtime 会自动绑定真实插件 owner 并追踪 disposer；其他资源可继续通过 `context.effect()` 登记。停用时 runtime 按逆序执行全部 disposer，失败项会保留以便再次清理，未清理完成的插件不能被卸载。激活或健康检查失败时，同一批 effect 会立即回滚，不会留下半注册项。

同一插件的激活、停用与卸载操作会串行执行；卸载一开始即进入终止状态，晚到的激活和异步贡献都会被拒绝，从而避免无法再管理的孤儿插件。安装时 manifest 会被深拷贝并冻结，外部对象后续变化不会修改运行时认知。

## 示例插件

`plugins/time-tool` 是可信 `pc-host` 示例，运行在独立 utility process 中。它通过 `host.tools` 注册无参数时间工具，Main 通过版本化协议控制启停，Renderer 只接收结构化清单与执行结果。其服务测试覆盖 100 次启停、未知工具拒绝、运行中的工具结束后再清理资源。

`plugins/hello-world` 的 manifest 只声明 `pc-ui` target、零权限和一个所需服务：

```ts
services: { requires: ['ui.composer-actions'] }
```

激活后它注册一个结构化 `ComposerAction`。插件不会直接持有 React state、DOM、Node 或 Electron IPC；宿主只在用户点击动作时传入当前草稿和会话元数据，插件返回新的草稿及可选通知。停用插件后，对应按钮立即从输入框工具栏消失。

新增同类可信插件时：

1. 在 `plugins/<id>` 创建 workspace 包和 `PluginManifestV1`；
2. 默认导出由 `definePlugin()` 定义的模块；
3. 只请求并使用公开 service；
4. 使用 `context.contribute()` 注册结构化贡献；其他资源的 disposer 交给 `context.effect()`；
5. 在 `plugin-host.ts` catalog 中登记 manifest 与动态 `import()` loader；
6. 添加激活、执行、停用零残留和失败回滚测试。

## 当前边界

这一阶段是 **trusted/bundled plugin** 契约验证，不是任意第三方磁盘代码安装器，也不是产品级热更新：

- 插件随应用构建并由 Vite 拆成独立动态 chunk；
- `pc-ui` 插件仍与 Renderer 同 realm，只适用于审计过的可信代码；
- 启停是完整生命周期重建，但 ESM 模块仍受 import cache 影响，不能把它称为新版本热替换；
- 运行时异常可以回滚，死循环、进程退出和内存耗尽尚不能隔离；
- target 已预留 `pc-host`、`android-runtime`、`android-ui`，但 Android 不加载 PC 产物。

未安装草稿由 PC Host 的 `pluginDrafts.*` 方法保存。它们和已安装 catalog 分开，只做 manifest、凭据痕迹和危险 API 的静态检查。用户确认后，`pluginDrafts.install` 接受两种固定 JSON：`{ kind: "host-text-tool", toolId, label, text }` 与 `{ kind: "composer-text-action", actionId, label, text }`。Host 用其中的文本注册静态贡献，不执行草稿源码。文本工具和输入框动作安装后都立即出现在输入框，并可通过现有启停停用。清单只含 id 和标签。文本工具记录写在 Host 私有目录，重启后按上次启停状态恢复。保存失败会撤回这次安装。再次确认同一文本工具时，Host 先封存不可变版本，再切换当前记录；更新失败会恢复上一版本，已提交的版本文件不会改写。输入框动作只保留到本次 Host 进程退出。内置插件和其他已安装 id 不会被这份草稿替换。签名，以及任意插件的阶段式版本切换事务仍未实现。

下一阶段应把可安装的 PC host 插件放进 Electron utility process/独立 worker，经签名、内容哈希、权限 broker 和 IPC 暴露结构化贡献，再实现 stage、健康检查、commit 和 rollback 的版本切换事务。

## 验证

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm verify:plugin-ui
```

`verify:plugin-ui` 会启动隔离 QA 实例，实际停用/启用示例插件、点击贡献动作并检查输入框结果；截图写入被 Git 忽略的 `.artifacts/plugin-panel-e2e.png`。
