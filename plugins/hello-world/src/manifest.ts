import type { PluginManifestV1 } from '@more-than-chat/plugin-runtime'

export const helloWorldManifest = {
  manifestVersion: 1,
  id: 'example.quick-greeting',
  version: '0.1.0',
  displayName: '快捷问候',
  description: '在消息输入框中提供一键问候动作。',
  targets: ['pc-ui'],
  engine: { moreThanChat: '^0.1.0' },
  permissions: [],
  services: { requires: ['ui.composer-actions'] },
} as const satisfies PluginManifestV1
