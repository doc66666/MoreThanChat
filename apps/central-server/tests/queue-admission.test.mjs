import { mkdtemp, rm } from 'node:fs/promises'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCentralServer, publicUserId } from '../src/server.mjs'

const fixtures = [], BUDGET = 512 * 1024 * 1024
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
function identity() {
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
  return { ...keys, publicKey, userId: publicUserId(publicKey) }
}
async function login(f, keys, name) {
  const deviceId = randomUUID()
  const challenge = await request(f, 'challenge', null, {
    publicKey: keys.publicKey, displayName: name, deviceId, deviceName: name,
    features: ['device-delivery-v1', 'message-actions-v1'],
  })
  const session = await request(f, 'session', null, {
    challengeId: challenge.challengeId,
    signature: sign(null, Buffer.from(challenge.challenge), keys.privateKey).toString('base64url'),
  })
  return { userId: keys.userId, deviceId, token: session.token }
}
async function befriend(f, a, b) {
  await request(f, 'friends/request', a.token, { userId: b.userId })
  await request(f, 'friends/accept', b.token, { userId: a.userId })
}
const rows = f => f.app.db.prepare('SELECT * FROM queue ORDER BY rowid').all()
const bytes = f => f.app.db.prepare('SELECT COALESCE(SUM(length(CAST(payload AS BLOB))),0) AS n FROM queue').get().n
const obligations = (f, id) => f.app.db.prepare('SELECT device_id FROM queue_devices WHERE event_id=? ORDER BY device_id').all(id).map(row => row.device_id)
const ack = (f, user, ids, status = 200) => request(f, 'ack', user.token, { ids }, status)
const read = (f, user, ids, status = 200) => request(f, 'read', user.token, { ids }, status)

async function fixture(offset) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mtc-queue-admission-'))
  const app = createCentralServer({ directory, mode: 'public', adminToken: 'test-only-queue-admission-admin-token' })
  const f = { directory, app, url: `http://127.0.0.1:${(await app.listen(0)).port}` }
  fixtures.push(f)
  f.a = await login(f, identity(), 'Alice')
  const bob = identity()
  f.b1 = await login(f, bob, 'Bob 1')
  f.b2 = await login(f, bob, 'Bob 2')
  f.c = await login(f, identity(), 'Carol')
  await befriend(f, f.a, f.b1)
  await befriend(f, f.a, f.c)
  f.groupId = (await request(f, 'groups', f.a.token, { name: 'Admission test', memberIds: [f.b1.userId] })).groupId
  f.pack = { id: 'gplugin_' + randomUUID(), version: 1, displayName: 'Channel', kind: 'channel', slot: 'chat.details' }
  const submission = await request(f, 'plugins/submit', f.a.token, { groupId: f.groupId, pack: f.pack })
  await request(f, 'plugins/review', f.a.token, { groupId: f.groupId, pluginId: f.pack.id, version: 1, digest: submission.digest, approve: true })
  for (const user of [f.a, f.b1, f.b2, f.c]) {
    const events = await request(f, 'events', user.token)
    await ack(f, user, events.events.map(event => event.id))
  }
  const anchor = await request(f, 'messages', f.a.token, { clientMessageId: randomUUID(), targetKind: 'direct', targetId: f.c.userId, text: 'Simulated existing backlog' })
  f.anchorId = anchor.messageId
  const message = await request(f, 'messages', f.a.token, { clientMessageId: randomUUID(), targetKind: 'group', targetId: f.groupId, text: 'Deliver despite backlog' })
  f.messageId = message.messageId
  // Avoid a 512 MiB fixture: assign extra accounting cost to one existing body.
  // Every real HTTP handler, durable queue row and SQLite transaction remains in use.
  const extra = BUDGET + offset - bytes(f)
  app.db.function('length', value => value.length + (Buffer.from(value).toString().includes(f.anchorId) ? extra : 0))
  expect(bytes(f)).toBe(BUDGET + offset)
  return f
}

async function rejectsNewTraffic(f) {
  const before = rows(f)
  const result = await request(f, 'messages', f.a.token, {
    clientMessageId: randomUUID(), targetKind: 'direct', targetId: f.b1.userId,
    text: 'New traffic cannot claim a control budget', budget: 'delivery-control-budget', quotaExempt: true,
  }, 507)
  expect(result.error).toBe('服务器暂存空间已满')
  await request(f, 'plugins/event', f.a.token, {
    groupId: f.groupId, pluginId: f.pack.id, channel: 'message-receipt',
    payload: { kind: 'directory', receipt: { messageId: f.messageId }, quotaExempt: true },
  }, 507)
  expect(rows(f)).toEqual(before)
}

async function clearEverything(f) {
  // ACK only actual obligations and repeat once because ACKs can emit a receipt
  // to a user handled earlier in this loop. No queue rows are manually deleted.
  for (let pass = 0; pass < 3; pass++) for (const user of [f.c, f.b1, f.b2, f.a]) {
    const ids = f.app.db.prepare('SELECT event_id FROM queue_devices WHERE user_id=? AND device_id=?').all(user.userId, user.deviceId).map(row => row.event_id)
    await ack(f, user, ids)
  }
  expect(rows(f)).toEqual([])
  expect(f.app.db.prepare('SELECT COUNT(*) AS n FROM queue_devices').get().n).toBe(0)
}

describe('delivery control traffic can drain a full business queue', () => {
  for (const offset of [-1, 1024]) {
    it(`advances each device ACK ${offset < 0 ? 'just below' : 'above'} the admission budget without admitting new messages or plugin traffic`, async () => {
      const f = await fixture(offset)
      await rejectsNewTraffic(f)
      await ack(f, f.b1, [f.messageId])
      expect(obligations(f, f.messageId)).toEqual([f.b2.deviceId])
      expect(f.app.db.prepare('SELECT 1 FROM queue WHERE id=?').get(f.messageId)).toBeDefined()
      const once = rows(f)
      await ack(f, f.b1, [f.messageId])
      expect(rows(f)).toEqual(once)
      if (offset > 0) await rejectsNewTraffic(f)
      await ack(f, f.b2, [f.messageId])
      expect(obligations(f, f.messageId)).toEqual([])
      expect(f.app.db.prepare('SELECT 1 FROM queue WHERE id=?').get(f.messageId)).toBeUndefined()
      const receipts = rows(f).map(row => JSON.parse(row.payload)).filter(event => event.receipt?.messageId === f.messageId)
      expect(receipts).toHaveLength(1)
      expect(receipts[0].receipt.deliveredCount).toBe(1)
      await clearEverything(f)
      await request(f, 'messages', f.a.token, { clientMessageId: randomUUID(), targetKind: 'direct', targetId: f.b1.userId, text: 'Admission resumes after drain' })
    })

    it(`advances read acknowledgements and one-time cross-device read events ${offset < 0 ? 'just below' : 'above'} the admission budget`, async () => {
      const f = await fixture(offset)
      await read(f, f.b1, [f.messageId])
      expect(obligations(f, f.messageId)).toEqual([f.b2.deviceId])
      const controls = rows(f).map(row => JSON.parse(row.payload))
      const synchronizedRead = controls.find(event => event.read?.messageId === f.messageId)
      expect(synchronizedRead).toBeDefined()
      expect(obligations(f, synchronizedRead.id)).toEqual([f.b2.deviceId])
      expect(controls.find(event => event.receipt?.messageId === f.messageId).receipt.readCount).toBe(1)
      const once = rows(f)
      await read(f, f.b1, [f.messageId, f.messageId])
      await read(f, f.a, [f.messageId, randomUUID()])
      await ack(f, f.a, [f.messageId])
      expect(rows(f)).toEqual(once)
      if (offset > 0) await rejectsNewTraffic(f)
      await read(f, f.b2, [f.messageId])
      expect(obligations(f, f.messageId)).toEqual([])
      expect(rows(f).filter(row => JSON.parse(row.payload).read?.messageId === f.messageId)).toHaveLength(1)
      await ack(f, f.b2, [synchronizedRead.id])
      const drained = rows(f)
      await read(f, f.b1, [f.messageId])
      await read(f, f.b2, [f.messageId])
      expect(rows(f)).toEqual(drained)
      await clearEverything(f)
    })
  }

  it('does not report a successful ACK or read when persisting its control notification actually fails', async () => {
    const f = await fixture(1024)
    const before = rows(f), pending = obligations(f, f.messageId)
    f.app.db.exec("CREATE TRIGGER fail_control BEFORE INSERT ON queue WHEN json_extract(NEW.payload,'$.kind')='directory' BEGIN SELECT RAISE(ABORT,'simulated disk full'); END")
    await ack(f, f.b1, [f.messageId], 500)
    await read(f, f.b1, [f.messageId], 500)
    expect(rows(f)).toEqual(before)
    expect(obligations(f, f.messageId)).toEqual(pending)
    expect(f.app.db.prepare('SELECT delivered_at,read_at FROM message_delivery WHERE message_id=?').get(f.messageId)).toMatchObject({ delivered_at: null, read_at: null })
    expect(f.app.db.prepare('SELECT COUNT(*) AS n FROM device_reads WHERE message_id=?').get(f.messageId).n).toBe(0)
    f.app.db.exec('DROP TRIGGER fail_control')
    await clearEverything(f)
  })
})
