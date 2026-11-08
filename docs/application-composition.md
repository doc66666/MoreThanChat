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

## 消息也由插件渲染

消息时间线内部按消息调用 `message`，默认气泡再调用 `message.body` 和 `message.attachment`。正文分派器根据 `message.content.format` 调用 `message.body.<format>`；旧消息没有格式字段时默认用 `message.body.markdown`，双方消息使用同一渲染器。另有 `message.body.plain`。这些默认实现均为 `builtin.ui.*` 插件，可以单独停用、替换、包装及热更新，无需重写整条时间线。

```js
// manifest.services.requires = ['ui.surfaces']
export default (ctx, sdk) => {
  ctx.contribute(ctx.getService('ui.surfaces'), {
    id: 'card', surface: 'message.body.my-card',
    render: ({ context, defaultView }) => {
      const content = context.message.content
      if (content?.version !== 1) return defaultView
      return sdk.React.createElement('section', { className: 'my-card' }, content.body)
    },
  })
}
// 在发送动作中调用；摘要仍用于通知、搜索、引用和未安装插件的客户端。
// await sdk.chat.request({action:'send',conversationId,clientMessageId,
//   text:'卡片的文字摘要',content:{format:'my-card',version:1,body:'卡片正文'}})
```

正文／附件入口的 `context` 含 `message` 和默认气泡传入的 `own`；格式入口还含 `text`（格式正文或普通消息文字）。`message` 整条入口的 context 对应 `MessageBubble` 属性，包含消息、布局信息和复制／引用／转发等回调。默认时间线在气泡外维护可测量的 `data-message-id` 定位节点，替换气泡的插件无需重复提供；只替换正文时，时间、回执、头像和原有动作也保留。替换整条时间线的插件仍需自行对接定位与阅读行为。已撤回消息只显示撤回记录，不再交给正文插件。

格式名不是白名单：允许小写字母、数字、点和连字符，以字母开头，最长 80 字符；正文字符串最长 100000 字符，版本为正整数，发送须附非空 `text` 摘要。插件可以自行把 JSON 等数据编码到 body 并按版本解析。字段经过聊天读取／发送接口、中心中转、离线队列、本机历史和转发保留；相同发送 ID 不可改写格式或正文。引用与搜索继续使用摘要，撤回清除格式正文和附件。备份包含正文数据但不包含渲染插件，导入到未安装插件的客户端仍显示摘要。

无匹配渲染器、版本不支持、渲染抛错或插件停用时显示摘要，安装或更新后会重绘已有消息。默认附件插件停用时只显示文件名称提示，避免停用后仍启动媒体加载器。默认 Markdown 不执行原始 HTML；示例库的 HTML 渲染器使用独立无脚本 iframe。任意交互由用户安装的可执行插件提供，发送消息本身不会安装或执行代码。源码示例见 `examples/bundled/html-message.mjs`。

新增格式要求服务器声明 `message-content-v1`；不支持时客户端保留消息正文并提示更新服务器，升级后可原样重试。普通文字和 Markdown 不依赖此新能力。

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

首次载入失败的 Node 插件同样显示在管理列表中，可查看错误、重新载入或停用。相同源码的执行失败不会在每次扫描时重复执行；源码变化或主动点击重新载入会重试，缺少声明依赖的插件仍会等待依赖就绪。启用停用中的插件时先检查最新源码，旧版本自身已无法启动也不会阻止加载修正后的版本。首次失败留下的清理记录归原装载器管理，清理成功后可继续重试。面板打开时刷新后台状态，更新失败但原版本仍在运行时明确显示这一状态。

AI 草稿工具生成的是客户端可执行包，不能将 Node 目录装载能力描述为草稿工具已能静默部署 Node 程序。插件自有数据仍由作者管理，重构没有添加群插件数据托管服务。

## 验证

`pnpm typecheck`、`pnpm test`、`pnpm build` 检查类型、契约和构建。`node scripts/verify-composition-ui.mjs` 使用两个隔离的真实 Electron 用户目录，覆盖普通草稿安装、默认标题替换、模型服务覆盖、流式回复中替换、重启恢复、卸载后默认功能接回，以及实际 Main/Host 的目录热更。模型由本机确定性 SSE 服务提供，不消耗外部模型额度。

原有回归入口包括 `verify-client-plugins-ui.mjs`、`verify-shared-client-plugins.mjs`、`verify-central-ui.mjs` 和 `verify-chat-experience.mjs`。测试包不装入正常用户目录或发行包。
