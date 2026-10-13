# DS 实时群插件验收（2026-10-13）

## 结论：未通过，创作阶段被现有契约阻断

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
