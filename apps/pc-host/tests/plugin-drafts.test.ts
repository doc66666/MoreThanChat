import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHostSuccessResponse, parseHostMessage } from '@more-than-chat/protocol'
import { HostPluginService } from '../src/plugin-service'
import { PluginDraftError, PluginDraftService } from '../src/plugin-drafts'
import { installConfirmedTextTool } from '../src/static-tool-install'

const secret = 'sk-test-more-than-chat-secret'
const sourceMarker = 'draft-source-marker-not-a-secret'
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('PluginDraftService', () => {
  it('saves an immutable draft without installing it or returning its source', async () => {
    const plugins = new HostPluginService(4, [])
    const { service, directory } = await createService(plugins)
    const created = await service.create({ manifestJson: manifest('example.note'), source: `export const marker = '${sourceMarker}'\n` })
    const again = await service.create({ manifestJson: manifest('example.note', '0.1.1'), source: 'export const marker = "second"\n' })
    const inspection = await service.inspect()
    const validated = await service.validate('example.note')
    const diagnosed = await service.diagnose('example.note')

    expect(plugins.catalog().plugins).toEqual([])
    expect(created.persisted).toBe(true)
    expect(created.draft).toMatchObject({ id: 'example.note', revision: 1, ok: true })
    expect(again.draft).toMatchObject({ revision: 2, version: '0.1.1' })
    expect(inspection.installed).toEqual([])
    expect(inspection.drafts.map(draft => draft.revision)).toEqual([2])
    expect(validated.ok).toBe(true)
    expect(diagnosed.summary).toContain('未安装')
    expect(JSON.stringify([created, again, inspection, validated, diagnosed])).not.toContain(sourceMarker)
    expect(JSON.stringify([created, again, inspection, validated, diagnosed])).not.toContain('second')
    const names = await readdir(path.join(directory, 'plugin-drafts', 'example.note'))
    expect(names.sort()).toEqual(['revision-1.json', 'revision-2.json'])
    const first = await readFile(path.join(directory, 'plugin-drafts', 'example.note', 'revision-1.json'), 'utf8')
    expect(first).toContain(sourceMarker)
    if (process.platform !== 'win32') {
      expect((await stat(path.join(directory, 'plugin-drafts', 'example.note', 'revision-2.json'))).mode & 0o777).toBe(0o600)
    }
    expect(parseHostMessage(createHostSuccessResponse(
      { requestId: 'draft', method: 'pluginDrafts.create' },
      created,
    )).kind).toBe('response')
  })

  it('refuses credential material and keeps a failing draft separate from an installed id', async () => {
    const plugins = new HostPluginService(1)
    const installed = plugins.catalog().plugins.map(plugin => plugin.id)
    const { service, directory } = await createService(plugins)
    const leaked = await service.create({
      manifestJson: manifest('example.leak'),
      source: `const apiKey = '${secret}'\n`,
    })
    const conflicting = await service.create({
      manifestJson: manifest('builtin.time-tool'),
      source: 'export const tool = () => "local"\n',
    })
    const dangerous = await service.create({
      manifestJson: manifest('example.fetch'),
      source: 'export const load = () => fetch("https://example.invalid")\n',
    })

    expect(leaked.persisted).toBe(false)
    expect(leaked.draft).toBeNull()
    expect(JSON.stringify(leaked)).not.toContain(secret)
    expect(leaked.issues.some(issue => issue.code === 'SECRET_MATERIAL')).toBe(true)
    await expect(readdir(path.join(directory, 'plugin-drafts', 'example.leak'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(plugins.catalog().plugins.map(plugin => plugin.id)).toEqual(installed)
    expect(conflicting.persisted).toBe(true)
    expect(conflicting.ok).toBe(true)
    expect(conflicting.issues.map(issue => issue.code)).toContain('INSTALLED_ID')
    expect(plugins.catalog().plugins.map(plugin => plugin.status)).toEqual(['inactive'])
    expect(dangerous.persisted).toBe(true)
    expect(dangerous.ok).toBe(false)
    expect((await service.diagnose('example.fetch')).issues.map(issue => issue.code)).toContain('DANGEROUS_API')
    await expect(service.validate('missing.draft')).rejects.toBeInstanceOf(PluginDraftError)
  })

  it('installs a confirmed declarative text tool and does not execute other source', async () => {
    const plugins = new HostPluginService(2, [])
    await plugins.start()
    const { service } = await createService(plugins)
    const marker = 'declared-text-marker'
    const executed = '__mtcDraftSourceExecuted'
    Reflect.deleteProperty(globalThis, executed)
    const script = await service.create({
      manifestJson: manifest('example.script'),
      source: `globalThis.${executed} = true\n`,
    })
    expect(script.persisted).toBe(true)
    const refused = await installConfirmedTextTool({ drafts: service, plugins, draftId: 'example.script', confirmed: true })
    expect(refused.installed).toBe(false)
    expect(refused.issues.map(issue => issue.code)).toContain('NOT_DECLARATIVE')
    expect(JSON.stringify(refused)).not.toContain('globalThis')
    expect(Reflect.get(globalThis, executed)).toBeUndefined()
    expect(plugins.catalog().plugins).toEqual([])

    const source = JSON.stringify({ kind: 'host-text-tool', toolId: 'note', label: '便签', text: marker })
    const created = await service.create({ manifestJson: manifest('example.note'), source })
    expect(created.ok).toBe(true)
    const unconfirmed = await installConfirmedTextTool({ drafts: service, plugins, draftId: 'example.note', confirmed: false })
    expect(unconfirmed.installed).toBe(false)
    expect(unconfirmed.issues.map(issue => issue.code)).toContain('CONFIRMATION_REQUIRED')
    expect(JSON.stringify(unconfirmed)).not.toContain(marker)
    expect(plugins.catalog().plugins).toEqual([])

    const installed = await installConfirmedTextTool({ drafts: service, plugins, draftId: 'example.note', confirmed: true })
    expect(installed.installed).toBe(true)
    expect(installed.catalog.plugins[0]).toMatchObject({ id: 'example.note', status: 'active', tools: [{ id: 'note', label: '便签' }] })
    expect(JSON.stringify(installed)).not.toContain(marker)
    expect(parseHostMessage(createHostSuccessResponse({ requestId: 'install', method: 'pluginDrafts.install' }, installed)).kind).toBe('response')
    await expect(plugins.invoke('example.note', 'note')).resolves.toMatchObject({ text: marker })
    await plugins.setEnabled('example.note', false)
    await expect(plugins.invoke('example.note', 'note')).rejects.toMatchObject({ code: 'TOOL_UNAVAILABLE' })
    await plugins.setEnabled('example.note', true)
    await expect(plugins.invoke('example.note', 'note')).resolves.toMatchObject({ text: marker })

    const again = await installConfirmedTextTool({ drafts: service, plugins, draftId: 'example.note', confirmed: true })
    expect(again.installed).toBe(false)
    expect(again.issues.map(issue => issue.code)).toContain('INSTALLED_ID')
    await expect(plugins.invoke('example.note', 'note')).resolves.toMatchObject({ text: marker })

    const sneaky = `${source}; globalThis.${executed} = true`
    await service.create({ manifestJson: manifest('example.sneaky'), source: sneaky })
    const sneakyResult = await installConfirmedTextTool({ drafts: service, plugins, draftId: 'example.sneaky', confirmed: true })
    expect(sneakyResult.installed).toBe(false)
    expect(sneakyResult.issues.map(issue => issue.code)).toContain('NOT_DECLARATIVE')
    expect(Reflect.get(globalThis, executed)).toBeUndefined()

    const dangerous = await service.create({
      manifestJson: manifest('example.fetch'),
      source: JSON.stringify({ kind: 'host-text-tool', toolId: 'bad', label: '坏工具', text: 'please fetch("https://example.invalid")' }),
    })
    expect(dangerous.persisted).toBe(true)
    const blocked = await installConfirmedTextTool({ drafts: service, plugins, draftId: 'example.fetch', confirmed: true })
    expect(blocked.installed).toBe(false)
    expect(blocked.issues.map(issue => issue.code)).toContain('DANGEROUS_API')
    expect(JSON.stringify(blocked)).not.toContain('example.invalid')

    await service.create({
      manifestJson: manifest('example.files').replace('"permissions":[]', '"permissions":["files"]'),
      source,
    })
    const permissionRefusal = await installConfirmedTextTool({ drafts: service, plugins, draftId: 'example.files', confirmed: true })
    expect(permissionRefusal.installed).toBe(false)
    expect(permissionRefusal.issues.map(issue => issue.code)).toContain('NOT_INSTALLABLE')
    expect(plugins.catalog().plugins.map(plugin => plugin.id)).toEqual(['example.note'])

    const leaked = await service.create({
      manifestJson: manifest('example.leak'),
      source: JSON.stringify({ kind: 'host-text-tool', toolId: 'note', label: '便签', text: `token ${secret}` }),
    })
    expect(leaked.persisted).toBe(false)
    await expect(installConfirmedTextTool({ drafts: service, plugins, draftId: 'example.leak', confirmed: true })).rejects.toBeInstanceOf(PluginDraftError)
    expect(Reflect.get(globalThis, executed)).toBeUndefined()

    const actionMarker = 'composer-action-marker'
    const actionSource = JSON.stringify({ kind: 'composer-text-action', actionId: 'sign', label: '署名', text: actionMarker })
    await service.create({ manifestJson: manifest('example.sign'), source: actionSource })
    const unconfirmedAction = await installConfirmedTextTool({ drafts: service, plugins, draftId: 'example.sign', confirmed: false })
    expect(unconfirmedAction.installed).toBe(false)
    expect(unconfirmedAction.issues.map(issue => issue.code)).toContain('CONFIRMATION_REQUIRED')
    expect(JSON.stringify(unconfirmedAction)).not.toContain(actionMarker)
    const action = await installConfirmedTextTool({ drafts: service, plugins, draftId: 'example.sign', confirmed: true })
    expect(action.installed).toBe(true)
    expect(action.summary).toContain('输入框动作')
    expect(action.catalog.plugins.find(plugin => plugin.id === 'example.sign')).toMatchObject({
      status: 'active', tools: [], composerActions: [{ id: 'sign', label: '署名' }],
    })
    expect(JSON.stringify(action)).not.toContain(actionMarker)
    await expect(plugins.invoke('example.sign', 'sign')).resolves.toMatchObject({ text: actionMarker })
    await plugins.setEnabled('example.sign', false)
    expect(plugins.catalog().plugins.find(plugin => plugin.id === 'example.sign')?.composerActions).toEqual([])
    await expect(plugins.invoke('example.sign', 'sign')).rejects.toMatchObject({ code: 'TOOL_UNAVAILABLE' })
    await plugins.setEnabled('example.sign', true)
    await expect(plugins.invoke('example.sign', 'sign')).resolves.toMatchObject({ text: actionMarker })
    const actionAgain = await installConfirmedTextTool({ drafts: service, plugins, draftId: 'example.sign', confirmed: true })
    expect(actionAgain.installed).toBe(false)
    expect(actionAgain.issues.map(issue => issue.code)).toContain('INSTALLED_ID')
    await service.create({
      manifestJson: manifest('example.sign-extra'),
      source: JSON.stringify({ kind: 'composer-text-action', actionId: 'sign', label: '署名', text: actionMarker, source: 'nope' }),
    })
    const extra = await installConfirmedTextTool({ drafts: service, plugins, draftId: 'example.sign-extra', confirmed: true })
    expect(extra.installed).toBe(false)
    expect(extra.issues.map(issue => issue.code)).toContain('NOT_DECLARATIVE')
    expect(Reflect.get(globalThis, executed)).toBeUndefined()
    await plugins.stop()
  })
})

async function createService(plugins: HostPluginService): Promise<{ service: PluginDraftService; directory: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), 'mtc-drafts-'))
  directories.push(directory)
  return {
    directory,
    service: new PluginDraftService({
      dataDir: directory,
      installedPlugins: () => plugins.catalog().plugins.map(plugin => ({
        id: plugin.id,
        version: plugin.version,
        displayName: plugin.displayName,
        status: plugin.status,
      })),
    }),
  }
}

function manifest(id: string, version = '0.1.0'): string {
  return JSON.stringify({
    manifestVersion: 1,
    id,
    version,
    displayName: '草稿示例',
    description: '只保存在草稿目录，不会被安装。',
    targets: ['pc-host'],
    engine: { moreThanChat: '^0.1.0' },
    permissions: [],
    services: { requires: ['host.tools'] },
  })
}
