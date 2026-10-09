import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PluginManifestV1 } from '@more-than-chat/plugin-runtime'
import { timeToolPlugin } from '@more-than-chat/plugin-time-tool'
import { InstalledStaticToolStore, restoreInstalledStaticTools, type StoredStaticTool } from '../src/installed-static-tools'
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
    const versionFile = path.join(directory, 'installed-static-tools', 'versions', 'example.note', 'version-1.json')
    const saved = await readFile(file, 'utf8')
    const sealed = await readFile(versionFile, 'utf8')
    expect(saved).toContain(marker)
    expect(saved).toContain('"revision":1')
    expect(sealed).toBe(saved)
    expect(saved).not.toContain('globalThis')
    expect(saved).not.toContain('host-text-tool')
    expect(saved).toContain('"kind":"text-tool"')
    if (process.platform !== 'win32') {
      expect((await stat(file)).mode & 0o777).toBe(0o600)
      expect((await stat(versionFile)).mode & 0o777).toBe(0o600)
      expect((await stat(path.dirname(versionFile))).mode & 0o777).toBe(0o700)
    }
    expect((await store.list()).map(record => record.revision)).toEqual([1])
    await first.stop()

    const restored = new HostPluginService(2, [])
    await restored.start()
    await restoreInstalledStaticTools(store, restored)
    await expect(restored.invoke('example.note', 'note')).resolves.toMatchObject({ generation: 2, text: marker })
    await restored.setEnabled('example.note', false)
    await store.setEnabled('example.note', false)
    expect(await readFile(versionFile, 'utf8')).toBe(sealed)
    expect(await readFile(file, 'utf8')).toContain('"enabled":false')
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
      revision: 1,
      enabled: true,
      kind: 'text-tool',
      manifest: staticManifest('builtin.time-tool'),
      tool: { id: 'current-time', label: '当前时间', text: 'replaced-time' },
    })
    await drafts.create({
      manifestJson: manifest('builtin.time-tool'),
      source: JSON.stringify({ kind: 'host-text-tool', toolId: 'current-time', label: '当前时间', text: 'replaced-time' }),
    })
    const restarted = new HostPluginService(5)
    await restarted.start()
    await restoreInstalledStaticTools(store, restarted)
    const replaced = await installConfirmedTextTool({
      drafts: draftService(directory, restarted),
      plugins: restarted,
      store,
      draftId: 'builtin.time-tool',
      confirmed: true,
    })
    expect(replaced.installed).toBe(false)
    expect(replaced.issues.map(issue => issue.code)).toContain('INSTALLED_ID')
    expect(restarted.isStaticInstall('builtin.time-tool')).toBe(false)
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

  it('keeps the first version immutable when a confirmed draft updates the tool', async () => {
    const directory = await makeDirectory()
    const store = new InstalledStaticToolStore(directory)
    const plugins = new HostPluginService(6, [])
    await plugins.start()
    const drafts = draftService(directory, plugins)
    const marker = 'version-one-text'
    const updated = 'version-two-text'
    await drafts.create({
      manifestJson: manifest('example.note'),
      source: JSON.stringify({ kind: 'host-text-tool', toolId: 'note', label: '便签', text: marker }),
    })
    expect((await installConfirmedTextTool({
      drafts, plugins, store, draftId: 'example.note', confirmed: true,
    })).installed).toBe(true)
    const versionFile = versionPath(directory, 'example.note', 1)
    const sealed = await readFile(versionFile, 'utf8')

    await drafts.create({
      manifestJson: manifest('example.note'),
      source: JSON.stringify({ kind: 'host-text-tool', toolId: 'note', label: '便签', text: updated }),
    })
    const unconfirmed = await installConfirmedTextTool({
      drafts, plugins, store, draftId: 'example.note', confirmed: false,
    })
    expect(unconfirmed.installed).toBe(false)
    expect(unconfirmed.issues.map(issue => issue.code)).toContain('CONFIRMATION_REQUIRED')
    expect(await readFile(versionFile, 'utf8')).toBe(sealed)
    await expect(plugins.invoke('example.note', 'note')).resolves.toMatchObject({ text: marker })

    await plugins.setEnabled('example.note', false)
    await store.setEnabled('example.note', false)
    const changed = await installConfirmedTextTool({
      drafts, plugins, store, draftId: 'example.note', confirmed: true,
    })
    expect(changed.installed).toBe(true)
    expect(changed.summary).toContain('已更新')
    expect(changed.catalog.plugins.find(plugin => plugin.id === 'example.note')).toMatchObject({ status: 'inactive', tools: [] })
    expect(await readFile(versionFile, 'utf8')).toBe(sealed)
    const current = JSON.parse(await readFile(currentPath(directory, 'example.note'), 'utf8')) as { revision: number; enabled: boolean; tool: { text: string } }
    expect(current.revision).toBe(2)
    expect(current.enabled).toBe(false)
    expect(current.tool.text).toBe(updated)
    expect(await readFile(versionPath(directory, 'example.note', 2), 'utf8')).toContain(updated)
    await expect(plugins.invoke('example.note', 'note')).rejects.toMatchObject({ code: 'TOOL_UNAVAILABLE' })
    await plugins.setEnabled('example.note', true)
    await expect(plugins.invoke('example.note', 'note')).resolves.toMatchObject({ text: updated })
    await plugins.stop()

    const restored = new HostPluginService(7, [])
    await restored.start()
    await restoreInstalledStaticTools(store, restored)
    expect(restored.catalog().plugins.find(plugin => plugin.id === 'example.note')).toMatchObject({ status: 'inactive', tools: [] })
    await expect(restored.invoke('example.note', 'note')).rejects.toMatchObject({ code: 'TOOL_UNAVAILABLE' })
    await restored.setEnabled('example.note', true)
    await expect(restored.invoke('example.note', 'note')).resolves.toMatchObject({ text: updated })
    expect(await readdir(path.join(directory, 'installed-static-tools', 'versions', 'example.note')))
      .toEqual(expect.arrayContaining(['version-1.json', 'version-2.json']))
    expect((await store.list()).map(record => record.tool.text)).toEqual([updated])
    await restored.stop()
  })

  it('restores the previous text when the next version cannot be saved', async () => {
    const directory = await makeDirectory()
    const store = new FailUpdateStore(directory)
    const plugins = new HostPluginService(8, [])
    await plugins.start()
    const drafts = draftService(directory, plugins)
    const marker = 'kept-after-failed-update'
    await drafts.create({
      manifestJson: manifest('example.note'),
      source: JSON.stringify({ kind: 'host-text-tool', toolId: 'note', label: '便签', text: marker }),
    })
    expect((await installConfirmedTextTool({
      drafts, plugins, store, draftId: 'example.note', confirmed: true,
    })).installed).toBe(true)
    await plugins.setEnabled('example.note', false)
    await store.setEnabled('example.note', false)
    const versionFile = versionPath(directory, 'example.note', 1)
    const sealed = await readFile(versionFile, 'utf8')
    const executed = '__mtcDraftSourceExecuted'
    Reflect.deleteProperty(globalThis, executed)
    await drafts.create({
      manifestJson: manifest('example.note'),
      source: `globalThis.${executed} = true\n`,
    })
    const script = await installConfirmedTextTool({
      drafts, plugins, store, draftId: 'example.note', confirmed: true,
    })
    expect(script.installed).toBe(false)
    expect(script.issues.map(issue => issue.code)).toContain('NOT_DECLARATIVE')
    expect(Reflect.get(globalThis, executed)).toBeUndefined()
    expect(await readFile(versionFile, 'utf8')).toBe(sealed)

    await drafts.create({
      manifestJson: manifest('example.note'),
      source: JSON.stringify({ kind: 'host-text-tool', toolId: 'note', label: '便签', text: 'should-not-stick' }),
    })
    const failed = await installConfirmedTextTool({
      drafts, plugins, store, draftId: 'example.note', confirmed: true,
    })
    expect(failed.installed).toBe(false)
    expect(failed.summary).toContain('已恢复上一版本')
    expect(failed.catalog.plugins.find(plugin => plugin.id === 'example.note')).toMatchObject({ status: 'inactive', tools: [] })
    expect(await readFile(versionFile, 'utf8')).toBe(sealed)
    await expect(readFile(versionPath(directory, 'example.note', 2))).rejects.toMatchObject({ code: 'ENOENT' })
    const current = JSON.parse(await readFile(currentPath(directory, 'example.note'), 'utf8')) as { revision: number; tool: { text: string } }
    expect(current.revision).toBe(1)
    expect(current.tool.text).toBe(marker)
    await expect(plugins.invoke('example.note', 'note')).rejects.toMatchObject({ code: 'TOOL_UNAVAILABLE' })
    await plugins.setEnabled('example.note', true)
    await expect(plugins.invoke('example.note', 'note')).resolves.toMatchObject({ text: marker })

    const legacyDirectory = await makeDirectory()
    const legacyStore = new InstalledStaticToolStore(legacyDirectory)
    const legacyFile = currentPath(legacyDirectory, 'example.legacy')
    const legacyRecord = {
      v: 1,
      enabled: true,
      manifest: staticManifest('example.legacy'),
      tool: { id: 'note', label: '便签', text: 'legacy-text' },
    }
    await mkdir(path.dirname(legacyFile), { recursive: true })
    await writeFile(legacyFile, `${JSON.stringify(legacyRecord)}\n`)
    const legacyPlugins = new HostPluginService(9, [])
    await legacyPlugins.start()
    await restoreInstalledStaticTools(legacyStore, legacyPlugins)
    await expect(legacyPlugins.invoke('example.legacy', 'note')).resolves.toMatchObject({ text: 'legacy-text' })
    const legacyDrafts = draftService(legacyDirectory, legacyPlugins)
    await legacyDrafts.create({
      manifestJson: manifest('example.legacy'),
      source: JSON.stringify({ kind: 'host-text-tool', toolId: 'note', label: '便签', text: 'legacy-next' }),
    })
    const legacyUpdate = await installConfirmedTextTool({
      drafts: legacyDrafts, plugins: legacyPlugins, store: legacyStore, draftId: 'example.legacy', confirmed: true,
    })
    expect(legacyUpdate.installed).toBe(true)
    expect(await readFile(versionPath(legacyDirectory, 'example.legacy', 1), 'utf8')).toContain('legacy-text')
    expect(await readFile(versionPath(legacyDirectory, 'example.legacy', 1), 'utf8')).toContain('"revision":1')
    await expect(legacyPlugins.invoke('example.legacy', 'note')).resolves.toMatchObject({ text: 'legacy-next' })
    await plugins.stop()
    await legacyPlugins.stop()
  })

  it('stores a composer action across restart without turning it into a text tool', async () => {
    const directory = await makeDirectory()
    const store = new InstalledStaticToolStore(directory)
    const plugins = new HostPluginService(10, [])
    await plugins.start()
    const drafts = draftService(directory, plugins)
    const marker = 'stored-note'
    const actionMarker = 'persisted-sign-off'
    const executed = '__mtcDraftSourceExecuted'
    Reflect.deleteProperty(globalThis, executed)
    await drafts.create({ manifestJson: manifest('example.script'), source: `globalThis.${executed} = true\n` })
    const script = await installConfirmedTextTool({
      drafts, plugins, store, draftId: 'example.script', confirmed: true,
    })
    expect(script.installed).toBe(false)
    expect(Reflect.get(globalThis, executed)).toBeUndefined()

    await drafts.create({
      manifestJson: manifest('example.note'),
      source: JSON.stringify({ kind: 'host-text-tool', toolId: 'note', label: '便签', text: marker }),
    })
    expect((await installConfirmedTextTool({
      drafts, plugins, store, draftId: 'example.note', confirmed: true,
    })).installed).toBe(true)
    await drafts.create({
      manifestJson: manifest('example.note'),
      source: JSON.stringify({ kind: 'composer-text-action', actionId: 'note', label: '署名', text: actionMarker }),
    })
    const replaced = await installConfirmedTextTool({
      drafts, plugins, store, draftId: 'example.note', confirmed: true,
    })
    expect(replaced.installed).toBe(false)
    expect(replaced.issues.map(issue => issue.code)).toContain('INSTALLED_ID')
    await expect(plugins.invoke('example.note', 'note')).resolves.toMatchObject({ text: marker })
    expect(plugins.catalog().plugins.find(plugin => plugin.id === 'example.note')?.composerActions).toEqual([])

    await drafts.create({
      manifestJson: manifest('example.sign'),
      source: JSON.stringify({ kind: 'composer-text-action', actionId: 'sign', label: '署名', text: actionMarker }),
    })
    const installed = await installConfirmedTextTool({
      drafts, plugins, store, draftId: 'example.sign', confirmed: true,
    })
    expect(installed.installed).toBe(true)
    expect(installed.summary).toContain('重启后仍会保留')
    expect(installed.catalog.plugins.find(plugin => plugin.id === 'example.sign')).toMatchObject({
      tools: [], composerActions: [{ id: 'sign', label: '署名' }],
    })
    expect(JSON.stringify(installed)).not.toContain(actionMarker)
    const file = currentPath(directory, 'example.sign')
    const versionFile = versionPath(directory, 'example.sign', 1)
    const saved = await readFile(file, 'utf8')
    expect(saved).toContain(actionMarker)
    expect(saved).toContain('"kind":"composer-action"')
    expect(saved).not.toContain('composer-text-action')
    expect(saved).not.toContain('actionId')
    expect(saved).not.toContain('globalThis')
    expect(await readFile(versionFile, 'utf8')).toBe(saved)
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
    await expect(plugins.invoke('example.sign', 'sign')).resolves.toMatchObject({ text: actionMarker })

    await drafts.create({
      manifestJson: manifest('example.sign'),
      source: JSON.stringify({ kind: 'composer-text-action', actionId: 'sign', label: '署名', text: 'should-not-replace' }),
    })
    const again = await installConfirmedTextTool({
      drafts, plugins, store, draftId: 'example.sign', confirmed: true,
    })
    expect(again.installed).toBe(false)
    expect(again.issues.map(issue => issue.code)).toContain('INSTALLED_ID')
    expect(await readFile(versionFile, 'utf8')).toBe(saved)
    await expect(readFile(versionPath(directory, 'example.sign', 2))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(plugins.invoke('example.sign', 'sign')).resolves.toMatchObject({ text: actionMarker })

    await drafts.create({
      manifestJson: manifest('example.sign'),
      source: JSON.stringify({ kind: 'host-text-tool', toolId: 'sign', label: '便签', text: 'should-not-convert' }),
    })
    const converted = await installConfirmedTextTool({
      drafts, plugins, store, draftId: 'example.sign', confirmed: true,
    })
    expect(converted.installed).toBe(false)
    expect(converted.issues.map(issue => issue.code)).toContain('INSTALLED_ID')
    expect(plugins.catalog().plugins.find(plugin => plugin.id === 'example.sign')).toMatchObject({
      tools: [], composerActions: [{ id: 'sign', label: '署名' }],
    })
    await expect(plugins.invoke('example.sign', 'sign')).resolves.toMatchObject({ text: actionMarker })

    const broken = new BrokenStore(directory)
    await drafts.create({
      manifestJson: manifest('example.other'),
      source: JSON.stringify({ kind: 'composer-text-action', actionId: 'other', label: '另一条', text: 'should-not-remain' }),
    })
    const failed = await installConfirmedTextTool({
      drafts, plugins, store: broken, draftId: 'example.other', confirmed: true,
    })
    expect(failed.installed).toBe(false)
    expect(failed.summary).toContain('撤回')
    expect(plugins.catalog().plugins.map(plugin => plugin.id)).toEqual(['example.note', 'example.sign'])
    await expect(readFile(currentPath(directory, 'example.other'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(plugins.invoke('example.sign', 'sign')).resolves.toMatchObject({ text: actionMarker })

    await plugins.setEnabled('example.sign', false)
    await store.setEnabled('example.sign', false)
    expect(await readFile(versionFile, 'utf8')).toBe(saved)
    const disabledRecord = JSON.parse(await readFile(file, 'utf8')) as { enabled: boolean; kind: string; tool: { text: string } }
    expect(disabledRecord.enabled).toBe(false)
    expect(disabledRecord.kind).toBe('composer-action')
    expect(disabledRecord.tool.text).toBe(actionMarker)
    await plugins.stop()

    const badKind = currentPath(directory, 'example.badkind')
    await writeFile(badKind, `${JSON.stringify({
      v: 1,
      revision: 1,
      enabled: true,
      kind: 'host-text-tool',
      manifest: staticManifest('example.badkind'),
      tool: { id: 'bad', label: '坏', text: 'nope' },
    })}\n`)
    const restarted = new HostPluginService(11, [])
    await restarted.start()
    await restoreInstalledStaticTools(store, restarted)
    expect(restarted.catalog().plugins.map(plugin => plugin.id)).toEqual(['example.note', 'example.sign'])
    expect(restarted.catalog().plugins.find(plugin => plugin.id === 'example.sign')).toMatchObject({
      status: 'inactive', tools: [], composerActions: [],
    })
    await expect(restarted.invoke('example.note', 'note')).resolves.toMatchObject({ text: marker })
    await expect(restarted.invoke('example.sign', 'sign')).rejects.toMatchObject({ code: 'TOOL_UNAVAILABLE' })
    await restarted.setEnabled('example.sign', true)
    expect(restarted.catalog().plugins.find(plugin => plugin.id === 'example.sign')).toMatchObject({
      status: 'active', tools: [], composerActions: [{ id: 'sign', label: '署名' }],
    })
    await expect(restarted.invoke('example.sign', 'sign')).resolves.toMatchObject({ text: actionMarker })
    expect(Reflect.get(globalThis, executed)).toBeUndefined()
    await restarted.stop()
  })
})

class BrokenStore extends InstalledStaticToolStore {
  override save(): Promise<void> {
    return Promise.reject(new Error('disk full'))
  }
}

class FailUpdateStore extends InstalledStaticToolStore {
  override save(record: StoredStaticTool): Promise<void> {
    if (record.revision > 1) return Promise.reject(new Error('disk full'))
    return super.save(record)
  }
}

function currentPath(directory: string, id: string): string {
  return path.join(directory, 'installed-static-tools', `${id}.json`)
}

function versionPath(directory: string, id: string, revision: number): string {
  return path.join(directory, 'installed-static-tools', 'versions', id, `version-${revision}.json`)
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
