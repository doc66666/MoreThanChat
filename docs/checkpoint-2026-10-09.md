# 开发检查点（2026-10-09）

本检查点用于在模型额度耗尽后保留当前可恢复状态。真实 API 凭据没有写入仓库、环境文件、日志或 Git 历史；实时测试结束后已清理本地保存的 Key。

## 当前已完成

- Windows Electron 桌面端聊天 UI 与 PC Host 进程通信。
- OpenAI 兼容模型接口，支持 JSON/SSE、正常结束校验、超时/截断/取消处理。
- More AI 会话中的工具循环：读取契约、创建草稿、校验、诊断、修订。
- 受限声明式插件 MVP：固定文本、输入追加、大写/小写/trim 转换；安装、更新、启停和重启恢复均由用户确认。
- 失败更新保留旧版本，后续修订号从已保留版本最大值继续分配。
- Electron Main 通过 `safeStorage` 加密保存模型 Key；Host 只能通过私有凭据 RPC 读取，Renderer 不可读取。
- Host 协议 JSON Schema 与 TypeScript 定义已同步，保留 Android 后续接入所需的协议边界。
- CI 已明确拒绝目录版不需要的 `electron-winstaller` 构建脚本，修复标准 `pnpm install --frozen-lockfile` 的未决脚本失败。

## 本地验证结果

- `pnpm typecheck`：通过。
- `pnpm test`：通过；桌面端 23 个测试、PC Host 34 个测试，其他工作区测试也通过。
- `pnpm build`：通过，Host 资源已生成到 `.artifacts/host-resources`。
- `node scripts/verify-protocol-schema.mjs`：通过。
- `node scripts/verify-ai-ui.mjs`：通过；覆盖聊天工具循环、用户确认、转换执行、加密凭据恢复、重启恢复和清除 Key。
- `test-live-ai` 已用真实 DeepSeek 完成生成、修订、安装、执行和恢复验证；后续不要在无额度时重复运行实时脚本。

## 下一步

1. 将本地检查点推送到远端，并观察修复后的 Windows CI。
2. 在有额度时再次做一次短的真实 API 回归，重点确认桌面 UI 端到端流程，不重复长循环。
3. 增加真实插件包签名/内容寻址、权限模型、SQLite 持久化和 Android Host 的同协议实现。
4. 完善产品级错误提示、费用/Token 展示和发布签名。

构建产物和临时测试数据在 `.gitignore` 中，不属于源码检查点。

2026-10-10 的继续开发与目录版验收见 [阶段验收记录](stage-acceptance-2026-10-10.md)。
