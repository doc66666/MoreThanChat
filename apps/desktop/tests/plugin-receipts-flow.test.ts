import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { createSeedState } from '@more-than-chat/chat-core'
import { ChatStore } from '../src/main/chat-store'
import { ClientIdentity } from '../src/main/identity-store'
import { AttachmentStore } from '../src/main/attachments'
import { CentralClient } from '../src/main/central-client'
import { createCentralServer } from '../../central-server/src/server.mjs'

const cipher = { available: () => true, encrypt: (text: string) => Buffer.from(text), decrypt: (bytes: Buffer) => bytes.toString() }
async function until(check: () => boolean) {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)) }
  throw new Error('Plugin receipt recovery timeout')
}

it.each(['before server commit', 'after server commit'])('recovers plugin ACK loss %s after restart without repeating the listener', async failure => {
  const root = await mkdtemp(path.join(tmpdir(), 'mtc-plugin-receipts-'))
  const clients: CentralClient[] = [], stores: ChatStore[] = []
  const app = createCentralServer({ directory: path.join(root, 'server'), mode: 'public', adminToken: 'qa-only-strong-admin-token-0001' })
  const url = 'http://127.0.0.1:' + (await app.listen(0)).port
  async function make(label: string) {
    const folder = path.join(root, label), store = await ChatStore.open(folder); stores.push(store)
    if (!store.load()) store.save(createSeedState())
    const client = new CentralClient(await ClientIdentity.load(folder, cipher), store, new AttachmentStore(path.join(folder, 'files')), folder)
    clients.push(client); return { client, store }
  }
  try {
    const a = await make('a'), b = await make('b')
    await a.client.connect(url, 'A'); await b.client.connect(url, 'B')
    await a.client.action('friends/request', { userId: b.client.identity.userId })
    await b.client.action('friends/accept', { userId: a.client.identity.userId })
    const group = await a.client.action('groups', { name: 'Receipt recovery', memberIds: [b.client.identity.userId] })
    const groupId = group.directory!.groups[0]!.id, pluginId = 'gplugin_' + randomUUID()
    const submitted = await b.client.action('plugins/submit', { groupId, pack: { id: pluginId, version: 1, displayName: 'Recovery channel', kind: 'channel', slot: 'app.sidebar' } })
    const digest = submitted.directory!.plugins.find(plugin => plugin.pack.id === pluginId)!.digest
    await a.client.action('plugins/review', { groupId, pluginId, version: 1, digest, approve: true })
    await a.client.disconnect(false)
    const listener = vi.fn(); b.client.onPlugin(listener)
    const originalFetch = globalThis.fetch
    let failures = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const ids = typeof init?.body === 'string' ? (JSON.parse(init.body) as { ids?: string[] }).ids : undefined
      if (String(input).endsWith('/v1/ack') && ids?.some(id => b.store.pendingPluginAcks(app.serverId).includes(id))) {
        failures++
        if (failure === 'after server commit') await (await originalFetch(input, init)).arrayBuffer()
        throw new Error('Injected lost ACK connection')
      }
      return originalFetch(input, init)
    })
    await b.client.action('plugins/event', { groupId, pluginId, channel: 'custom', payload: { cell: 4 } })
    await until(() => failures > 0 && b.client.snapshot().status === 'error')
    expect(listener).toHaveBeenCalledTimes(1)
    const id = b.store.pendingPluginAcks(app.serverId)[0]!
    expect(id).toBeTruthy()
    const queued = app.db.prepare('SELECT COUNT(*) AS n FROM queue WHERE id=? AND recipient=?').get(id, b.client.identity.userId).n
    expect(queued).toBe(failure === 'before server commit' ? 1 : 0)
    await b.client.disconnect(false); b.store.close(); vi.restoreAllMocks()
    const restarted = await make('b'), replay = vi.fn(); restarted.client.onPlugin(replay)
    await restarted.client.connect(url, 'B')
    await until(() => restarted.store.pendingPluginAcks(app.serverId).length === 0)
    expect(app.db.prepare('SELECT COUNT(*) AS n FROM queue WHERE id=? AND recipient=?').get(id, restarted.client.identity.userId).n).toBe(0)
    expect(restarted.store.pluginInbox(app.serverId, groupId, pluginId)).toHaveLength(1)
    expect(restarted.store.savePluginEvent(app.serverId, listener.mock.calls[0]![0])).toBe(false)
    expect(replay).not.toHaveBeenCalled()
  } finally {
    vi.restoreAllMocks()
    for (const client of clients) await client.disconnect(false)
    await app.close()
    for (const store of stores) store.close()
    await rm(root, { recursive: true, force: true })
  }
}, 20000)
