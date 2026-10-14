import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PluginDraftService } from '../src/plugin-drafts'
import { createAuthorToolExecutor } from '../src/author-tools'

const directories: string[] = []
afterEach(async () => {for (const directory of directories.splice(0)) await rm(directory, {recursive: true, force: true})})
const manifest = {manifestVersion: 1, id: 'test.client', version: '0.1.0', displayName: '桌面', description: '全桌面', targets: ['pc-ui'], engine: {moreThanChat: '^0.1.0'}, permissions: ['client.trusted'], services: {requires: ['ui.surfaces']}}
const program = {kind: 'executable-client', code: 'export default function(ctx, sdk) { ctx.effect(() => {}); }'}
async function drafts() {const dataDir = await mkdtemp(path.join(os.tmpdir(), 'mtc-client-author-')); directories.push(dataDir); return new PluginDraftService({dataDir, installedPlugins: () => []})}
it('AI creates and reads executable source revisions, but cannot install or submit as a declarative group package', async () => {
  const service = await drafts(), tools = createAuthorToolExecutor(service)
  const result = await tools.execute({id: 'create', name: 'create_draft', arguments: JSON.stringify({manifestJson: JSON.stringify(manifest), source: JSON.stringify(program)})})
  expect(result.notice.ok).toBe(true)
  expect(result.notice.pendingInstall).toBe(false)
  expect(result.notice.summary).toContain('尚未执行')
  expect((await service.inspect()).drafts[0]?.distribution).toBe('local-client')
  expect((await service.validate(manifest.id)).ok).toBe(true)
  expect(JSON.parse((await service.readForAuthor(manifest.id)).source)).toEqual(program)
  expect(JSON.parse((await service.exportClient(manifest.id, 1)).source)).toEqual(program)
  await expect(service.exportClient(manifest.id, 2)).rejects.toThrow('已更新')
  await expect(service.exportGroup(manifest.id, 1)).rejects.toThrow()
  expect((await service.planInstall(manifest.id, true)).installable).toBe(false)
})
it('does not downgrade legacy declarative restrictions, and still refuses secrets in executable source', async () => {
  const service = await drafts()
  const legacy = await service.create({manifestJson: JSON.stringify({...manifest, permissions: ['chat.network'], services: {requires: ['chat.network']}}), source: JSON.stringify(program)})
  expect(legacy.ok).toBe(false)
  const secret = await service.create({manifestJson: JSON.stringify(manifest), source: JSON.stringify({...program, code: 'const key="sk-' + 'q'.repeat(40) + '";'})})
  expect(secret.persisted).toBe(false)
})
