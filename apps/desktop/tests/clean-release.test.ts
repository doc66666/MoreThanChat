import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

it('installs only the central transport in a normal client', async () => {
  vi.stubGlobal('window', { moreThanChat: { demoPluginsEnabled: false } })
  const { pluginRuntime } = await import('../src/renderer/src/plugin-host')
  expect(pluginRuntime.list().map(p => p.manifest.id)).toEqual(['builtin.central'])
})

it('keeps example plugins available only in explicit QA mode', async () => {
  vi.stubGlobal('window', { moreThanChat: { demoPluginsEnabled: true } })
  const { pluginRuntime } = await import('../src/renderer/src/plugin-host')
  expect(pluginRuntime.list().map(p => p.manifest.id)).toEqual([
    'builtin.central', 'example.workspace-card', 'builtin.local-demo', 'example.quick-greeting',
  ])
})

it('packages runtime files rather than sources, test fixtures or user profiles', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  expect(manifest.build.files).toEqual(['dist-main/**/*', 'dist-renderer/**/*', 'assets/**/*', 'package.json'])
})
