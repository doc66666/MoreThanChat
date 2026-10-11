import {
  chatTransportsServiceId,
  type TransportRegistry,
  type ChatTransportPlugin,
} from '@more-than-chat/chat-core'
import {
  definePlugin,
  type PluginManifestV1,
} from '@more-than-chat/plugin-runtime'
export const centralTransport: ChatTransportPlugin = {
  id: 'builtin.central',
  version: '0.1.0',
  displayName: '中心服务器传输',
  create: () => ({
    id: 'builtin.central',
    displayName: '中心服务器传输',
    async connect() {
      if ((await window.moreThanChat.getServerState()).status !== 'connected')
        throw new Error('请先连接中心服务器')
    },
    async disconnect() {},
    async send(input) {
      return window.moreThanChat.sendCentralMessage({
        conversationId: input.conversationId,
        clientMessageId: input.clientMessageId,
        text: input.text,
        ...(input.attachmentId ? { attachmentId: input.attachmentId } : {}),
      })
    },
  }),
}
export const centralTransportManifest = {
  manifestVersion: 1,
  id: 'builtin.central',
  version: '0.1.0',
  displayName: '中心服务器传输',
  description: '好友、群聊与群插件同步；网络凭据只由主进程持有。',
  targets: ['pc-ui'],
  engine: { moreThanChat: '^0.1.0' },
  permissions: ['server.transport'],
  services: { requires: [chatTransportsServiceId] },
} as const satisfies PluginManifestV1
export const centralTransportPlugin = definePlugin({
  manifest: centralTransportManifest,
  activate(context) {
    context.effect(
      context
        .getService<TransportRegistry>(chatTransportsServiceId)
        .register(centralTransport),
    )
  },
})
