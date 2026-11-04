# 应用插件组合

本轮借鉴 DeepSeek Harness 的内置插件、服务注入、界面组合和作用域清理设计，不宣称兼容它的内部 API 或插件包。

参考其官方 [架构说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.zh.md) 与 [界面组合说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/slots.zh.md)。

## 默认功能与用户插件

Renderer、Electron Main 和独立 PC Host 分别使用 `CordisPluginRuntime`，共用 manifest、`PluginSource`、`activate(ctx)`、服务注册、依赖调度、effect 清理和版本替换机制。跨进程仍通过类型化 IPC 通信。

- Renderer：外观、工作区、导航、会话列表、消息时间线、输入区、联系人、主页、设置和插件管理均是默认插件贡献；聊天控制器也是插件服务。
- Main：聊天存储、附件、身份、中心连接、桌面通知、Host 监督器、IPC 绑定由插件组合。
- PC Host：工具管理、草稿、作者工具、凭据桥、模型 Agent 由插件组合。
- 启动层保留进程/窗口创建、IPC 来源检查、插件装载和组合管理，提供运行插件的基础。

默认组合分别定义在 `apps/desktop/src/renderer/src/app-composition.tsx`、`apps/desktop/src/main/service-composition.ts`、`apps/pc-host/src/host-composition.ts`。

## 提供与替换服务

```js
// manifest.services = {requires:['model.api'], provides:['model.api']}
export default function activate(ctx) {
  const previous = ctx.getService('model.api')
  ctx.provideService('model.api', {
    ...previous,
    getModelSettings: async () => ({
      ...await previous.getModelSettings(), model: 'my-model'
    }),
  })
}
```

`ctx.provideService(id, value, priority?)` 对应 manifest 的 `services.provides`；消费方用 `services.requires` 声明依赖。服务名不再限定为固定白名单。默认优先级为用户 0、内置 100、启动注册设施 10000，数值小者优先，相同优先级按提供方首次注册顺序选择，热更新不会改变这一顺序。覆盖服务必须实现原契约。

同时 requires/provides 同一服务，可以取得下层实现并包装；完全替代则不必 requires 原服务。停用覆盖方恢复下层提供方。服务变化时先清理依赖者，再按依赖关系重绑；暂时缺少依赖的消费者保留启用意图，服务恢复后继续运行。

`runtime.replace(source)` 清理旧版和依赖者，再激活新版；新版或之前正常运行的依赖者启动失败、更新移除了仍在使用的服务，都会恢复上一来源并重新绑定消费者。多个包装插件保留实际引用的上游实例，依赖稍后满足时也会重新绑定消费者。异步 disposer 必须等待完成；清理失败保留记录供重试。关闭运行时先清除全部启用意图，避免清理时重新激活模块。

| 服务 | 默认内容与契约来源 |
| --- | --- |
| `chat.api` | 聊天读取/发送、状态与已读、导航；方法签名见 Renderer `global.d.ts` |
| `contacts.api` | 中心连接、好友/群操作、个人资料与服务器快照 |
| `history.api` | 历史查询、检索、转发、撤回及历史管理 |
| `model.api` | 模型设置、生成、取消和模型事件 |
| `plugins.api` | 插件/草稿的本机管理方法 |
| `desktop.api` | 上述提供方与其余原生桥方法组成的接口；`sdk.app` 和默认业务视图共用 |
| `workspace.controller` | 默认工作区 hook，契约见 `WorkspaceViewContext` |
| `ui.surfaces` / `ui.slots` | 自由界面组合 / 原有附加位置 |
| `chat.network` | 原有会话插件同步接口，保留服务器和会话范围绑定 |

Main 服务为 `chat.store`、`chat.attachments`、`chat.identity`、`central.client`、`desktop.integration`、`host.supervisor`，契约对应业务类。Host 服务包括 `model.agent`（`ModelService`）、`host.author`、`host.plugins`、`host.drafts`、`host.management`、`host.credentials`、`host.tool-store`。

## 界面组合

```js
export default (ctx, sdk) => {
  ctx.contribute(ctx.getService('ui.surfaces'), {
    id: 'my-header', surface: 'workspace.chat.header',
    render: ({ defaultView }) => sdk.React.createElement(
      'header', { className: 'my-header' }, defaultView, '我的扩展',
    ),
  })
}
```

默认区域有 `application`、`application.loading`、`root`、`workspace`，以及 `workspace.chrome/navigation/conversations/chat/details/plugins/new-chat/settings/forward/retract/search/server/contacts/profile/toast`。聊天内部有 `workspace.chat.header/notices/timeline/latest/composer`。

这些名字是默认功能的入口，不是位置白名单。插件可以自建任意命名子区域，或替换 `root` / `application` 重建界面。`defaultView` 是下一层贡献，支持多层包装；移除覆盖者后下一层接回。默认视图优先级为 10000。

界面在一次组合事务结束后更新，不显示依赖拆卸的中间状态。默认控制器身份不变时保留 React 状态和 DOM；接口订阅随服务版本重绑，避免丢失会话位置和 AI 流式内容。替换控制器本身会使用新控制器，插件需自行处理状态迁移。样式、事件、计时器等资源要通过 `ctx.effect()` 释放。

## 本机 Node 插件

客户端可执行包沿用 `.mtcplugin` / AI 草稿安装、热更新、群/私聊分享流程。另支持本机 Node 扩展目录：

```text
<当前身份数据目录>/host-private/plugins/<id>/manifest.json
<当前身份数据目录>/host-private/plugins/<id>/index.mjs
<当前身份数据目录>/main-plugins/<id>/manifest.json
<当前身份数据目录>/main-plugins/<id>/index.mjs
```

两者均声明 `targets:["pc-host"]`、`permissions:["host.trusted"]`；目录名与 manifest.id 相同，入口默认导出 `activate(ctx, sdk)`。Host 目录在 utility process 运行，Main 目录在 Electron 主进程运行。这是可信 Node 代码，不是沙箱。

每 750ms 检查源码摘要，入口和相对模块变更都通过 `runtime.replace()` 更新。版本模块树保存到插件目录 `.mtc-runtime/<digest>`，避免 ESM 缓存令相对模块不更新。`node:` 和插件自身 `node_modules` 依赖按 Node 规则解析；`node_modules` 不作为热更扫描来源，安装依赖后需修改源码或重启。持久数据应放在源码树之外。

半写入或新版激活失败保留旧版，已接受的源码摘要记录在 `.mtc-runtime/current.json`，重启也能从该版本继续运行。停用期间的源码编辑在重新启用后应用，不会用未经执行的修改覆盖正常版本。删除整个插件目录即卸载。启停偏好保存到插件目录根的 `disabled.json`，Main 与 Host 在启动默认插件前读取，已停用的模块不会先执行再关闭。偏好写入失败不改变启停选择；停用后清理失败仍保留停用选择供重启使用。

插件面板管理已载入的 Node 插件；“查看默认应用模块”展开内置界面、Host 和 Main 模块。管理 IPC 不随业务 IPC 停用，仍能重新启用默认功能。中心服务包装更新期间，暂时解绑转发订阅所遗漏的插件事件会从已有本机传输记录补投一次；正常重新连接仍由各插件通过原有 `history()` 接口恢复状态，不重播已处理的实时通知。

AI 草稿工具生成的是客户端可执行包，不能将 Node 目录装载能力描述为草稿工具已能静默部署 Node 程序。插件自有数据仍由作者管理，重构没有添加群插件数据托管服务。

## 验证

`pnpm typecheck`、`pnpm test`、`pnpm build` 检查类型、契约和构建。`node scripts/verify-composition-ui.mjs` 使用两个隔离的真实 Electron 用户目录，覆盖普通草稿安装、默认标题替换、模型服务覆盖、流式回复中替换、重启恢复、卸载后默认功能接回，以及实际 Main/Host 的目录热更。模型由本机确定性 SSE 服务提供，不消耗外部模型额度。

原有回归入口包括 `verify-client-plugins-ui.mjs`、`verify-shared-client-plugins.mjs`、`verify-central-ui.mjs` 和 `verify-chat-experience.mjs`。测试包不装入正常用户目录或发行包。
