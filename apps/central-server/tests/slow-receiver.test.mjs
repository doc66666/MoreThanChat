import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { connect } from 'node:net'
import { once } from 'node:events'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { createCentralServer } from '../src/server.mjs'

const fixtures = [], sockets = [], admin = 'slow-receiver-test-admin-token-only'
afterEach(async () => {
  vi.restoreAllMocks()
  for (const socket of sockets.splice(0)) socket.destroy()
  for (const f of fixtures.splice(0)) { await f.app.close(); await rm(f.directory, { recursive: true, force: true }) }
})
async function call(f, route, token, body) {
  const response = await fetch(f.url + '/v1/' + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000),
  })
  return { status: response.status, data: await response.json() }
}
async function login(f) {
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
  const challenge = await call(f, 'challenge', null, { publicKey, displayName: 'Slow receiver', features: ['message-actions-v1'] })
  const result = await call(f, 'session', null, { challengeId: challenge.data.challengeId, signature: sign(null, Buffer.from(challenge.data.challenge), keys.privateKey).toString('base64url') })
  expect(result.status).toBe(200)
  return { token: result.data.token, uid: challenge.data.userId }
}
async function until(check) {
  const end = Date.now() + 5000
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)) }
  throw new Error('Slow receiver condition timed out')
}
async function paused(f, token) {
  const socket = connect(f.app.server.address().port, '127.0.0.1')
  sockets.push(socket); socket.on('error', () => {})
  await once(socket, 'connect')
  socket.pause()
  socket.write(`GET /v1/events HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\n\r\n`)
  return socket
}

it('keeps slow-response bytes bounded, leaves bodies pending and redelivers after disconnect', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mtc-slow-receiver-'))
  const app = createCentralServer({ directory, mode: 'public', adminToken: admin, shutdownTimeoutMs: 100 })
  const f = { app, directory, url: `http://127.0.0.1:${(await app.listen(0)).port}` }; fixtures.push(f)
  const a = await login(f), b = await login(f)
  await call(f, 'friends/request', a.token, { userId: b.uid })
  await call(f, 'friends/accept', b.token, { userId: a.uid })
  for (const user of [a, b]) {
    const events = await call(f, 'events', user.token)
    await call(f, 'ack', user.token, { ids: events.data.events.map(event => event.id) })
  }
  const bytes = Buffer.alloc(5 * 1024 * 1024, 97)
  const attachment = { id: createHash('sha256').update(bytes).digest('hex'), name: 'slow.bin', mime: 'application/octet-stream', size: bytes.length, data: bytes.toString('base64') }
  const sent = await call(f, 'messages', a.token, { clientMessageId: randomUUID(), targetKind: 'direct', targetId: b.uid, text: '慢客户端😀', attachment })
  expect(sent.status).toBe(200)
  const stats = async () => (await call(f, 'admin/status', admin)).data.runtime.outbound
  const first = await paused(f, b.token), second = await paused(f, b.token)
  await until(async () => (await stats()).active === 2)
  const held = await stats()
  expect(held.bytes).toBeLessThan(16 * 1024 * 1024)
  expect((await call(f, 'events', b.token)).status).toBe(429)
  expect((await stats()).bytes).toBe(held.bytes)
  expect((await call(f, 'ack', a.token, { ids: [] })).status).toBe(200)
  expect(app.db.prepare('SELECT 1 FROM queue WHERE id=?').get(sent.data.messageId)).toBeTruthy()
  first.destroy(); second.destroy()
  await until(async () => (await stats()).active === 0)
  expect((await stats()).bytes).toBe(0)
  const received = await call(f, 'events', b.token)
  expect(received.status).toBe(200)
  const message = received.data.events.find(event => event.id === sent.data.messageId).message
  expect(message.text).toBe('慢客户端😀')
  expect(createHash('sha256').update(Buffer.from(message.attachment.data, 'base64')).digest('hex')).toBe(attachment.id)
  expect(app.db.prepare('SELECT 1 FROM queue WHERE id=?').get(sent.data.messageId)).toBeTruthy()
  await call(f, 'ack', b.token, { ids: [sent.data.messageId] })
  expect(app.db.prepare('SELECT 1 FROM queue WHERE id=?').get(sent.data.messageId)).toBeUndefined()
  const again = await call(f, 'messages', a.token, { clientMessageId: randomUUID(), targetKind: 'direct', targetId: b.uid, text: '', attachment })
  await paused(f, b.token)
  await until(async () => (await stats()).active === 1)
  const started = Date.now()
  await app.close()
  expect(Date.now() - started).toBeLessThan(2000)
  const restored = createCentralServer({ directory, mode: 'public', adminToken: admin })
  try { expect(restored.db.prepare('SELECT 1 FROM queue WHERE id=?').get(again.data.messageId)).toBeTruthy() } finally { await restored.close() }
}, 15000)

it('reuses the queue writer and can rebind after a rolled-back insert failure', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mtc-queue-rebind-'))
  const app = createCentralServer({ directory, mode: 'public', adminToken: admin })
  const f = { app, directory, url: `http://127.0.0.1:${(await app.listen(0)).port}` }; fixtures.push(f)
  const a = await login(f), b = await login(f)
  await call(f, 'friends/request', a.token, { userId: b.uid })
  await call(f, 'friends/accept', b.token, { userId: a.uid })
  const prepare = vi.spyOn(app.db, 'prepare')
  const body = { clientMessageId: randomUUID(), targetKind: 'direct', targetId: b.uid, text: 'failed then retried' }
  app.db.exec("CREATE TEMP TRIGGER reject_test_queue BEFORE INSERT ON queue BEGIN SELECT RAISE(ABORT, 'injected queue failure'); END")
  expect((await call(f, 'messages', a.token, body)).status).toBe(500)
  app.db.exec('DROP TRIGGER reject_test_queue')
  const retried = await call(f, 'messages', a.token, body)
  expect(retried.status).toBe(200)
  const next = await call(f, 'messages', a.token, { ...body, clientMessageId: randomUUID(), text: 'different bindings 😀' })
  expect(next.status).toBe(200)
  expect((await call(f, 'messages', a.token, body)).data.messageId).toBe(retried.data.messageId)
  const messages = (await call(f, 'events', b.token)).data.events.filter(event => event.kind === 'message')
  expect(messages.map(event => event.message.text)).toEqual([body.text, 'different bindings 😀'])
  // Only the failed native statement is replaced; subsequent sends reuse it.
  expect(prepare.mock.calls.filter(([sql]) => /INSERT OR IGNORE INTO queue VALUES/.test(sql))).toHaveLength(1)
})
