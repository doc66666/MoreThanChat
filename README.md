# MoreThanChat
一切皆插件的聊天应用，或许你的企鹅已经过时了！

当前阶段：Windows 聊天、中心服务与插件扩展内测版。已有全局签名身份、好友/群聊、离线暂存与收件确认清除、群插件审批及同步。默认开发服务为 `http://localhost:8787`，可在设置切换同一程序运行的私服。AI 聊天与受限草稿创作功能继续保留。

用户在设置中配置 API、模型和 Key，在 More AI 会话中描述需要的插件，再到插件面板确认安装。当前支持固定文本、输入框文本追加，以及大写/小写/首尾空白转换。模型读取实际契约和样例，通过工具创建、校验与修订；用户掌握安装和更新决定。插件启停与版本会保存，失败更新可恢复旧版并继续提交修订。

聊天内核已接入 SQLite 事务存储，自动迁移旧会话并保留备份；退出前确认保存。AI 回复支持 Markdown、代码块、表格、失败/取消后重新生成，以及接口报告的 Token 用量。重试保留原问题和失败记录，不重复发送问题到会话列表。

人与人聊天已增加本机持久发送队列，离线时可排队，重连所属服务器后自动补发，使用原消息 ID 防重。支持送达/已读回执、按阅读位置处理未读、每会话草稿恢复、聊天记录搜索与定位、消息复制、置顶和免打扰。每个好友／群固定一个入口，不提供归档；删除好友、退出或解散群后移除关系入口，但历史记录仍留在本机，可通过搜索查看。好友申请可取消或拒绝，群可改名、邀请和移出成员、转让管理员。

插件可以注册侧栏、导航、消息区域、详情、输入区或浮层，也预留了可信插件替换输入区的能力。群成员可申请接龙、井字棋和通用同步通道，管理员批准后向同服群成员分发。加号支持文件与表情，右侧按住说话，文件和语音在中心会话内发送。

客户端提供暖白陶橙的白天模式、Tokyo Night Storm 夜间模式，以及跟随系统；设置中选择外观，左下方太阳/月亮按钮快速切换。会记住每个用户的选择，并统一聊天、插件、设置与窗口标题栏的配色。

设置 → 通知与后台：支持窗口不在前台时的新消息系统通知，默认不显示正文、不播放声音；可分别开启预览和声音。免打扰会话不提醒，同一会话的连续消息合并提醒，点击通知打开对应会话。可选“关闭窗口后继续接收”，或手动收起到托盘；托盘可重新打开和彻底退出。默认关闭窗口仍然退出，保存失败时保持窗口可见。真正退出、系统休眠或断网期间不承诺实时通知，未送达消息由中心保留，重连后补投。

Key 由 Electron Main 的系统加密服务保存，Host 通过私有 RPC 获取运行时凭据；不使用明文文件回退。当前远程分发是受限声明式包，任意可执行第三方 JS/TS 的沙箱、Android、端到端加密与正式签名安装器仍属后续阶段。

历史记录通过 SQLite 游标真正分页加载，默认每会话最近 50 条，支持加载更早／较新记录、搜索定位和回到最新消息。已取消整个聊天历史的 8 MiB 上限；分页保存是增量写入，不会删除未加载的历史。搜索使用本机 FTS5 trigram 索引筛选至少三字符的子串，短关键词走参数化子串查询。仍保留单页／单记录的安全边界。

新消息支持引用回复、定位来源、同服单条转发，以及本人两分钟内撤回。引用随输入草稿切换和重启恢复；转发复制文字或原附件，以独立新消息发送。中心保留来源与路由校验所需的 ID、摘要哈希及收件人元数据，不保留全部目标设备均已确认的正文。撤回通知离线暂存，客户端落盘后再确认；引用摘要也会被清除，但已转发、下载或复制的独立副本不保证删除。首次升级前已经送达且正文已清除的旧消息无法补生成可信来源校验，仍可搜索和复制。

联系人面板内的“身份与设备”支持密码加密身份备份、导入与本机身份切换。不同身份的聊天、插件、模型设置和界面存储隔离，导入不覆盖原空间。用同一份备份在另一台电脑导入、连接原服务器，即可恢复好友和群关系；登记后的新消息、自己的发送内容、已读与撤回按设备同步。中心为每个身份最多登记 8 台设备，离线设备仍有独立待收记录，全部目标设备确认后清除暂存正文；“已送达/已读”人数按用户统计，该用户任一设备确认即可计入。可移除不用的设备释放待收记录。身份备份不包含聊天历史、插件、API 密钥或设备 ID，不能找回中心已清除的历史。旧客户端在同身份启用多设备后需要升级。

## 当前可运行原型

仓库已经包含一个 Electron 桌面聊天原型，支持会话切换、搜索、新建会话、发送消息、本地持久化和插件启停。两个可信 UI 插件提供本地演示传输与快捷问候；独立 PC Host 运行时间工具插件，支持面板启停、结果写入输入框与崩溃后恢复启停选择。Renderer 保持沙箱与最小 Preload API。

```powershell
pnpm install
pnpm central:dev
# 另一个终端打开两个独立用户端：
pnpm demo:clients
# 常规单客户端开发：pnpm dev
```

验证：

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm verify:plugin-ui
pnpm verify:host
pnpm verify:protocol
pnpm verify:ai-ui
pnpm verify:chat-ui
pnpm verify:central-ui
pnpm verify:background-ui
pnpm verify:appearance-ui
pnpm central:package
pnpm package:dir
```

`pnpm package:dir` 在当前系统生成 unpacked 目录，并检查 Host 依赖位于 `resources/pc-host`、不在 `app.asar` 里。Linux 上的结果不是 Windows 安装包验收。

Windows CI 验证目录版中的聊天/插件/加密凭据恢复，成功后上传 `MoreThanChat-windows-x64` 产物；下载解压后运行 `MoreThanChat.exe`，需要保留整个目录。尚未签名，属于内测分发版本。

真实 API 测试需要交互输入 Key，不使用命令参数或提交到 Git：

```powershell
pnpm test:live-ai
# Windows 桌面真实模型验收：
pnpm build
node scripts/verify-ai-ui.mjs --live
```

- [架构与安全边界](docs/architecture.md)
- [插件运行时与示例](docs/plugin-runtime.md)
- [PC Host 协议与进程监督](docs/host-supervision.md)
- [Cordis 适配与 CI 基线](docs/runtime-cordis.md)
- [开发路线图](docs/roadmap.md)
- [AI 插件创作与加密凭据](docs/ai-plugin-mvp.md)
- [Windows 内测阶段验收与使用](docs/stage-acceptance-2026-10-10.md)
- [SQLite、Markdown、重试与 Token 阶段](docs/chat-core-stage-2026-10-10.md)
- [中心服务、群插件和手动双端测试](docs/central-and-plugin-stage-2026-10-11.md)
- [客户端主题与交互验收](docs/ui-appearance-2026-10-12.md)
- [DeepSeek Harness / Cordis 调研记录](docs/upstream-study.md)

更新本地参考源码：

```powershell
./scripts/update-upstreams.ps1
```
