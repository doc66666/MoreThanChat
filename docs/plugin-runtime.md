# 插件运行时与第一个示例

最新入口与信任边界见文末“2026-10-14：用户可执行界面入口”；本机可执行代码与旧声明式群插件并存。

## 2026-10-14 可执行界面组合层

PC UI 现使用 `CordisPluginRuntime`，除旧 `ui.slots` 外增加 `ui.surfaces` 服务（`UiSurfaceRegistry`）。可执行插件通过 `context.contribute(registry, {id, surface:'root', priority, render})` 替换整个默认桌面，而非只能附加九个挂件。`render` 接收 `context`、`defaultView` 和 `renderSurface(name, context?, fallback?)`，可以包装默认界面、完全替换界面或渲染任意命名的子区域。数值较小的 priority 获选，同优先级按注册先后；卸载获选贡献后恢复先前贡献或默认视图。

`root` 的 context 当前提供当前会话／消息／草稿／资料、会话列表、选择会话、修改草稿、发送和中心快照。App 的状态与通信 hooks 保持运行，替换的是返回的视图。有自定义 root 时暂停默认视图的自动已读，避免插件未展示消息却被标记已读；插件视图可见性与已读 SDK 留待完整包阶段接入。render 异常通过 React boundary 返回该区域默认视图；循环区域或超过 32 层的组合返回 fallback。相同贡献 ID 的重新注册使用新实例标识，避免热换后沿用旧错误状态。激活失败与停用由 Cordis/effect 清理注册；没有安装替换模块时视觉结构保持原样。

这些是可信 React/JS 模块的组合 API，不是安全沙箱：死循环、任意 DOM 操作、直接修改共享引用仍不能靠 React boundary 或 Cordis 防御。本机包读取／安装、AI 创作这种包、主进程恢复入口现已接入；隔离的第三方 Host 和可执行群分发仍未完成。旧群 JSON 程序仍使用原审批协议与九个位置，后续另接可执行包通道，不把旧包暗中升级为可执行代码。

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

未安装草稿由 PC Host 的 `pluginDrafts.*` 方法保存。它们和已安装 catalog 分开，只做 manifest、凭据痕迹和危险 API 的静态检查。用户确认后，`pluginDrafts.install` 接受两种固定 JSON：`{ kind: "host-text-tool", toolId, label, text }` 与 `{ kind: "composer-text-action", actionId, label, text }`。Host 用其中的文本注册静态贡献，不执行草稿源码。文本工具和输入框动作安装后都立即出现在输入框，并可通过现有启停停用。清单只含 id 和标签。文本工具记录写在 Host 私有目录，重启后按上次启停状态恢复。保存失败会撤回这次安装。再次确认同一文本工具时，Host 先封存不可变版本，再切换当前记录；更新失败会恢复上一版本，已提交的版本文件不会改写。输入框动作同样写入 Host 私有目录，重启后按上次启停状态恢复为输入框动作，不会变成文本工具。再次确认输入框动作也会封存不可变版本再切换当前记录；更新失败会恢复上一版本，已提交的版本文件不会改写。内置插件和其他已安装 id 不会被这份草稿替换。签名，以及任意插件的阶段式版本切换事务仍未实现。

下一阶段应把可安装的 PC host 插件放进 Electron utility process/独立 worker，经签名、内容哈希、权限 broker 和 IPC 暴露结构化贡献，再实现 stage、健康检查、commit 和 rollback 的版本切换事务。

## 验证

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm verify:plugin-ui
```

`verify:plugin-ui` 会启动隔离 QA 实例，实际停用/启用示例插件、点击贡献动作并检查输入框结果；截图写入被 Git 忽略的 `.artifacts/plugin-panel-e2e.png`。

## 2026-10-14：用户可执行界面入口

`executable-client` 已接入用户目录安装与原生确认运行。它与旧声明式群插件是两种不同信任模型，不应混用：

- AI 用已有 `create_draft` / `validate_draft` 写 `{kind:"executable-client",code:"export default function activate(ctx,sdk) {...}"}`；manifest 为 `pc-ui`、`permissions:["client.trusted"]`。源码仍作为 JSON 保存，不在模型 Host 执行。
- 用户从草稿安装，或导入 `{manifest,program}` 的 `.mtcplugin` 文件。安装只保存完整源快照与 SHA-256，不运行。点击“确认运行”后由主进程原生对话框确认精确版本，再加载自包含 ES module。
- `sdk.React` 是应用的同一 React 实例；`ctx.getService('ui.surfaces')` 支持 `root` 完整替换和自定义子界面；不是九个固定位置的上限。用 `React.createElement`，不直接加载 JSX/TS/npm 裸导入。需要第三方库时先打包为单模块。
- `ctx.contribute`、`ctx.effect` 管理生命周期副作用。重复启停会撤销登记；热更新激活失败尝试恢复旧运行版本。没有登记的全局副作用、恶意代码和无限循环不受 Cordis 沙箱保护。
- 同 renderer 的代码拥有完整客户端界面信任，可能访问聊天和现有 preload API；不是细粒度权限隔离。Node/Electron、原始凭据读取不开放，原有 CSP 外网限制保留。
- 每次启动／重载不自动运行第三方界面。Ctrl+Shift+F12 由主进程弹出恢复确认，强制重启 renderer；不删除已存聊天或插件，但未保存输入可能丢失。无响应时也提供恢复入口。
- 示例：[client-desktop.mtcplugin](../examples/client-desktop.mtcplugin)。仅供主动导入，不预装进发行版。

尚未完成的能力：可执行包群审批／分发、第三方 Node Host 扩展、自动恢复启用偏好。`chat.network` 服务本身存在，但本机界面安装不能绕过中心的已审批群包／本机载入检查，不能冒称任意本机插件已获得群通信授权。DSH 插件需要接口适配，不保证原封不动加载。
