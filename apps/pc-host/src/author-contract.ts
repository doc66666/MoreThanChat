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
  instructions: [
    'create_draft 的 manifestJson 和 source 都是 JSON.stringify 后的字符串，不是 JS/TS 源码。',
    '严格使用示例字段，不添加额外字段；id 使用小写字母数字、点或连字符。',
    'transform 对当前输入框文本执行操作并替换输入框；text-action 追加固定文本。',
    '创建后调用 validate_draft，失败时读取 diagnose_draft 并追加修订；用户确认安装，模型不能安装。',
    '更新使用相同 manifest id 和递增的语义版本；不要生成网络、文件、shell 或任意代码。',
  ],
} as const
