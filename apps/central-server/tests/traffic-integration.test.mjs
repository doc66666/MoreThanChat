import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCentralServer } from '../src/server.mjs'

const fixtures = [], requests = []
const admin = 'traffic-integration-test-admin-token'
afterEach(async () => {
  vi.restoreAllMocks()
  for (const request of requests.splice(0)) request.destroy()
  for (const f of fixtures.splice(0)) {
    await f.app.close()
    await rm(f.directory, { recursive: true, force: true })
  }
})
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'mtc-traffic-'))
  const app = createCentralServer({ directory, mode: 'public', adminToken: admin, shutdownTimeoutMs: 100 })
  const f = { app, directory, url: `http://127.0.0.1:${(await app.listen(0)).port}` }
  fixtures.push(f)
  return f
}
async function call(f, route, token, body, extraHeaders = {}) {
  const response = await fetch(f.url + '/v1/' + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  })
  return { status: response.status, data: await response.json(), retryAfter: response.headers.get('retry-after') }
}
async function login(f, keys = generateKeyPairSync('ed25519')) {
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
  const challenge = await call(f, 'challenge', null, { publicKey, displayName: 'Traffic user', features: ['message-actions-v1'] })
  expect(challenge.status).toBe(200)
  const result = await call(f, 'session', null, {
    challengeId: challenge.data.challengeId,
    signature: sign(null, Buffer.from(challenge.data.challenge), keys.privateKey).toString('base64url'),
  })
  expect(result.status).toBe(200)
  return { keys, token: result.data.token, uid: challenge.data.userId }
}
async function friends(f, a, b) {
  expect((await call(f, 'friends/request', a.token, { userId: b.uid })).status).toBe(200)
  expect((await call(f, 'friends/accept', b.token, { userId: a.uid })).status).toBe(200)
}
const message = b => ({ clientMessageId: randomUUID(), targetKind: 'direct', targetId: b.uid, text: 'Traffic verification' })
async function partial(f, route, token, contentLength) {
  let resolve
  const result = new Promise(done => { resolve = done })
  const received = once(f.app.server, 'request')
  const request = httpRequest(f.url + '/v1/' + route, {
    method: 'POST', agent: false,
    headers: { authorization: `Bearer ${token}`, ...(contentLength ? { 'content-length': contentLength } : {}) },
  }, response => {
    response.resume()
    response.once('end', () => resolve(response.statusCode))
  })
  requests.push(request)
  request.on('error', error => resolve(error.code))
  request.write('{')
  await received
  return { request, result }
}

describe('traffic isolation over real HTTP', () => {
  it('charges login per verified identity and rejects excess before changing the saved profile', async () => {
    const f = await fixture(), keys = generateKeyPairSync('ed25519')
    vi.spyOn(performance, 'now').mockReturnValue(performance.now())
    const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
    const forged = await call(f, 'challenge', null, { publicKey, displayName: 'Forged' })
    expect((await call(f, 'session', null, { challengeId: forged.data.challengeId, signature: Buffer.alloc(64).toString('base64url') })).status).toBe(401)
    let user
    for (let i = 0; i < 16; i++) user = await login(f, keys)
    const challenge = await call(f, 'challenge', null, { publicKey, displayName: 'Must not save this name' })
    const rejected = await call(f, 'session', null, {
      challengeId: challenge.data.challengeId,
      signature: sign(null, Buffer.from(challenge.data.challenge), keys.privateKey).toString('base64url'),
    })
    expect(rejected).toMatchObject({ status: 429, retryAfter: '2' })
    expect(f.app.db.prepare('SELECT name FROM users WHERE id=?').get(user.uid).name).toBe('Traffic user')
    expect((await call(f, 'admin/status', admin)).data.runtime.activeSessions).toBe(16)
    expect((await call(f, 'directory', user.token)).status).toBe(200)
  })

  it('shares write limits across sessions, isolates users/plugins and still ACKs a saturated sender', async () => {
    const f = await fixture(), a = await login(f), b = await login(f)
    await friends(f, a, b)
    const incoming = await call(f, 'messages', b.token, message(a))
    // Freeze only the monotonic budget clock; HTTP and SQLite remain real.
    vi.spyOn(performance, 'now').mockReturnValue(performance.now())
    let limited
    for (let i = 0; i < 120; i++) {
      limited = await call(f, 'messages', a.token, message(b))
      if (limited.status === 429) break
      expect(limited.status).toBe(200)
    }
    expect(limited).toMatchObject({ status: 429, retryAfter: '1' })
    const second = await login(f, a.keys)
    expect((await call(f, 'messages', second.token, message(b))).status).toBe(429)
    const rowCount = f.app.db.prepare('SELECT COUNT(*) AS n FROM message_routes').get().n
    expect((await call(f, 'messages', a.token, message(b))).status).toBe(429)
    expect(f.app.db.prepare('SELECT COUNT(*) AS n FROM message_routes').get().n).toBe(rowCount)
    expect((await call(f, 'plugins/event', a.token, { groupId: 'missing' })).status).not.toBe(429)
    expect((await call(f, 'directory', a.token)).status).toBe(200)
    for (let i = 0; i < 120; i++) expect((await call(f, 'events', a.token)).status).toBe(200)
    expect((await call(f, 'events', a.token)).status).toBe(429)
    expect((await call(f, 'ack', a.token, { ids: [incoming.data.messageId] })).status).toBe(200)
    expect(f.app.db.prepare('SELECT 1 FROM queue WHERE id=?').get(incoming.data.messageId)).toBeUndefined()
    expect((await call(f, 'messages', b.token, message(a))).status).toBe(200)
  })

  it('reserves control capacity while ordinary request admission is full', async () => {
    const f = await fixture(), a = await login(f), b = await login(f)
    await friends(f, a, b)
    const incoming = await call(f, 'messages', b.token, message(a))
    const held = []
    // Trusted admin writes are used solely as deterministic held HTTP handlers.
    for (let i = 0; i < 224; i++) held.push(await partial(f, 'admin/access', admin))
    expect((await call(f, 'ping')).status).toBe(429)
    expect((await call(f, 'messages', a.token, message(b))).status).toBe(429)
    expect((await call(f, 'admin/status', admin)).status).toBe(200)
    expect((await call(f, 'ack', a.token, { ids: [incoming.data.messageId] })).status).toBe(200)
    expect(f.app.db.prepare('SELECT 1 FROM queue WHERE id=?').get(incoming.data.messageId)).toBeUndefined()
    for (const item of held) item.request.end('}')
    expect((await Promise.all(held.map(item => item.result))).every(status => status === 400)).toBe(true)
    expect((await call(f, 'messages', a.token, message(b))).status).toBe(200)
  })

  it('bounds incomplete uploads without consuming ACK capacity and releases them on abort/error', async () => {
    const f = await fixture(), a = await login(f), b = await login(f)
    await friends(f, a, b)
    const held = []
    for (let i = 0; i < 4; i++) held.push(await partial(f, 'messages', a.token))
    expect((await call(f, 'messages', b.token, message(a))).status).toBe(429)
    expect((await call(f, 'ack', a.token, { ids: [] })).status).toBe(200)
    held[0].request.destroy()
    await held[0].result
    for (const item of held.slice(1)) item.request.end('}')
    await Promise.all(held.slice(1).map(item => item.result))
    expect((await call(f, 'messages', b.token, message(a))).status).toBe(200)
  })

  it('returns 413 for declared and chunked oversized control bodies without accepting a late mutation', async () => {
    const f = await fixture(), a = await login(f)
    const declared = await partial(f, 'ack', a.token, 16385)
    expect(await declared.result).toBe(413)
    const chunked = await partial(f, 'ack', a.token)
    chunked.request.write(' '.repeat(17000))
    expect(await chunked.result).toBe(413)
    expect((await call(f, 'ack', a.token, { ids: [] })).status).toBe(200)
    const largeAuth = await partial(f, 'challenge', 'unused', 8193)
    expect(await largeAuth.result).toBe(413)
    const largeMessage = await partial(f, 'messages', a.token, 8 * 1024 * 1024 + 1)
    expect(await largeMessage.result).toBe(413)
    expect(f.app.db.prepare('SELECT COUNT(*) AS n FROM queue').get().n).toBe(0)
  })

  it('bounds unauthenticated authentication work and ignores spoofed proxy identities', async () => {
    const f = await fixture()
    let response
    for (let i = 0; i < 500; i++) {
      response = await call(f, 'challenge', null, { publicKey: 'invalid', displayName: 'test' }, { 'x-forwarded-for': `192.0.2.${i % 255}` })
      if (response.status === 429) break
      expect(response.status).toBe(400)
    }
    expect(response).toMatchObject({ status: 429, retryAfter: '1' })
    expect((await call(f, 'admin/status', admin)).status).toBe(200)
    expect(f.app.db.prepare('SELECT COUNT(*) AS n FROM users').get().n).toBe(0)
  })
})
