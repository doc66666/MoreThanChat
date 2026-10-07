import { definePlugin, hostToolsServiceId, type ContributionRegistrar, type HostTool } from '@more-than-chat/plugin-runtime'

export const timeToolPlugin = definePlugin({
  manifest: {
    manifestVersion: 1,
    id: 'builtin.time-tool',
    version: '0.1.0',
    displayName: '时间工具',
    description: '读取当前时间并插入输入框，无需网络或文件权限。',
    targets: ['pc-host'],
    engine: { moreThanChat: '^0.1.0' },
    permissions: [],
    services: { requires: [hostToolsServiceId] },
  },
  activate(context) {
    const tools = context.getService<ContributionRegistrar<HostTool>>(hostToolsServiceId)
    context.contribute(tools, {
      id: 'current-time',
      label: '当前时间',
      run: () => `当前时间：${new Date().toISOString()}`,
    })
  },
  healthCheck(context) { context.getService(hostToolsServiceId) },
})

export default timeToolPlugin
