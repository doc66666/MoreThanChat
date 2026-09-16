import {
  TransportRegistry,
  chatTransportsServiceId,
  type ChatTransport,
  type ChatTransportPlugin,
  type OutgoingMessage,
  type SendReceipt,
} from '@more-than-chat/chat-core'
import { definePlugin, type PluginManifestV1 } from '@more-than-chat/plugin-runtime'

class LocalDemoTransport implements ChatTransport {
  readonly id = 'builtin.local-demo'
  readonly displayName = '本地演示传输'
  #connected = false

  async connect(): Promise<void> {
    this.#connected = true
  }

  async disconnect(): Promise<void> {
    this.#connected = false
  }

  async send(message: OutgoingMessage): Promise<SendReceipt> {
    if (!this.#connected) throw new Error('Transport is not connected.')
    await new Promise(resolve => setTimeout(resolve, 320))
    const isAssistant = message.conversationId === 'conversation-assistant'
    return {
      eventId: crypto.randomUUID(),
      acceptedAt: Date.now(),
      ...(isAssistant
        ? {
            reply: {
              senderId: 'more-ai',
              senderName: 'More AI',
              senderAvatar: 'AI',
              text: `收到：“${message.text}”\n\n当前是本地 transport 插件的演示回复。接入中心服务器或 AI API 时，聊天界面无需改动。`,
            },
          }
        : {}),
    }
  }
}

export const localTransportPlugin: ChatTransportPlugin = {
  id: 'builtin.local-demo',
  version: '0.1.0',
  displayName: '本地演示传输',
  create: () => new LocalDemoTransport(),
}

export const localTransportManifest = {
  manifestVersion: 1,
  id: 'builtin.local-demo',
  version: '0.1.0',
  displayName: '本地演示传输',
  description: '提供消息发送和本地演示回复。',
  targets: ['pc-ui'],
  engine: { moreThanChat: '^0.1.0' },
  permissions: [],
  services: { requires: [chatTransportsServiceId] },
} as const satisfies PluginManifestV1

export const localTransportRuntimePlugin = definePlugin({
  manifest: localTransportManifest,
  activate(context) {
    const transports = context.getService<TransportRegistry>(chatTransportsServiceId)
    context.effect(transports.register(localTransportPlugin))
  },
  healthCheck(context) {
    const transports = context.getService<TransportRegistry>(chatTransportsServiceId)
    if (!transports.get(localTransportPlugin.id)) throw new Error('Local transport contribution is missing.')
  },
})
