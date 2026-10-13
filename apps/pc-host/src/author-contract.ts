export const PLUGIN_AUTHOR_CONTRACT = {
  sdkVersion: 1,
  manifestExample: {
    manifestVersion: 1, id: 'example.my-action', version: '0.1.0', displayName: '我的动作',
    description: '描述这个插件的作用', targets: ['pc-host'], engine: { moreThanChat: '^0.1.0' },
    permissions: [], services: { requires: ['host.tools'] },
  },
  sourceExamples: [
    { kind: 'host-text-tool', toolId: 'note', label: '便签', text: '要插入的固定文本' },
    { kind: 'composer-text-action', actionId: 'signature', label: '署名', text: '我的署名' },
    { kind: 'composer-transform-action', actionId: 'uppercase', label: '转为大写', operation: 'uppercase' },
  ],
  transformOperations: ['uppercase', 'lowercase', 'trim'],
  groupPlugin: {
    manifestExample: {
      manifestVersion: 1, id: 'example.group-counter', version: '0.1.0', displayName: '群计数',
      description: '成员协作计数', targets: ['pc-ui'], engine: { moreThanChat: '^0.1.0' },
      permissions: ['chat.network'], services: { requires: ['chat.network'] },
    },
    sourceExample: {
      kind: 'group-state-machine', initial: { count: 0 },
      actions: { increment: { guard: true, updates: [{field:'count',value:{op:'add',args:[{ref:'state.count'},1]}}] } },
      view: { texts:[{ref:'state.count'}],buttons:[{label:'加一',action:'increment',enabled:true}],grids:[] },
    },
    expressions: '常量为 null/boolean/number/string 或常量表达式数组。引用 {ref:"state.field"}、actor（中心认证的当前用户 ID）、members（当前群成员 ID 数组）、event.cell（点击格子的从 0 开始索引）、item/index（数组谓词或格子上下文）。操作为 {op:名称,args:[表达式...]}。',
    operators: 'eq/ne 深度相等比较；and/or/not 严格布尔；if 条件/真/假三参数且惰性；add/sub/lt/lte 两数；get 数组/索引（越界返回 null）；length 数组长度；includes 数组/值；append 数组/值返回新数组；setAt 数组/索引/值返回新数组且索引必须有效；some/every/filter 数组/谓词，谓词内 item/index 对应本项。不支持任意对象常量表达式、变量赋值、函数或未列出的操作。',
    actions: 'initial 是共享状态初值（普通 JSON 对象）。actions 的每个动作含 guard 和 updates；guard 必须为 true 才执行。updates 为 {field:已有初始字段名,value:表达式} 数组，按顺序执行，后面的表达式看到前面的新状态。中心串行校验身份与状态版本，原子提交；失败不改变状态。不在本地预测写入。',
    view: 'view 含 texts 表达式数组、buttons 与 grids。button:{label:字符串,action:动作名,enabled:布尔表达式}。grid:{columns:1到8整数,cells:数组表达式,label:格子文字表达式,action:动作名,enabled:布尔表达式}；每格上下文有 item/index，点击发 event.cell。视图计算没有 event，严禁将动作 guard 中的 event.cell 直接复制到 grid.enabled，应改用 index/item。buttons 发空 event。必须在服务端 guard 重复校验权限/轮次/索引/状态，不能仅依赖 UI enabled。',
    gameLifecycle: '多人游戏应明确退座、结束后换人、参与者离群后的释放规则。新一局是否保留原席位由产品需求决定；不要默认永久锁定两名玩家。members 可用于判断原玩家是否仍是群成员，但不代表在线状态；当前没有定时器，不要承诺自动超时踢人。',
    lifecycle: '先 create_draft 再 validate_draft。用户在插件面板选择群并确认提交；管理员审批完整包；成员确认本机载入后才能操作。模型不能自行提交、批准或安装。不需要把群 ID/用户 ID 硬编码进源码。当前群成员上下文运行时注入。共享状态由中心保存并随重连恢复。新版批准后共享状态重置，成员需重新确认。',
    limits: 'source 不超过24000字符，最多24状态字段/16动作/每动作32更新/8文本/16按钮/4网格；数组最多64项、状态8000字符、每次状态动作10000步运算。仅 pc-ui；协议保持平台无关但 Android 尚未实现。多人游戏宜使用 join 动作让两位成员主动占座，避免自动选群主。用通用表达式定义规则和胜负，不选择内置 tic-tac-toe。',
  },
  instructions: [
    'create_draft 的 manifestJson 和 source 都是 JSON.stringify 后的字符串，不是 JS/TS 源码。',
    '严格使用示例字段，不添加额外字段；id 使用小写字母数字、点或连字符。',
    'transform 对当前输入框文本执行操作并替换输入框；text-action 追加固定文本。',
    '创建后调用 validate_draft，失败时读取 diagnose_draft 并追加修订；用户确认安装，模型不能安装。',
    '更新使用相同 manifest id 和递增的语义版本；群插件使用 groupPlugin 契约，网络仅经宿主 chat.network 代理，不生成 fetch/WebSocket、文件、shell 或 JS/TS 代码。',
  ],
} as const
