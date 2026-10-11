# 中心服务与通用插件扩展阶段（2026-10-11）

本阶段纠正两点：插件不再被视为输入框按钮；人与人聊天不再通过本地演示传输模拟。开发默认中心地址按用户要求使用 `http://localhost:8787`，没有配置公网地址。

## 本机测试

启动开发中心服务：

```powershell
pnpm central:dev
```

另一个终端启动两个独立用户端：

```powershell
pnpm demo:clients
```

两个用户端分别保存到 `.artifacts/manual-central/client-a` 和 `client-b`，已有测试数据不会重置。旧窗口使用旧主进程时需完全关闭后重启，核心窗口不做热替换。

每端进入“设置 → 中心服务器 / 身份 / 联系人”，保留 localhost 地址，填写自己的名称，点击“Ping 并认证连接”。复制 B 的全局 ID，在 A 提交好友申请，再由 B 接受。好友会话和群会话都由本服目录建立；原有 AI 会话独立使用模型服务。

在联系人面板选择好友创建群。群成员可申请接龙、井字棋和通用同步通道，选择其显示位置。创建群的用户目前是唯一群管理员，审批后所有群成员获得相同的包版本。其他成员不能代替管理员审批。成员可单独停用本机界面；同步状态仍由中心服务维护。

新用户只预置 More AI，不再生成虚构的产品群、插件群或聊天记录。旧本地历史保留，但不自动转换成真实服务器群。新建单聊/群聊入口会转到中心服务。

## 全局身份与服务器范围

Main 首次生成 Ed25519 长期身份，私钥通过系统加密存储到 `host-private/identity-secret.bin`，不会交给 Renderer、插件或服务器。全局用户 ID 是 `usr_` 加规范 SPKI 公钥 DER 的 SHA-256；一个数据目录对应一个身份，重启和换服务器保持相同 ID。丢失身份文件会失去原 ID，当前尚未提供跨设备身份导入/恢复界面。

认证使用一次性、60 秒有效的挑战签名，绑定协议版本、服务器 ID、用户 ID 与随机 nonce。Ping 通只是第一步，持有有效签名且满足名单规则才能连接。会话令牌只在 Main 内存中保存。参考 [Node crypto](https://nodejs.org/api/crypto.html)。

独立服务器使用独立数据目录，产生 `srv_<UUID>`；群使用 `grp_<UUID>`，成员与管理员记录只归创建它的服务器。客户端历史按服务器 ID 分区，切换地址不会把 A 服会话发送到 B 服。没有跨服搜索、转发或好友联邦。

- `public` 模式：默认允许签名身份，执行黑名单。
- `private` 模式：只有被加入白名单的全局 ID 能认证。
- 服务模式对已有数据目录固定，避免误改环境变量把私服变成公开服务器。
- 普通客户端设置中没有服务器管理员密钥。名单由服务运营者管理；群管理员只拥有本群成员和插件审批权限。

## 中继与离线送达

客户端通过经过认证的 HTTP 长轮询保持连接。消息到达时服务器立即唤醒挂起请求；离线端的消息保存在 `relay.sqlite/queue`，服务重启后仍在。

“送达”定义为客户端已校验数据、同步附件文件并提交本地 SQLite，然后发送 ACK。单纯收到 HTTP 响应不算送达。群聊按收件人分别确认，一人的确认不会删除其他人的副本。重复发送使用 sender/clientMessageId 去重，重复投递也在客户端去重。

ACK 后删除该收件人的消息和附件转发副本。SQLite 开启 `secure_delete`，确认后 checkpoint/truncate WAL；不把消息正文写到服务器应用日志。服务器保留最长七天的防重元数据（ID、内容指纹和时间），不保留已送达正文；不承诺存储设备级的取证擦除。未送达消息无时间到期删除，受总暂存容量限制。

身份、公钥、名单、好友关系、群成员、审批包和当前群插件状态是必要的服务数据，会继续保存。接龙条目、当前棋盘属于同步应用状态，不是聊天历史；插件更新后旧状态清空，只保留当前版本状态。服务器不提供已送达聊天记录恢复，用户需保留本地数据。

## 通用 UI 插件 SDK

`ui.slots` 是新的贡献注册服务，生命周期仍由 `PluginRuntime` 管理，停用会撤销贡献。已有 `ui.composer-actions` 保留为一个小型接口，不再代表全部插件能力。

UI 插槽包括导航、侧栏、聊天标题、消息前后、详情面板、输入区前后及浮层。消息插槽上下文包含当前消息；可信 UI 插件通过 `render(context)` 返回自己的 React 组件，可实现任意组件形式。`chat.composer` 是可信插件替换输入区的入口，渲染异常有局部回退，不替换 Electron Main、存储和身份服务。界面区域有高度/滚动约束。

“工作区卡片”是输入框之外的生命周期示例。群包目前采用受限声明式 JSON（接龙、井字棋、同步通道），审批包含不可变版本和 SHA-256 摘要；客户端复核摘要，未经本群审批不能使用群通道。任意第三方 JS/TS 的隔离运行、编译打包和远程审核分发仍属后续阶段，不以“审批通过”代替沙箱。

窗口宽度不超过 1080 像素时，详情和群插件改为右侧抽屉，点击聊天标题右侧的信息按钮打开，抽屉内可关闭。不会再通过响应式样式彻底隐藏插件；验收包含 1024 像素窗口的打开、关闭及可见性检查。

```ts
const slots = context.getService('ui.slots')
context.contribute(slots, {
  id: 'my-panel',
  slot: 'chat.details',
  render: (ctx) => <MyPanel conversation={ctx.conversation} />,
})

const channel = context.getService('chat.network').forPlugin(approvedPackageId)
await channel.send(groupId, 'my-event', { position: 42 })
const stop = channel.subscribe(groupId, event => consume(event.id, event.payload))
context.effect(stop)
const recent = await channel.history(groupId)
```

通道绑定当前服务器、已审批包和群成员身份，不开放任意 URL、底层 socket 或认证令牌。事件先进入本机持久收件箱再确认，实时订阅按事件 ID 去重；`history` 提供最近 1000 条本地事件，插件应自行维护投影。接龙与井字棋的并发校验由服务器执行，revision 冲突会拒绝，不能由客户端伪造他人的落子。

## 输入与附件

默认输入区为左侧加号、中间文本、右侧按住说话；文本存在时显示发送按钮，Enter 发送，Shift+Enter 换行。加号菜单提供文件/图片选择和表情。语音松开发送，Esc/指针取消会取消，最长 60 秒。

文件和语音目前仅在本服好友/群会话中发送，单附件最多 5 MiB。附件以内容摘要存入本机仓库，不把大块 Base64 放进会话快照；收件端先同步文件再 ACK。图片与音频可预览，其他文件通过系统保存对话框下载。AI 模型会话暂不支持多模态附件。

只向本窗口的主 frame 授予音频媒体请求，不开放摄像头或子 frame 请求。真实麦克风仍受系统隐私设置控制。参考 [Electron session 权限接口](https://www.electronjs.org/docs/latest/api/session)。自动验收使用 Chromium 假设备，不采集用户实际声音。

## 自托管与开发限制

`pnpm central:package` 在 `.artifacts/central-release` 生成纯 Node 服务器目录，无 Electron 依赖。复制目录到 Linux，使用 Node 24.12.0 运行。数据目录应放在发布代码之外。

```sh
export MTC_SERVER_ADMIN_TOKEN='REPLACE_WITH_A_RANDOM_ASCII_SECRET_AT_LEAST_24_CHARS'
export MTC_SERVER_MODE=private
export MTC_SERVER_DATA_DIR=/var/lib/more-than-chat/private
export MTC_SERVER_HOST=127.0.0.1
export MTC_SERVER_PORT=8787
node server.mjs
```

将用户 ID 加入私服白名单（公共模式相同命令用于取消黑名单）：

```sh
node central-access.mjs allow usr_用户完整全局ID https://私服地址
node central-access.mjs deny usr_用户完整全局ID https://私服地址
```

本机开发脚本的管理员密钥保存在 `.artifacts/central-dev/admin-token`，CLI 可读取该文件，源码及客户端设置不包含密钥。远端配置必须使用 HTTPS 反向代理；直接远端 HTTP 被客户端拒绝。

首版限制：每用户最多 500 个好友/申请、40 个群，每群最多 20 人、50 个包版本；单个自定义事件最多 32000 字符，服务器暂存预算 512 MiB。尚未实现公网运营所需的集群、端到端加密、完整限流/账号恢复、群多管理员与安全可执行插件沙箱。

## 验收

新增协议与服务测试覆盖签名认证、私服白名单、公共黑名单、跨服隔离、离线队列重启恢复、按收件人 ACK 清除、防重、审批权限和并发游戏校验。客户端测试覆盖身份稳定、附件校验和旧界面保存不能擦除已收件消息。

`pnpm verify:central-ui` 启动两个独立客户端与临时服务，验证互加好友、双向消息、离线重连、群创建、审批分发、接龙/井字棋同步、侧栏插件启停、通用群通道、文件和按住语音。CI 在 Windows 对开发版和目录版执行，Linux 验证服务、协议、单测和独立服务发布目录。
