import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { ChatStore, PLUGIN_HISTORY_LIMITS } from '../src/main/chat-store'

const roots: string[] = [], stores: ChatStore[] = [], databases: DatabaseSync[] = []
afterEach(async () => {
  for (const db of databases.splice(0)) db.close()
  for (const store of stores.splice(0)) store.close()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mtc-plugin-inbox-')); roots.push(root)
  const store = await ChatStore.open(root); stores.push(store)
  const db = new DatabaseSync(path.join(root, 'chat.sqlite')); databases.push(db)
  return { root, store, db }
}
const event = (id: string, pluginId = 'plugin', groupId = 'group') => ({ id, pluginId, groupId })
function seedEvents(db: DatabaseSync, events: ReturnType<typeof event>[]) {
  // Transactions are connection-local. Do not BEGIN here and write via ChatStore's
  // other connection: that silently performs thousands of FULL-sync commits.
  const insert = db.prepare('INSERT INTO plugin_inbox(server_id,id,group_id,plugin_id,payload,created_at) VALUES (?,?,?,?,?,?)')
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const item of events) insert.run('server', item.id, item.groupId, item.pluginId, JSON.stringify(item), Date.now())
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}

it('bounds acknowledged history while preserving uncertain receipts and deduplication across restart', async () => {
  const { root, store, db } = await fixture()
  store.savePluginEvent('server', event('uncertain'))
  const ids = Array.from({ length: 1020 }, (_, i) => String(i))
  seedEvents(db, ids.map(id => event(id)))
  store.confirmPluginAcks('server', ids)
  expect(db.prepare('SELECT COUNT(*) AS n FROM plugin_inbox').get()?.n).toBe(1001)
  expect(store.pendingPluginAcks('server')).toEqual(['uncertain'])
  expect(store.pluginInbox('server', 'group', 'plugin')).toEqual(ids.slice(-1000).map(id => event(id)))
  store.close()
  const reopened = await ChatStore.open(root); stores.push(reopened)
  expect(reopened.savePluginEvent('server', event('uncertain'))).toBe(false)
  expect(reopened.savePluginEvent('server', event('1019'))).toBe(false)
  reopened.confirmPluginAcks('server', ['uncertain'])
  expect(reopened.pendingPluginAcks('server')).toEqual([])
  expect(db.prepare('SELECT COUNT(*) AS n FROM plugin_inbox').get()?.n).toBe(1000)
})

it('isolates ACKs and history by server, group and plugin', async () => {
  const { store, db } = await fixture()
  store.savePluginEvent('one', event('same'))
  store.savePluginEvent('two', event('same'))
  store.savePluginEvent('one', event('other-group', 'plugin', 'elsewhere'))
  store.savePluginEvent('one', event('other-plugin', 'another'))
  store.confirmPluginAcks('one', ['same'])
  expect(store.pendingPluginAcks('two')).toEqual(['same'])
  expect(store.pluginInbox('one', 'group', 'plugin')).toEqual([event('same')])
  expect(db.prepare('SELECT acknowledged FROM plugin_inbox WHERE server_id=? AND id=?').get('two', 'same')?.acknowledged).toBe(0)
})

it('caps total retained events across many plugin namespaces', async () => {
  const { store, db } = await fixture()
  const ids = Array.from({ length: PLUGIN_HISTORY_LIMITS.total + 20 }, (_, i) => String(i))
  seedEvents(db, ids.map(id => event(id, 'plugin-' + id)))
  expect(db.prepare('SELECT COUNT(*) AS n FROM plugin_inbox WHERE acknowledged=0').get()?.n).toBe(10020)
  store.confirmPluginAcks('server', ids)
  expect(db.prepare('SELECT COUNT(*) AS n FROM plugin_inbox').get()?.n).toBe(PLUGIN_HISTORY_LIMITS.total)
  expect(store.pluginInbox('server', 'group', 'plugin-0')).toEqual([])
})

it('caps UTF-8 payload bytes rather than character count without clearing unconfirmed bodies', async () => {
  const { store, db } = await fixture()
  const ids = Array.from({ length: 990 }, (_, i) => String(i))
  const payload = '棋'.repeat(6000)
  store.savePluginEvent('server', { ...event('pending'), payload } as ReturnType<typeof event>)
  seedEvents(db, ids.map(id => ({ ...event(id), payload })))
  store.confirmPluginAcks('server', ids)
  const stats = db.prepare('SELECT COUNT(*) AS n,SUM(length(CAST(payload AS BLOB))) AS bytes FROM plugin_inbox WHERE acknowledged=1').get()!
  expect(Number(stats.n)).toBeLessThan(990)
  expect(Number(stats.bytes)).toBeLessThanOrEqual(PLUGIN_HISTORY_LIMITS.bytes)
  expect(store.pendingPluginAcks('server')).toEqual(['pending'])
})

it('migrates v5 conservatively and does not ACK or delete old data until the relay confirms', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mtc-plugin-v5-')); roots.push(root)
  const legacy = new DatabaseSync(path.join(root, 'chat.sqlite'))
  legacy.exec('CREATE TABLE plugin_inbox(server_id TEXT,id TEXT,group_id TEXT,plugin_id TEXT,payload TEXT,created_at INTEGER,PRIMARY KEY(server_id,id)); PRAGMA user_version=5')
  legacy.prepare('INSERT INTO plugin_inbox VALUES (?,?,?,?,?,?)').run('server', 'old', 'group', 'plugin', JSON.stringify(event('old')), 1)
  legacy.close()
  const store = await ChatStore.open(root); stores.push(store)
  expect(store.pendingPluginAcks('server')).toEqual(['old'])
  expect(store.pluginInbox('server', 'group', 'plugin')).toEqual([event('old')])
  store.confirmPluginAcks('server', ['old']); store.close()
  const reopened = await ChatStore.open(root); stores.push(reopened)
  expect(reopened.pendingPluginAcks('server')).toEqual([])
  expect(reopened.pluginInbox('server', 'group', 'plugin')).toEqual([event('old')])
})

it('rolls back receipt confirmation when cleanup fails, so retry remains safe', async () => {
  const { store, db } = await fixture()
  const ids = Array.from({ length: 1001 }, (_, i) => String(i))
  seedEvents(db, ids.map(id => event(id)))
  db.exec("CREATE TRIGGER fail_prune BEFORE DELETE ON plugin_inbox BEGIN SELECT RAISE(ABORT, 'cleanup failed'); END")
  expect(() => store.confirmPluginAcks('server', ids)).toThrow('cleanup failed')
  expect(db.prepare('SELECT COUNT(*) AS n FROM plugin_inbox WHERE acknowledged=1').get()?.n).toBe(0)
  expect(store.pendingPluginAcks('server')).toHaveLength(100)
  db.exec('DROP TRIGGER fail_prune')
  store.confirmPluginAcks('server', ids)
  expect(store.pendingPluginAcks('server')).toEqual([])
})

it('returns arrival order when wall time moves backwards', async () => {
  const { store, db } = await fixture()
  store.savePluginEvent('server', event('first'))
  store.savePluginEvent('server', event('second'))
  db.prepare('UPDATE plugin_inbox SET created_at=0 WHERE id=?').run('second')
  expect(store.pluginInbox('server', 'group', 'plugin')).toEqual([event('first'), event('second')])
})
