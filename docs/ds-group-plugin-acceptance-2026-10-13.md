# DS 实时群插件验收（2026-10-13）

## 第二轮：真实发行版 UI 验收进行中（17:40 起）

用户已明确空出电脑，允许恢复桌面验收。本轮基线 `07326b3`；使用 computer-use 操作三个独立 Windows 目录版客户端，不使用 CDP、preload 直调或内置井字棋模板冒充用户闭环。

### 隔离环境和真实产物

- 用户数据根目录：`C:/Users/51487/AppData/Local/MoreThanChat-Acceptance/group-ui-1791884404562`，三个 profile 为 `author`、`admin`、`player`。日常用户数据未改动。
- 中心地址 `http://127.0.0.1:64559`，服务器 ID `srv_3dbaaf98-1f89-47ac-bfb2-6d352b3f4af7`；启动脚本 `scripts/launch-group-acceptance.mjs` 只建立隔离服务和启动客户端，不代做产品操作。
- 通过实际联系人 UI 完成认证、好友申请及接受，管理员 A 创建三人群「DS插件全生命周期验收群」（`grp_506b62ec-bd4c-43d9-b144-22132068fc28`）。作者 B 是普通成员，玩家 C 是另一普通成员。
- 作者 B 在 More AI 聊天中调用真实 `https://api.deepseek.com` / `deepseek-flash`；用户授权 Key 由产品凭据存储加密保存，不写入本报告、脚本或 Git。
- 真实草稿目录 `author/host-private/plugin-drafts/ds.online-ttt/`：`revision-1.json` 为 0.1.0，`revision-2.json` 为 0.1.1。模型实际调用 create/validate，修订轮还调用 diagnose；不是人工写好再冒充模型输出。
- 两轮 UI 报告用量分别 19,809 tokens（输入 11,207 / 输出 8,602，3/3 次请求）、46,532 tokens（输入 42,602 / 输出 3,930，4/4 次请求）。这是 API 报告的用量，不推算费用或余额。

### 已完成的真实 UI 步骤

1. B 创建第一版并在插件草稿面板选择本群、聊天详情侧栏，再确认提交。
2. A 收到完整包审批卡片，第一包摘要 `58d96e92a7a2c70021f41509d8cfaf7db3a7e9a929437f5f0c1ab0e5289e1dc2`；A 拒绝后，B 的申请记录显示「已拒绝，可修订后再次申请」。C 的群界面没有出现被拒绝插件。
3. 第一版实际存在问题：网格视图把动作输入 `event.cell` 当作渲染索引，占座后计算报错；文本全部静态，缺少可见轮次和胜负。以真实文件复现后，通过 B 的聊天把问题交回 DS，未手工修补模型产物。
4. DS 写出第二版：视图改用 `item/index`，动态显示座位、当前回合、本人身份和胜负，两位就座才允许落子。B 再次提交，界面禁止重复待审申请。
5. A 收到并批准第二包，中心包版本 v2（不同于 manifest 0.1.1），摘要 `b1179c0c656eb06285a5c74cd944be9da573285313d8171c4524d0bf4ccf0449`。待审列表清空。
6. 实际发现 CSS 错误：空 UiSlot 的隐藏规则只识别运行中的 widget，将首次授权 gate 一并隐藏，导致 C 看不到载入入口。已修复并加入源码级回归测试；同时修复好友申请按钮挤窄、审批包长 UID/描述溢出。
7. 关闭三个测试客户端，重新打包，再使用原 profile 启动。身份、群和已批准包恢复；C 的真实界面现在正确出现「管理员已批准」「确认载入本机」「暂不载入」，**没有自动运行棋盘**。

### 独立规则检查（不是 UI 对局）

`scripts/audit-generated-tic-tac-toe.mjs <revision-2.json>` 从真实草稿读取程序，只操作内存副本：237 次动作/拒绝检查通过，覆盖 X 的八条获胜路线、O 获胜、平局、未坐满不能开局、一个人不能占两席、旁观者/非成员/抢回合/重复格/非法索引/结束后落子拦截，以及参赛者重开和旁观者不得重开。每次有效动作后，按三个观察者分别计算所有可见文本、按钮及网格，渲染上下文始终 `event={}`。

### 当前暂停点及未完成项

computer-use 技能禁止代操作应用权限请求，因此本机载入交由用户亲手完成。用户随后反馈已实际对局、确认同步与胜负正常，并发现重开不能换人。只读复核三端及中心 SQLite：三端都保存同一组 25 个事件（joinX 1、joinO 1、play 21、again 2）；最终 revision=25、round=3、winner=X，三端与中心完全一致，中心待投递队列为 0。X 为玩家 C，O 为管理员 A；作者 B 为旁观者。三端授权记录均为 loaded，缓存程序与真实 DS revision-2 一致，摘要匹配。

换人缺口属于插件：again 未清空 x/o，也没有退座动作。只在内存副本为 again 添加清空座位，即可让第三人加入；没有修改用户正在使用的插件或服务器状态。此次不将规则层实验充当实际更新 UI 验收。

- [x] 用户亲手载入、双端落子及结束同步；数据库对照通过。平局场景只有独立规则检查证据，不单列为真实桌面通过。
- [ ] A 拒绝载入不影响其他成员；载入后旁观规则。
- [ ] 本机停用/重新载入，以及对局中断线重连、客户端重启恢复。
- [ ] 再由 DS 修订更新，旧版审批期间继续工作，新版批准后重新授权及状态重置。
- [x] 首版后主线新增上下文诊断，能识别视图误用 `event` 和未绑定 `item/index`；真实 revision-1 复验定位三处错误，revision-2 无此类错误。不是完整行为正确性证明，胜负/换人等仍需测试。

全仓 `pnpm test`：446 通过、2 项平台条件跳过；`pnpm typecheck`、`pnpm package:dir`、`git diff --check` 通过。新增 CSS 测试仅验证源码规则，真实可见性以第 7 项桌面观察为证。仍不能宣布完整生命周期验收通过。

### v0.1.0 纯净发行基线

正常客户端只自动加载中心通信核心；演示 UI 插件、Host 时间工具和群模板入口仅在显式 QA 环境启用。正常新 profile 的 AI 默认需要真实 API 配置，已有用户设置/插件不强制更改。打包采用 dist-main / dist-renderer / package.json 白名单，测试资料留在 AppData，不从验收 profile 打包。纯净模式新增 5 项回归：全仓 451 通过、2 项平台条件跳过，类型检查通过。

## 第一轮历史结论：未通过，创作阶段被当时契约阻断

目标是普通群成员让 DeepSeek 在发行版用户级目录创作井字棋插件，再由用户提交管理员审批、分发给成员、成员自主确认载入并实时对局。没有使用内置井字棋模板替代 AI 创作，也没有修改生产代码让测试绕过限制。

代码基线：`21095d6`。本次完成代码审计、真实 DeepSeek Host 作者服务探测与相关回归测试；**未完成客户端端到端验收，没有实际创建群、审批或进行双端对局**。

## 实测环境与证据

- 启动 Windows 目录发行版 `.artifacts/desktop-release/win-unpacked/MoreThanChat.exe`，Host 显示已连接；没有修改日常用户数据。
- 独立用户级目录：`C:/Users/51487/AppData/Local/MoreThanChat-Acceptance/ds-group-1791871914791`；桌面 profile 为 `member`，独立 Host 接口探测目录为 `author-probe`。
- 测试中心服务器启动在 `127.0.0.1:52404`，但没有完成客户端身份连接或群成员配置。
- Windows UI 自动化在设置操作时出现临时窗口失效、窗口最小化的状态异常，未能可靠完成设置及聊天操作。该项记录为自动化受阻，不据此判定产品设置功能损坏。
- 随后直接调用现有 `ModelService`、`PluginDraftService`、`createAuthorToolExecutor`，并非通过客户端聊天 UI。探测代码来自本地构建，其 `model-service.js`、`author-tools.js`、`author-contract.js`、`plugin-drafts.js`、`static-text-tool.js`、`openai-compatible.js` 六个文件的 SHA-256 均与发行版 `resources/pc-host` 对应文件一致。
- 使用用户授权的既有 Key；模型列表请求 HTTP 200，实际模型 `deepseek-flash`；两次模型请求均 HTTP 200，总计报告 3234 token（输入 2362、输出 872）。凭据仅传给 DeepSeek 并在探测服务内存中保存，没有进入报告、命令参数、环境变量或磁盘配置。
- DS 实际调用一次 `inspect_drafts`，结果 installed 0 / drafts 0，然后明确说明契约不支持此需求；没有调用 `create_draft`，没有生成、安装或执行插件。
- 脱敏完整提示词、作者工具事件、回复、用量及最终草稿列表保存在上述用户级目录的 `author-probe-result.json`。该文件属于本机测试证据，不包含 Key，不加入 Git。
- 收尾已清除探测服务的内存凭据并停止本次启动的测试进程；用户级测试目录和证据保留，未删除原有用户数据。

提示词要求真实群网络插件、落子同步、轮次校验、胜负判断和重连恢复，禁止内置模板或固定文本替代；如果工具不足则准确说明阻断。不向模型提供虚构 SDK，也不将普通成员身份描述当作已完成真实身份认证。

## 流程逐项判定

| 环节 | 本次状态 | 证据 / 原因 |
|---|---|---|
| 发行版启动、独立用户目录 | 通过启动检查 | 桌面窗口显示 Host 已连接；profile 在 AppData 下 |
| DS API 及作者工具调用 | Host 接口探测通过 | 两次模型 HTTP 200，inspect_drafts 成功；不是 UI 闭环 |
| 普通群成员身份与上下文 | 未执行 | 未建立真实测试群；作者工具本身也没有群上下文 |
| DS 创建可运行的实时井字棋 | 阻断 | SDK 只允许三种文本声明；最终草稿数 0 |
| 用户提交该草稿申请管理员批准 | 未执行 / 缺入口 | 本群提交按钮只能生成固定模板描述，不接收 AI 草稿 |
| 分发实际生成的插件包 | 未执行 / 协议不足 | GroupPluginPack 只有模板元数据，无 AI 产物内容 |
| 每个成员首次自主确认载入 | 静态检查不符合 | 默认启用界面，只有事后停用/启用 |
| 双端落子、胜负、重连恢复 | 未执行 | 无可安装 AI 游戏产物，不能借内置模板宣布通过 |

## 缺口定位

1. `apps/pc-host/src/author-contract.ts` / `static-text-tool.ts`：只支持 `host-text-tool`、`composer-text-action`、`composer-transform-action`，只依赖 `host.tools`，无任意逻辑或群通信能力。
2. `apps/pc-host/src/author-tools.ts`：仅 inspect/create/validate/diagnose 四个工具；没有授权后的群上下文或群插件产物类型。安装仍要求用户确认，这个边界应保留。
3. `apps/desktop/src/renderer/src/plugin-host.ts`：**现有 `pc-ui` 运行时确实提供 `chat.network` 的 send/history/subscribe**。不能把 DS 回复中“没有群网络接口”扩大解释成全项目没有接口；准确问题是 AI 作者契约、可安装产物与这个运行时没有连通。
4. `apps/desktop/src/renderer/src/App.tsx` 的本群插件提交：硬编码 chain/tic-tac-toe/channel 三类，不是上传用户级 AI 产物。
5. `packages/central-protocol/src/index.ts` 的 `GroupPluginPack`：只有 id/version/displayName/kind/slot；当前审批和 digest 绑定的是这份描述，不是完整的生成代码包。
6. `apps/desktop/src/renderer/src/NetworkPanel.tsx`：`group-plugin-disabled:*` 缺省为 false，批准后直接呈现内置界面。需要显式的首次待确认状态，以及按包版本/摘要记录本机同意。
7. `apps/central-server/src/server.mjs`：井字棋棋盘、玩家分配和规则由中心服务器内置。现有模板同步不是 DS 生成逻辑的执行证明。

## 本次回归

- `pnpm --filter @more-than-chat/central-server exec vitest run tests/server.test.mjs -t 'isolates servers|approves immutable'`：2 通过，16 因筛选跳过。
- `pnpm --filter @more-than-chat/pc-host exec vitest run tests/author-tools.test.ts tests/plugin-drafts.test.ts`：9 通过。
- 这些测试验证现有隔离、审批元数据、并发接龙及草稿规则，不是新群游戏闭环测试，也不是全仓回归。

## 下一阶段及复验门槛

先设计受限的群插件产物和执行边界（可执行沙箱或足够表达游戏逻辑的声明式运行时），再接通作者契约、用户级草稿、用户确认提交、管理员审批、完整包分发与成员本机确认。不能简单向生成代码暴露整个 preload、文件系统或管理员权限；保留中心服务器对身份、群成员关系、审批版本和流量的强制校验。

复验需至少三名独立用户：群主、普通成员作者、另一普通成员。使用真实 DS 生成而非内置模板，记录产物摘要；验证拒绝/批准、审批前不可通信、批准后未载入不执行、一个成员拒绝不影响别人、同意后双端状态一致，以及非参与者/越权/重复落子、断线重连、重启后状态和插件更新重新确认。每个步骤必须从用户可见入口完成并留存证据；未实现的步骤明确标为未执行。
