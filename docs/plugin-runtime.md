# 插件运行时与第一个示例

## v0.3.0 插件管理与工具循环

- AI 作者工具新增 `list_plugins`、`delete_draft`、`uninstall_plugin`。安装列表合并本机 Host 与可执行界面插件，草稿不再被当成安装列表。删除要求准确 ID 与当前修订，卸载要求准确 target、ID 与版本；不删除插件自存数据、不撤回群审批、不操作其他成员副本。
- 草稿从活动列表移入用户目录下的 `plugin-drafts/.deleted`；同 ID 重建不会复用旧修订号。卸载从持久化安装列表移除并清理运行贡献，客户端清理完成后才回报成功。内置插件不显示卸载入口。旧声明式插件卸载后也可以重新安装，历史不可变版本不会被覆盖。
- 取消 AI 工具累计轮次上限。连续 5 次工具失败后停止本轮自动工具执行并请求一次总结；任一工具成功清零失败计数。取消操作仍生效，模型／网络错误仍会准确报告，不宣称任务成功。
- 图标由 `apps/desktop/scripts/generate-icons.mjs` 统一生成 SVG、PNG 与多尺寸 ICO：白底、黑色像素 MT、彩色像素 C，应用内标记、窗口、托盘与 Windows 打包共用。
- 回归覆盖草稿删除、卸载清理、卸载后重装、长工具循环和兼容模型协议。

本轮续查补充：卸载先保存停用状态并完成运行清理，清理或磁盘删除失败时保留可重试的列表项；过期的启停操作按内容摘要核对，不覆盖热更新或重新装回已卸载包。卸载失败后界面同样刷新实际状态。兼容模型解析不再静默截去第九个及之后的工具调用；补充了 20 个调用的完整执行和取消长工具循环的回归测试。

最新入口与共享协议见文末“2026-10-14：同一可执行包的本机／群聊／私聊闭环”；旧声明式群插件继续兼容。

## 2026-10-14 可执行界面组合层

PC UI 现使用 `CordisPluginRuntime`，除旧 `ui.slots` 外增加 `ui.surfaces` 服务（`UiSurfaceRegistry`）。可执行插件通过 `context.contribute(registry, {id, surface:'root', priority, render})` 替换整个默认桌面，而非只能附加九个挂件。`render` 接收 `context`、`defaultView` 和 `renderSurface(name, context?, fallback?)`，可以包装默认界面、完全替换界面或渲染任意命名的子区域。数值较小的 priority 获选，同优先级按注册先后；卸载获选贡献后恢复先前贡献或默认视图。

`root` 的 context 当前提供当前会话／消息／草稿／资料、会话列表、选择会话、修改草稿、发送和中心快照。App 的状态与通信 hooks 保持运行，替换的是返回的视图。有自定义 root 时暂停默认视图的自动已读，避免插件未展示消息却被标记已读；插件视图可见性与已读 SDK 留待完整包阶段接入。render 异常通过 React boundary 返回该区域默认视图；循环区域或超过 32 层的组合返回 fallback。相同贡献 ID 的重新注册使用新实例标识，避免热换后沿用旧错误状态。激活失败与停用由 Cordis/effect 清理注册；没有安装替换模块时视觉结构保持原样。

这些是可信 React/JS 模块的组合 API，不是安全沙箱：死循环、任意 DOM 操作、直接修改共享引用仍不能靠 React boundary 或 Cordis 防御。本机包读取／安装、AI 创作、群与私聊分发、主进程恢复入口已接入；隔离的第三方 Node Host 扩展尚未完成。旧群 JSON 程序仍使用原审批协议与九个位置，不把旧包暗中升级为可执行代码。

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

`executable-client` 已接入用户目录安装、直接启用及热更新。它与旧声明式群插件是两种不同信任模型，不应混用：

- AI 用已有 `create_draft` / `validate_draft` 写 `{kind:"executable-client",code:"export default function activate(ctx,sdk) {...}"}`；manifest 为 `pc-ui`、`permissions:["client.trusted"]`。源码仍作为 JSON 保存，不在模型 Host 执行。
- 用户点击“安装并启用此版本”，或导入 `{manifest,program}` 的 `.mtcplugin` 文件后直接加载自包含 ES module。软件内仅显示简短来源提醒，没有原生信任弹窗或二次运行授权。激活成功后保存完整源快照、SHA-256 和启用状态；失败保留此前磁盘版本，并尝试恢复旧运行版本。
- `sdk.React` 是应用的同一 React 实例；`ctx.getService('ui.surfaces')` 支持 `root` 完整替换和自定义子界面；不是九个固定位置的上限。用 `React.createElement`，不直接加载 JSX/TS/npm 裸导入。需要第三方库时先打包为单模块。
- `ctx.contribute`、`ctx.effect` 管理生命周期副作用。重复启停会撤销登记；热更新激活失败尝试恢复旧运行版本。没有登记的全局副作用、恶意代码和无限循环不受 Cordis 沙箱保护。
- 同 renderer 的代码拥有完整客户端界面信任，可能访问聊天和现有 preload API；不是细粒度权限隔离。Node/Electron、原始凭据读取不开放，原有 CSP 外网限制保留。
- 每次启动／重载自动加载用户已启用的界面插件；停用状态同样保存。旧目录没有 enabled 字段时按未启用迁移。Ctrl+Shift+F12 直接停用界面插件并创建新的聊天窗口，不再使用 forcefullyCrashRenderer + reload；不删除已存聊天或插件，但未发送输入可能丢失。这是故障入口，正常热更新不重启窗口。
- 示例：[client-desktop.mtcplugin](../examples/client-desktop.mtcplugin)。仅供主动导入，不预装进发行版。

第三方 Node Host 扩展尚未完成。DSH 插件需要接口适配，不保证原封不动加载。

## 2026-10-14：同一可执行包的本机／群聊／私聊闭环

同一个 `{manifest,program:{kind:'executable-client',code}}` 不需要改写成声明式状态机，即可本机安装或申请分享。草稿卡与已安装插件卡均有“分享到好友／群聊”。群管理员批准；私聊由**接收方**批准，提交者不能自行批准。批准后完整包进入会话成员目录，各端自行点击载入。没有额外系统级信任弹窗。

成员载入的包按服务器、用户、会话、包摘要隔离。本机副本与多个会话副本不会互相覆盖。已选择的共享实例在打开所属会话时激活，切换、断线、离群／删除好友、版本被替代、停用时撤销生命周期登记。重启保留本机选择；新版本审批不自动执行，新版由各端选择载入。恢复界面入口也停用本机已载入的共享可执行包，不删除源码。

共享实例使用同一个 Cordis / ES module 加载器，同样可替换 root、包装聊天、创建任意子界面，**不受旧九插槽限制**。同一包本机与共享同时启用时，当前会话的 surface 优先于该包本机 surface，离开后恢复本机；不改变其他包的优先级。包中 legacy `slot` 只为协议兼容，不决定 JavaScript 渲染位置。不能将完整 renderer 信任宣称为恶意代码沙箱。

运行时 SDK：

```js
export default function activate(ctx, sdk) {
  // sdk.network / sdk.conversation 仅在已载入的会话共享实例中提供。
  // 同一份源码可以在没有 network 的本机模式提供单机功能。
  if (!sdk.network) return
  const { id, kind, serverId, userId } = sdk.conversation
  // members 是动态 getter，Member[]；kind 是 group 或 direct。
  ctx.effect(sdk.network.subscribe(event => {
    // event.id 去重；event.trace.actorId 是服务器认证的发起人。
    // payload 是插件自己的数据，不能把 payload.actor 当认证身份。
  }))
  // 先订阅，再 history()，合并重叠事件并按 stateRevision 排序。
  // sdk.network.send('my-channel', { ... }) 返回 Promise<void>。
}
```

`sdk.plugin` 是原始 manifest；`ctx.manifest.id` 是隔离后的运行实例 ID。`sdk.network.send(channel,payload)` 自动绑定服务器、会话、批准包 ID 和 digest；`history()` 读取本机该版本最近事件；`subscribe(listener)` 返回取消函数，应放进 `ctx.effect`。声明 `chat.network` 的旧 `ctx.getService('chat.network').forPlugin(...)` 接口在共享实例中也绑定到这个实例。

服务器只转发 JS 插件的任意 channel/payload，不执行源码、不计算胜负、不保存业务快照。追踪信息 `trace` 包含 `actorId,packVersion,digest,acceptedAt,stateRevision`，最后一项是每插件单调事件序号，新版本不保证从零开始。事件持久入队、按现有设备规则投递、客户端落盘后 ACK；本机缓存最多 1000 条／插件且受全局配额约束，不是无限存档。迟加入、截断、重连、请求结果不确定时的去重、业务规则、存档与升级迁移由插件设计。平台不提供业务存储服务；旧声明式插件的历史状态机仅作兼容保留。

线协议继续使用历史字段 `groupId` 表示 scope；群为 `grp_...`，私聊为 `dm_<较小用户公钥指纹>_<较大用户公钥指纹>`，用 `directPluginScope(a,b)` 构造。它不是聊天消息自身的 conversationId，插件不应自行拼接。仅已接受好友关系可以使用私聊 scope；删除好友会清除该 scope 的审批包和未送达插件事件。新能力通过 `executable-plugin-v1` 协商；旧客户端不会收到不可解析的可执行目录，私聊插件事件降为目录唤醒，不阻断普通消息。

示例 [shared-tic-tac-toe.mtcplugin](../examples/shared-tic-tac-toe.mtcplugin) 用同一份源码演示单机、群、私聊，完整 root 包装、主动占座、退座、胜负、新局释放席位、hello/snapshot 与插件自行 localStorage 存档；不预装。示例是可信成员协作游戏，不承诺对恶意对手的防作弊。

验收命令 `pnpm verify:shared-plugins`：真实 Electron / preload / Host / Cordis / Blob ESM / 中心 SQLite，三个隔离用户，通过聊天模型工具循环生成与修订草稿、从用户界面分享／审批／载入。模型为确定性 OpenAI-compatible 测试端，不冒充本轮真实 DeepSeek 生成。支持 `MTC_TEST_PACKAGED_EXE` 验收打包后的实际 EXE。
