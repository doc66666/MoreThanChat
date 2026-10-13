import { mkdtemp, rm } from 'node:fs/promises'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCentralServer, publicUserId } from '../src/server.mjs'

const fixtures = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.app.close()
    await rm(f.directory, { recursive: true, force: true })
  }
})

async function request(f, route, token, body, status = 200) {
  const response = await fetch(f.url + '/v1/' + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const data = await response.json()
  expect(response.status, JSON.stringify(data)).toBe(status)
  return data
}

async function login(f, name) {
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
  const challenge = await request(f, 'challenge', null, { publicKey, displayName: name })
  const session = await request(f, 'session', null, {
    challengeId: challenge.challengeId,
    signature: sign(null, Buffer.from(challenge.challenge), keys.privateKey).toString('base64url'),
  })
  return { userId: publicUserId(publicKey), token: session.token }
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'mtc-notify-atomic-'))
  const app = createCentralServer({ directory, mode: 'public', adminToken: 'test-only-notification-atomicity-admin' })
  const f = { directory, app, url: `http://127.0.0.1:${(await app.listen(0)).port}`, quotaBlocked: false }
  fixtures.push(f)
  // Exercise the actual enqueue() quota branch without creating 512 MiB of
  // fixture data. This function only changes the queue byte accounting query;
  // normal requests still use real SQLite transactions, delivery rows and HTTP.
  app.db.function('length', value => f.quotaBlocked ? 512 * 1024 * 1024 : value === null ? null : value.length)
  f.a = await login(f, 'Alice')
  f.b = await login(f, 'Bob')
  f.c = await login(f, 'Carol')
  const id = randomUUID()
  app.db.prepare('INSERT INTO queue VALUES (?,?,?,?)').run(id, f.a.userId, JSON.stringify({ id, kind: 'directory' }), Date.now())
  return f
}

const tables = ['meta', 'users', 'friends', 'groups', 'members', 'group_requests', 'plugins', 'queue', 'queue_devices']
function snapshot(f) {
  return Object.fromEntries(tables.map(table => [table, f.app.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
}

async function failsAtomically(f, route, user, body) {
  const before = snapshot(f)
  f.quotaBlocked = true
  try {
    const result = await request(f, route, user.token, body, 507)
    expect(result.error).toBe('服务器暂存空间已满')
    expect(snapshot(f)).toEqual(before)
  } finally { f.quotaBlocked = false }
}

async function befriend(f, a, b) {
  await request(f, 'friends/request', a.token, { userId: b.userId })
  await request(f, 'friends/accept', b.token, { userId: a.userId })
}

function pack() {
  return { id: 'gplugin_' + randomUUID(), version: 1, displayName: 'Atomic chain', kind: 'chain', slot: 'chat.details' }
}

describe('directory mutations and durable notifications are atomic', () => {
  it('rolls back every friendship change on a full queue and permits a later retry', async () => {
    const f = await fixture()
    await failsAtomically(f, 'friends/request', f.a, { userId: f.b.userId })
    await request(f, 'friends/request', f.a.token, { userId: f.b.userId })
    await failsAtomically(f, 'friends/accept', f.b, { userId: f.a.userId })
    await failsAtomically(f, 'friends/cancel', f.a, { userId: f.b.userId })
    await failsAtomically(f, 'friends/reject', f.b, { userId: f.a.userId })
    await request(f, 'friends/accept', f.b.token, { userId: f.a.userId })
    await failsAtomically(f, 'friends/remove', f.a, { userId: f.b.userId })
    await request(f, 'friends/remove', f.a.token, { userId: f.b.userId })
    expect(f.app.db.prepare('SELECT COUNT(*) AS n FROM friends').get().n).toBe(0)
  })

  it('rolls back group creation, join, membership and administration without losing requests or plugins', async () => {
    const f = await fixture()
    await befriend(f, f.a, f.b)
    await befriend(f, f.a, f.c)
    await failsAtomically(f, 'groups', f.a, { name: 'Not secretly created', memberIds: [f.b.userId] })
    const { groupId } = await request(f, 'groups', f.a.token, { name: 'Original name', memberIds: [f.b.userId] })
    await request(f, 'plugins/submit', f.b.token, { groupId, pack: pack() })
    await failsAtomically(f, 'groups/join', f.c, { groupId })
    await request(f, 'groups/join', f.c.token, { groupId })
    await failsAtomically(f, 'groups/accept', f.a, { groupId, userId: f.c.userId })
    await failsAtomically(f, 'groups/reject', f.a, { groupId, userId: f.c.userId })
    await failsAtomically(f, 'groups/invite', f.a, { groupId, userId: f.c.userId })
    for (const [route, user, extra] of [
      ['groups/rename', f.a, { name: 'Not secretly renamed' }],
      ['groups/kick', f.a, { userId: f.b.userId }],
      ['groups/transfer', f.a, { userId: f.b.userId }],
      ['groups/leave', f.b, {}],
      ['groups/dissolve', f.a, {}],
    ]) await failsAtomically(f, route, user, { groupId, ...extra })
    await request(f, 'groups/dissolve', f.a.token, { groupId })
    expect(f.app.db.prepare('SELECT COUNT(*) AS n FROM groups').get().n).toBe(0)
    expect(f.app.db.prepare('SELECT COUNT(*) AS n FROM plugins').get().n).toBe(0)
  })

  it('keeps pending plugin versions and the previous approved state intact when approval cannot notify members', async () => {
    const f = await fixture()
    await befriend(f, f.a, f.b)
    const { groupId } = await request(f, 'groups', f.a.token, { name: 'Plugin group', memberIds: [f.b.userId] })
    const first = pack()
    await failsAtomically(f, 'plugins/submit', f.b, { groupId, pack: first })
    const submitted = await request(f, 'plugins/submit', f.b.token, { groupId, pack: first })
    const review = { groupId, pluginId: first.id, version: 1, digest: submitted.digest, approve: true }
    await failsAtomically(f, 'plugins/review', f.a, review)
    await request(f, 'plugins/review', f.a.token, review)
    await request(f, 'plugins/event', f.b.token, { groupId, pluginId: first.id, channel: 'state', payload: { text: 'Keep this state' }, expectedRevision: 0 })
    const next = await request(f, 'plugins/submit', f.b.token, { groupId, pack: { ...first, version: 2 } })
    const nextReview = { ...review, version: 2, digest: next.digest }
    await failsAtomically(f, 'plugins/review', f.a, nextReview)
    await failsAtomically(f, 'plugins/review', f.a, { ...nextReview, approve: false })
    await request(f, 'plugins/review', f.a.token, nextReview)
    const current = f.app.db.prepare("SELECT revision,state FROM plugins WHERE status='approved'").get()
    expect(current.revision).toBe(1)
    expect(JSON.parse(current.state).entries[0].text).toBe('Keep this state')
  })

  it('notifies newly accepted/invited members after commit and former members when they leave', async () => {
    const f = await fixture()
    await befriend(f, f.a, f.b)
    await befriend(f, f.a, f.c)
    const { groupId } = await request(f, 'groups', f.a.token, { name: 'Recipients group', memberIds: [f.b.userId] })
    async function mutation(route, user, body, recipients) {
      const before = new Set(f.app.db.prepare('SELECT id FROM queue').all().map(row => row.id))
      const revision = Number(f.app.db.prepare("SELECT value FROM meta WHERE key='revision'").get().value)
      await request(f, route, user.token, body)
      const newRows = f.app.db.prepare('SELECT id,recipient FROM queue').all().filter(row => !before.has(row.id))
      expect(new Set(newRows.map(row => row.id)).size).toBe(1)
      expect(newRows.map(row => row.recipient).sort()).toEqual(recipients.map(item => item.userId).sort())
      expect(Number(f.app.db.prepare("SELECT value FROM meta WHERE key='revision'").get().value)).toBe(revision + 1)
    }
    await request(f, 'groups/join', f.c.token, { groupId })
    await mutation('groups/accept', f.a, { groupId, userId: f.c.userId }, [f.a, f.b, f.c])
    await mutation('groups/leave', f.c, { groupId }, [f.a, f.b, f.c])
    await mutation('groups/invite', f.a, { groupId, userId: f.c.userId }, [f.a, f.b, f.c])
  })

  it('rolls back a mutation and earlier recipient notifications when a later SQLite queue write fails', async () => {
    const f = await fixture()
    const before = snapshot(f)
    f.app.db.exec(`CREATE TRIGGER fail_second_recipient BEFORE INSERT ON queue WHEN NEW.recipient='${f.b.userId}' BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END`)
    const result = await request(f, 'friends/request', f.a.token, { userId: f.b.userId }, 500)
    expect(result.error).not.toContain('simulated disk failure')
    expect(snapshot(f)).toEqual(before)
    f.app.db.exec('DROP TRIGGER fail_second_recipient')
    await request(f, 'friends/request', f.a.token, { userId: f.b.userId })
    expect(f.app.db.prepare('SELECT COUNT(*) AS n FROM friends').get().n).toBe(1)
  })
})
