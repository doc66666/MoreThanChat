# DeepSeek Harness / Cordis 调研记录

更新日期：2026-10-14。

## 2026-10-14：按最新上游纠正插件目标

已 fetch `deepseek-ai/deepseek-harness` 的 `origin/master`，核对提交 `d743267388641bc76f17c45ce8b4c231aed1d32c`（0.2.1-alpha.2）。以下旧快照仍保留供追溯，不再代表上游当前能力。研究目录工作树没有切换；最新文件通过 `git show origin/master:<path>` 读取。

- 最新 [`tool-cordis`](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/extensions/tool-cordis/README.zh.md) 主要提供只读 API 检查，创造模式配合 Plugin Manager 和随附技能编写、安装插件；不是旧快照的七个临时工具方案。
- [`Plugin Manager`](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/boot/plugin-manager/README.zh.md) 管理 profile 中持久化组合包、启停和配置；支持本地路径与包来源，Host 代码在宿主进程执行，依赖构建脚本须单独授权。符合 Cordis 生命周期不等于恶意代码沙箱。
- [`Slots`](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/docs/subsystems/slots.zh.md) 以唯一内建 root、插件声明的后代、替换优先级和生命周期构成整棵界面，不是固定九个可添加挂件的位置。Host/Client API 仍属于各自宿主，不能宣称任意 Harness 插件无需适配即可在 MoreThanChat 运行。
- MoreThanChat 的目标因此明确为：可执行 Host/Client 插件包、运行时能力查询、可替换默认界面和插件自定义子区域、用户同意的本地加载、热切换／回退与宿主恢复。旧 JSON 群插件是兼容的一种形式，不是永久能力上限。

本次先实现 `ui.surfaces` 的 root 替换／包装、任意命名子区域、优先级恢复和递归保护，并让 PC UI 使用现有 Cordis 生命周期适配器。测试验证完整根视图替换及卸载恢复，但尚未接通用户磁盘可执行包安装、AI 写入该包、群审批分发和独立进程恢复。不能把这个组合层称作上述完整闭环，也不能把它宣称为 Harness 包格式或 API 的直接兼容层。

用户确认的非目标：不提供业务数据托管、自动备份、自动插件数据迁移或客户端自动更新。已存在的手动备份保留为可选功能，不是发行前置条件。离线转发暂存与通信所需的旧协议状态不等于业务备份；不为调整路线删除现有用户数据。远程连接维持标准 HTTPS/TLS 与现有身份认证，不自创简单加密算法，不把 TLS 宣称为端到端加密。installer 和 zip 应在完整插件链路及传输扩容完成后提供，用户自行从 GitHub 下载更新。

实现基线补充（2026-10-07）：应用目前使用 `@cordisjs/core 3.18.1` 的固定 npm 产物，来源提交 `4658414e9414464ff1d08d076882fb66c1a3bb1c`；下表的 4.0 RC 是研究快照。为遵循稳定优先原则，4.0 的 Fiber API 没有进入插件 ABI，实际适配层使用 3.18.1 的 Scope 并自行保持失败回滚/清理重试契约。详见 [Cordis 适配与 CI 基线](runtime-cordis.md)。

## 本地快照

参考源码位于 `.research/`，被主仓库忽略，各自保留独立 Git 历史。

| 项目 | 上游 | 当前快照 | 结论 |
|---|---|---|---|
| DeepSeek Harness | `deepseek-ai/deepseek-harness` | `4e84901e6471b79ec0338099867ebb4606d12bb5` | 产品能力全部由 Cordis 插件组合；动态 AI 插件已有 host/client 双半运行器，但明确不构成安全边界 |
| Cordis | `cordiverse/cordis` | `00278924a984fedfaffb4bc3d5eb7d8e76215643` | 核心提供依赖驱动的生命周期、可逆 effect、作用域服务、配置重组与 HMR |

参考入口：

- [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)
- [Cordis 官方仓库](https://github.com/cordiverse/cordis)
- [Cordis 论文仓库](https://github.com/cordiverse/paper)
- [Android 动态代码加载安全说明](https://developer.android.com/privacy-and-security/risks/dynamic-code-loading)
- [Google Play 设备与网络滥用政策](https://support.google.com/googleplay/android-developer/answer/16559646)

## Cordis 值得复用的部分

1. **Fiber 生命周期**：插件由 `PENDING → LOADING → ACTIVE`，卸载走 `UNLOADING → DISPOSED`；依赖消失时消费插件自动卸载，依赖恢复后重新激活。
2. **服务而非实现耦合**：插件只声明 `inject` 的服务键，不依赖具体提供方，因此模型、存储、消息传输、UI 扩展都能替换。
3. **可逆副作用**：监听器、子插件、服务注册和自定义资源都归属当前 Fiber；卸载时回滚，这是可靠热更新的基础。
4. **配置即组合**：稳定 entry id 让配置更新只重组变化的子树；`isolate` 可给不同会话或账号提供独立服务域。
5. **类型化事件与 waterfall**：观察、并行、串行、短路和中间件式决策都有明确语义，适合权限、审计、模型请求和消息发送流水线。

## Harness 值得借鉴的部分

1. **能力 seam**：每项能力分成 Service Definition、Provider、Consumer。文件系统、模型、存储和 UI 都可以替换提供方。
2. **追加式事件日志**：模型可见内容必须能从日志重建。会话恢复、回放、fork、同步和调试都基于同一事件流。
3. **Host / Client 插件双半结构**：Node 侧提供能力，浏览器侧贡献 UI；运行前由用户批准，停止后两侧一起撤销。
4. **不可变插件版本**：一次定义产生不可变版本；更新是创建新版本并切换指针，而不是原地修改运行中的代码。
5. **模型写插件闭环**：inspect → define → run → diagnose → define revision → update，工具错误直接给出模型可行动的修复信息。
6. **HMR 安全测试**：注册表贡献必须测试“dispose Fiber 后贡献完全消失”，这应成为我们的插件 SDK 合规测试。

## 不能直接照搬的部分

- Harness 的动态 host 插件使用 `node:vm`，官方说明它只隔离全局变量，不是安全边界；异步代码还能逃出同步超时。面向普通用户时不能把它当作恶意代码沙箱。
- 动态定义仅存在进程内，重启即丢失；MoreThanChat 需要签名包、版本库、安装记录、回滚点和崩溃隔离。
- Cordis 与 Harness 都在快速迭代。Harness 自己维护了带事务回滚、生命周期加固和 Windows HMR 修复的 Cordis 分支。因此业务层不能直接散布 Cordis API，必须通过 `runtime-cordis` 适配层隔离。
- Cordis 官方 HMR 依赖 Node loader 内部机制，只适合 PC host 开发态。Android 必须使用独立插件运行器和更新协议。
- Android 官方强烈不建议从 APK 外加载可执行代码；Google Play 禁止从非 Play 来源下载 dex/JAR/so。解释执行的 JavaScript 可以存在，但仍必须遵守政策，并且不得通过危险的 WebView bridge 获得任意 Android API。

## 当前依赖策略

第一阶段不 fork Harness，也不把它作为产品运行时整体嵌入。我们复用设计与少量稳定包：

- Cordis 只在 `packages/runtime-cordis` 内出现，并冻结已审计的精确版本/提交；升级必须通过契约测试，不自动追随上游。
- AI 接入实现自己的 `ModelProvider` seam，优先支持 OpenAI-compatible API；DeepSeek 只是一个 provider。
- Harness 作为行为参考和测试样例来源；真正需要移植的代码逐项审计许可证、依赖与安全边界。
- PC 采用 Electron，使 Cordis/Harness 风格的 Node host 运行在原生目标环境；不再引入 Tauri↔Node sidecar 的跨语言故障面。
- Phase 0 对当前上游 Cordis 与 DeepSeek 加固版本执行同一组生命周期契约测试，选择通过项更多的一份作为冻结基线；此后只做受控升级或维护最小补丁集。
