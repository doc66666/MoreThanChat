import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PluginManifestV1 } from '@more-than-chat/plugin-runtime'
import { timeToolPlugin } from '@more-than-chat/plugin-time-tool'
import { InstalledStaticToolStore, restoreInstalledStaticTools } from '../src/installed-static-tools'
import { PluginDraftService } from '../src/plugin-drafts'
import { HostPluginService } from '../src/plugin-service'
import { installConfirmedTextTool } from '../src/static-tool-install'

const directories: string[] = []
const executed = '__mtcDraftSourceExecuted'

afterEach(async () => {
  Reflect.deleteProperty(globalThis, executed)
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('installed declarative text tools', () => {
  it('restores the tool and its enabled state without executing draft source', async () => {
    const directory = await makeDirectory()
    const store = new InstalledStaticToolStore(directory)
    const marker = 'persisted-note-text'
    const first = new HostPluginService(1, [])
    await first.start()
    const drafts = draftService(directory, first)
    Reflect.deleteProperty(globalThis, executed)
    await drafts.create({ manifestJson: manifest('example.script'), source: `globalThis.${executed} = true\n` })
    const script = await installConfirmedTextTool({
      drafts, plugins: first, store, draftId: 'example.script', confirmed: true,
    })
    expect(script.installed).toBe(false)
    expect(Reflect.get(globalThis, executed)).toBeUndefined()

    const source = JSON.stringify({ kind: 'host-text-tool', toolId: 'note', label: '便签', text: marker })
    await drafts.create({ manifestJson: manifest('example.note'), source })
    const installed = await installConfirmedTextTool({
      drafts, plugins: first, store, draftId: 'example.note', confirmed: true,
    })
    expect(installed.installed).toBe(true)
    const file = path.join(directory, 'installed-static-tools', 'example.note.json')
    const saved = await readFile(file, 'utf8')
    expect(saved).toContain(marker)
    expect(saved).not.toContain('globalThis')
    expect(saved).not.toContain('"kind"')
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
    await first.stop()

    const restored = new HostPluginService(2, [])
    await restored.start()
    await restoreInstalledStaticTools(store, restored)
    await expect(restored.invoke('example.note', 'note')).resolves.toMatchObject({ generation: 2, text: marker })
    await restored.setEnabled('example.note', false)
    await store.setEnabled('example.note', false)
    await restored.stop()

    const disabled = new HostPluginService(3, [])
    await disabled.start()
    await restoreInstalledStaticTools(store, disabled)
    expect(disabled.catalog().plugins[0]).toMatchObject({ id: 'example.note', status: 'inactive', tools: [] })
    await expect(disabled.invoke('example.note', 'note')).rejects.toMatchObject({ code: 'TOOL_UNAVAILABLE' })
    await disabled.stop()
    expect(Reflect.get(globalThis, executed)).toBeUndefined()
  })

  it('keeps the previous tool when a save or a conflicting id fails', async () => {
    const directory = await makeDirectory()
    const store = new InstalledStaticToolStore(directory)
    const marker = 'original-static-text'
    const plugins = new HostPluginService(4)
    await plugins.start()
    const drafts = draftService(directory, plugins)
    await drafts.create({
      manifestJson: manifest('example.note'),
      source: JSON.stringify({ kind: 'host-text-tool', toolId: 'note', label: '便签', text: marker }),
    })
    expect((await installConfirmedTextTool({
      drafts, plugins, store, draftId: 'example.note', confirmed: true,
    })).installed).toBe(true)
    const before = await readFile(path.join(directory, 'installed-static-tools', 'example.note.json'), 'utf8')

    const again = await installConfirmedTextTool({
      drafts, plugins, store, draftId: 'example.note', confirmed: true,
    })
    expect(again.installed).toBe(false)
    expect(again.issues.map(issue => issue.code)).toContain('INSTALLED_ID')
    expect(await readFile(path.join(directory, 'installed-static-tools', 'example.note.json'), 'utf8')).toBe(before)
    await expect(plugins.invoke('example.note', 'note')).resolves.toMatchObject({ text: marker })

    const broken = new BrokenStore(directory)
    await drafts.create({
      manifestJson: manifest('example.other'),
      source: JSON.stringify({ kind: 'host-text-tool', toolId: 'other', label: '另一条', text: 'should-not-remain' }),
    })
    const failed = await installConfirmedTextTool({
      drafts, plugins, store: broken, draftId: 'example.other', confirmed: true,
    })
    expect(failed.installed).toBe(false)
    expect(failed.summary).toContain('撤回')
    expect(plugins.catalog().plugins.map(plugin => plugin.id)).toEqual(['builtin.time-tool', 'example.note'])
    await expect(readFile(path.join(directory, 'installed-static-tools', 'example.other.json'))).rejects.toMatchObject({ code: 'ENOENT' })

    await store.save({
      v: 1,
      enabled: true,
      manifest: staticManifest('builtin.time-tool'),
      tool: { id: 'current-time', label: '当前时间', text: 'replaced-time' },
    })
    const restarted = new HostPluginService(5)
    await restarted.start()
    await restoreInstalledStaticTools(store, restarted)
    expect((await restarted.invoke('builtin.time-tool', 'current-time')).text).not.toBe('replaced-time')
    expect((await restarted.invoke('example.note', 'note')).text).toBe(marker)

    const ignored = path.join(directory, 'installed-static-tools', 'example.bad.json')
    const hostileRecord = { v: 1, enabled: true, source: `globalThis.${executed} = true`, manifest: {}, tool: {} }
    await writeFile(ignored, `${JSON.stringify(hostileRecord)}\n`)
    await restoreInstalledStaticTools(store, restarted)
    expect(Reflect.get(globalThis, executed)).toBeUndefined()
    expect(restarted.catalog().plugins.map(plugin => plugin.id)).toEqual(['builtin.time-tool', 'example.note'])
    await plugins.stop()
    await restarted.stop()
  })
})

class BrokenStore extends InstalledStaticToolStore {
  override save(): Promise<void> {
    return Promise.reject(new Error('disk full'))
  }
}

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'mtc-static-tools-'))
  directories.push(directory)
  await mkdir(path.join(directory, 'installed-static-tools'), { recursive: true })
  return directory
}

function draftService(directory: string, plugins: HostPluginService): PluginDraftService {
  return new PluginDraftService({
    dataDir: directory,
    installedPlugins: () => plugins.catalog().plugins.map(plugin => ({
      id: plugin.id,
      version: plugin.version,
      displayName: plugin.displayName,
      status: plugin.status,
    })),
  })
}

function manifest(id: string): string {
  return JSON.stringify(staticManifest(id))
}

function staticManifest(id: string): PluginManifestV1 {
  return {
    manifestVersion: 1,
    id,
    version: '0.1.0',
    displayName: id === timeToolPlugin.manifest.id ? timeToolPlugin.manifest.displayName : '便签',
    description: '返回一段固定文本。',
    targets: ['pc-host'],
    engine: { moreThanChat: '^0.1.0' },
    permissions: [],
    services: { requires: ['host.tools'] },
  }
}
