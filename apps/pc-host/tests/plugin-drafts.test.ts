import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHostSuccessResponse, parseHostMessage } from '@more-than-chat/protocol'
import { HostPluginService } from '../src/plugin-service'
import { PluginDraftError, PluginDraftService } from '../src/plugin-drafts'

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
