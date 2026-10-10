import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createSeedState } from '@more-than-chat/chat-core'
import { ChatStore } from '../src/main/chat-store'

const directories: string[] = [], stores: ChatStore[] = []
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
async function directory() { const dir = await mkdtemp(path.join(tmpdir(), 'mtc-sqlite-test-')); directories.push(dir); return dir }
async function open(dir: string) { const store = await ChatStore.open(dir); stores.push(store); return store }

describe('transactional chat storage', () => {
  it('migrates legacy data once and preserves the original backup', async () => {
    const dir = await directory(), snapshot = createSeedState(1700000000000)
    await writeFile(path.join(dir, 'chat-state.json'), JSON.stringify(snapshot))
    const store = await open(dir)
    expect(store.load()).toEqual(snapshot)
    await expect(readFile(path.join(dir, 'chat-state.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await readFile(path.join(dir, 'chat-state.json.migrated'), 'utf8'))).toEqual(snapshot)
    const updated = { ...snapshot, profile: { ...snapshot.profile, displayName: 'Updated' } }
    store.save(updated); store.close()
    await writeFile(path.join(dir, 'chat-state.json'), JSON.stringify(snapshot))
    expect((await open(dir)).load()).toEqual(updated)
  })
  it('keeps invalid legacy data and never silently seeds over it', async () => {
    const dir = await directory(), raw = '{invalid json'
    await writeFile(path.join(dir, 'chat-state.json'), raw)
    await expect(ChatStore.open(dir)).rejects.toThrow()
    expect(await readFile(path.join(dir, 'chat-state.json'), 'utf8')).toBe(raw)
  })
  it('rolls back both projections and events when any write fails', async () => {
    const dir = await directory(), snapshot = createSeedState(1700000000000), store = await open(dir)
    store.save(snapshot)
    const db = new DatabaseSync(path.join(dir, 'chat.sqlite'))
    const before = db.prepare('SELECT COUNT(*) AS count FROM chat_events').get()?.count
    db.exec("CREATE TRIGGER fail_events BEFORE INSERT ON chat_events BEGIN SELECT RAISE(ABORT, 'injected failure'); END")
    expect(() => store.save({ ...snapshot, profile: { ...snapshot.profile, displayName: 'Must not persist' }, conversations: snapshot.conversations.map(item => ({ ...item, title: 'Must roll back' })) })).toThrow('injected failure')
    expect(store.load()).toEqual(snapshot)
    expect(db.prepare('SELECT COUNT(*) AS count FROM chat_events').get()?.count).toBe(before)
    db.exec('DROP TRIGGER fail_events'); db.close()
    store.save({ ...snapshot, profile: { ...snapshot.profile, displayName: 'Recovered' } })
    expect(store.load()?.profile.displayName).toBe('Recovered')
  })
  it('rejects invalid identities, deduplicates unchanged saves, and redacts journal data', async () => {
    const dir = await directory(), store = await open(dir), snapshot = createSeedState(1700000000000)
    store.save(snapshot)
    const db = new DatabaseSync(path.join(dir, 'chat.sqlite'))
    const before = db.prepare('SELECT COUNT(*) AS count FROM chat_events').get()?.count
    store.save(snapshot)
    expect(db.prepare('SELECT COUNT(*) AS count FROM chat_events').get()?.count).toBe(before)
    expect(() => store.save({ ...snapshot, activeConversationId: 'unknown' })).toThrow()
    const message = snapshot.messages['conversation-assistant']![0]!
    message.text = 'secret sk-placeholder-test-credential'; (message as unknown as { apiKey: string }).apiKey = 'private'
    store.save(snapshot)
    expect(JSON.stringify(store.load())).not.toContain('sk-placeholder-test-credential')
    expect(JSON.stringify(db.prepare('SELECT payload FROM chat_events').all())).not.toContain('sk-placeholder-test-credential')
    expect(JSON.stringify(store.load())).not.toContain('apiKey')
    db.close()
  })
})
