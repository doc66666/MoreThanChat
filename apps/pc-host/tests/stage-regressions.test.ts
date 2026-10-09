import { mkdtemp, mkdir, readFile, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readServerSentEvents } from '../src/openai-compatible'
import { HostPluginService } from '../src/plugin-service'
import { PluginDraftService } from '../src/plugin-drafts'
import { createAuthorToolExecutor } from '../src/author-tools'
import { InstalledStaticToolStore, restoreInstalledStaticTools, type StoredStaticTool } from '../src/installed-static-tools'
import { installConfirmedTextTool } from '../src/static-tool-install'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
const manifest = { manifestVersion: 1 as const, id: 'example.stage-test', version: '0.1.0', displayName: 'Stage test', description: 'Test',
  targets: ['pc-host' as const], permissions: [], engine: { moreThanChat: '^0.1.0' }, services: { requires: ['host.tools'] } }
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mtc-stage-test-')); dirs.push(root)
  const plugins = new HostPluginService(1, []); await plugins.start()
  const drafts = new PluginDraftService({ dataDir: root, installedPlugins: () => plugins.catalog().plugins })
  const store = new InstalledStaticToolStore(root)
  return { root, plugins, drafts, store }
}
function stream(value: string) { return new Response(value).body! }

describe('MVP regression contracts', () => {
  it('rejects premature EOF and provider length truncation', async () => {
    await expect(readServerSentEvents(stream('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'), () => {})).rejects.toThrow('提前结束')
    await expect(readServerSentEvents(stream('data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n'), () => {})).rejects.toThrow('未完成')
    await expect(readServerSentEvents(stream('data: [DONE]\n\n'), () => {})).resolves.toEqual([])
  })
  it('does not advertise executable/non-declarative drafts as pending installation', async () => {
    const { plugins, drafts } = await fixture()
    const result = await createAuthorToolExecutor(drafts).execute({ id: 'call', name: 'create_draft', arguments: JSON.stringify({
      manifestJson: JSON.stringify(manifest), source: 'const value = 42;',
    }) })
    expect(result.notice.pendingInstall).toBe(false)
    expect(result.notice.ok).toBe(false)
    expect(JSON.parse(result.content).installationIssues.some((issue: { code: string }) => issue.code === 'NOT_DECLARATIVE')).toBe(true)
    await plugins.stop()
  })
  it('installs a transform, replaces input, and restores it after restart', async () => {
    const { root, plugins, drafts, store } = await fixture()
    await drafts.create({ manifestJson: JSON.stringify(manifest), source: JSON.stringify({ kind: 'composer-transform-action', actionId: 'uppercase', label: '大写', operation: 'uppercase' }) })
    expect((await installConfirmedTextTool({ drafts, plugins, store, draftId: manifest.id, confirmed: true })).installed).toBe(true)
    expect(await plugins.invoke(manifest.id, 'uppercase', 'hello AI')).toMatchObject({ text: 'HELLO AI', replaceDraft: true })
    await plugins.stop()
    const restarted = new HostPluginService(2, []); await restarted.start()
    await restoreInstalledStaticTools(new InstalledStaticToolStore(root), restarted)
    expect(await restarted.invoke(manifest.id, 'uppercase', '')).toMatchObject({ text: '', replaceDraft: true })
    await restarted.stop()
  })
  it('recovers old version after current-write failure and permits a corrected revision', async () => {
    const { root, plugins, drafts, store } = await fixture()
    const create = (text: string) => drafts.create({ manifestJson: JSON.stringify(manifest), source: JSON.stringify({ kind: 'host-text-tool', toolId: 'note', label: 'Note', text }) })
    const install = () => installConfirmedTextTool({ drafts, plugins, store, draftId: manifest.id, confirmed: true })
    await create('old'); expect((await install()).installed).toBe(true)
    const original = store.save.bind(store); let fail = true
    store.save = async (record: StoredStaticTool) => {
      if (!fail || record.revision !== 2) return original(record)
      fail = false
      const current = path.join(root, 'installed-static-tools', `${manifest.id}.json`)
      await unlink(current); await mkdir(current)
      try { return await original(record) } finally { await rm(current, { recursive: true, force: true }) }
    }
    await create('failed'); expect((await install()).installed).toBe(false)
    expect((await store.read(manifest.id))?.revision).toBe(1)
    await create('corrected'); expect((await install()).installed).toBe(true)
    expect((await store.read(manifest.id))?.revision).toBe(3)
    expect((await plugins.invoke(manifest.id, 'note')).text).toBe('corrected')
    expect(JSON.parse(await readFile(path.join(root, 'installed-static-tools', 'versions', manifest.id, 'version-2.json'), 'utf8')).tool.text).toBe('failed')
    await plugins.stop()
  })
})
