# 消息渲染插件验收（2026-11-08）

本轮把单条消息、正文分派、Markdown、纯文本和附件视图接入现有 Cordis 应用组合。默认实现与用户渲染插件走同一条注册、替换、停用及热更新路径。自定义格式注册 `message.body.<format>`，无需替换整条消息时间线。默认气泡继续提供复制、引用、转发、撤回和回执。

新增可选示例「HTML 消息卡片」：在插件示例库添加，打开好友或群聊，点击「写卡片」，编辑摘要、HTML 和预览后发送。未安装渲染器的接收方显示摘要，安装后重绘已有消息。自定义格式使用 `content:{format,version,body}`，经聊天接口、中心服务器、本机存储、离线队列和转发保留。AI 的聊天工具 schema 与内置作者契约同步补充了字段和用法。

## 真实客户端检查

`node scripts/verify-message-renderers.mjs` 使用两个隔离身份、真实构建后的 Electron 客户端及本机中心服务器：

- 从普通输入框发送 Markdown，双端都显示粗体和表格。
- 从示例的实际编辑／发送界面发送 HTML；接收方未安装时显示摘要，安装后确认 iframe 内确实呈现标题与正文，并保留消息操作。
- 消息 HTML 不执行其中的脚本或外部图片请求；这是该示例的呈现方式，交互能力由安装的可执行渲染插件实现。
- 切换明暗主题，卡片文档的文字和背景随客户端一起变化；保存两种主题的真实窗口截图。
- 同 ID 草稿安装新版，历史卡片立即更新且只有一个实例；用户插件包装内置 Markdown，移除包装后恢复默认渲染。
- 故意让正文渲染抛错，只有该正文回到摘要，聊天输入框仍可用；修正版恢复正常。
- 停用后重启仍显示摘要，重新启用恢复保存的 HTML。
- 引用使用摘要，转发到群保留格式正文；撤回删除原消息正文，已独立转发的消息保留。
- 接收方离线时发送，重启后送达并渲染；在最新位置阅读后未读数归零。

最终报告与截图：`.artifacts/message-renderers-2YGLDh/report.json`，同目录 `01-fallback.png`、`02-html-rendered.png`、`02-html-dark.png`、`03-forwarded-group.png`。测试过程中修正了验收脚本对隔离 iframe CDP 目标的访问，以及草稿刷新后再操作当前修订的等待条件。

## 现有功能回归

- `verify-chat-experience.mjs`：进入会话定位、最早未读、返回最新、滚动阅读、后台发送不误清未读、昵称同步、内置 AI 读取图片／文件和发送、切服重连，以及插件停止后的发送失效均通过。模型为本机确定性测试服务。
- `verify-chat-attachments.mjs`：三端完成草稿分享、群审批、成员载入、图片／文本／二进制读取、原文件另存为、离线投递及损坏图片处理。旧脚本补上进入通讯录「申请」页后再审批的操作。
- `verify-bundled-examples.mjs`：原有四个效率／游戏示例安装、草稿复制、群与私聊同步、第三人换座、停用／更新／卸载、重启和小窗遮挡下的未读行为通过；示例库包含新增第五项 HTML 卡片。
- `verify-composition-ui.mjs`：默认视图与服务的替换、AI 流式回复期间重绑、Main／Host 源码热更、停用和重启恢复、卸载接回默认功能，以及重连后双向聊天均通过，日志为 `.artifacts/message-renderers-composition-regression.log`。

回归日志分别位于 `.artifacts/message-renderers-chat-regression.log`、`message-renderers-attachments-regression.log` 和 `message-renderers-examples-regression.log`。示例回归报告位于 `.artifacts/examples-ui-IS003T/report.json`。

## 自动化与兼容

- 全量 `pnpm test`：692 项通过，2 项按原配置跳过；本轮新增 6 项契约、投递与渲染测试。
- 类型检查、桌面／Host 构建、协议 schema 一致性和 `git diff --check` 通过。
- 测试包含同一发送 ID 不可改写正文、旧服务器明确报错但保留内容、升级后原样重试，以及撤回后的旧快照不能复活正文。
- 新增 `pnpm verify:message-renderers` 入口及 CI 源码／打包目录验收配置；本轮实际执行的是本机构建，远端 CI 和发行包尚未运行本轮代码。
- 扩展格式要求服务器 `/v1/ping` 声明 `message-content-v1`；普通文字和默认 Markdown 无此新增要求。本轮没有部署云服务器。

没有使用外部模型额度，没有修改正常身份数据，没有推送或发布。插件接口说明见 [应用组合](application-composition.md)，使用方式见 [可选示例](../examples/bundled/README.md)。
