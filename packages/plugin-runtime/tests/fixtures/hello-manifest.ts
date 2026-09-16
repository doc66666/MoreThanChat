import type { PluginManifestV1 } from '../../src/index.js'

export const fixtureManifest = {
  manifestVersion: 1,
  id: 'test.hello',
  version: '1.0.0',
  displayName: 'Fixture Hello',
  description: 'A real dynamically imported test plugin.',
  targets: ['pc-ui'],
  engine: { moreThanChat: '^0.1.0' },
  permissions: [],
  services: { requires: ['test.actions'] },
} as const satisfies PluginManifestV1
