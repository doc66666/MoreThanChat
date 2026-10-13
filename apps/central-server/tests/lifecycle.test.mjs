import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { generateKeyPairSync, sign } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCentralServer, publicUserId } from '../src/server.mjs'

const fixtures = [], children = [], sockets = []
const adminToken = 'lifecycle-test-admin-token-not-production'
afterEach(async () => {
  vi.restoreAllMocks()
  for (const socket of sockets.splice(0)) socket.destroy()
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'close') }
  }
  for (const f of fixtures.splice(0)) {
    await Promise.allSettled(f.apps.map(app => app.close()))
    await rm(f.directory, { recursive: true, force: true })
  }
})
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function fixture(options = {}, listen = true) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mtc-lifecycle-'))
  const f = { directory, apps: [] }
  fixtures.push(f)
  f.app = createCentralServer({ directory, mode: 'public', adminToken, ...options })
  f.apps.push(f.app)
  if (listen) f.url = `http://127.0.0.1:${(await f.app.listen(0)).port}`
  return f
}
function restart(f, options = {}) {
  const app = createCentralServer({ directory: f.directory, mode: 'public', adminToken, ...options })
  f.apps.push(app)
  return app
}
async function request(f, route, token, body) {
  const response = await fetch(f.url + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, data: await response.json(), retryAfter: response.headers.get('retry-after') }
}
async function login(f) {
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
  const challenge = await request(f, '/v1/challenge', null, { publicKey, displayName: 'Lifecycle user' })
  expect(challenge.status).toBe(200)
  const session = await request(f, '/v1/session', null, {
    challengeId: challenge.data.challengeId,
    signature: sign(null, Buffer.from(challenge.data.challenge), keys.privateKey).toString('base64url'),
  })
  expect(session.status).toBe(200)
  return { token: session.data.token, userId: publicUserId(publicKey) }
}
async function partialPost(f, body) {
  let resolveResult
  const result = new Promise(resolve => { resolveResult = resolve })
  const received = once(f.app.server, 'request')
  const req = httpRequest(f.url + '/v1/admin/access', {
    method: 'POST', headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
  }, response => {
    const chunks = []
    response.on('data', chunk => chunks.push(chunk))
    response.on('end', () => resolveResult({ status: response.statusCode, data: Buffer.concat(chunks).toString() }))
  })
  req.on('error', error => resolveResult({ error: error.code }))
  sockets.push(req)
  req.write(JSON.stringify(body).slice(0, 1))
  await received
  return { req, result, finish: () => req.end(JSON.stringify(body).slice(1)) }
}

describe('central server lifecycle', () => {
  it.each([
    { mode: 'private', list: 'whitelist', initialStatus: 200, allowed: false, restoredStatus: 403 },
    { mode: 'public', list: 'blacklist', initialStatus: 403, allowed: true, restoredStatus: 200 },
  ])('preserves administrator access decisions over $mode bootstrap seeds after restart', async ({ mode, list, initialStatus, allowed, restoredStatus }) => {
    const keys = generateKeyPairSync('ed25519')
    const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
    const userId = publicUserId(publicKey)
    const options = { mode, [list]: [userId] }
    const f = await fixture(options)
    const credentials = { publicKey, displayName: 'Bootstrap user' }
    expect((await request(f, '/v1/challenge', null, credentials)).status).toBe(initialStatus)
    expect((await request(f, '/v1/admin/access', adminToken, { userId, allowed })).status).toBe(200)
    await f.app.close()
    const addedSeed = 'usr_' + 'd'.repeat(64)
    f.app = restart(f, { ...options, [list]: [userId, addedSeed] })
    f.url = `http://127.0.0.1:${(await f.app.listen(0)).port}`
    expect(f.app.db.prepare('SELECT allowed FROM access WHERE id=?').get(userId).allowed).toBe(allowed ? 1 : 0)
    expect(f.app.db.prepare('SELECT allowed FROM access WHERE id=?').get(addedSeed).allowed).toBe(mode === 'private' ? 1 : 0)
    const challenge = await request(f, '/v1/challenge', null, credentials)
    expect(challenge.status).toBe(restoredStatus)
    if (allowed) expect((await request(f, '/v1/session', null, {
      challengeId: challenge.data.challengeId,
      signature: sign(null, Buffer.from(challenge.data.challenge), keys.privateKey).toString('base64url'),
    })).status).toBe(200)
  })

  it('locks a directory before listen and releases exactly once on close', async () => {
    const f = await fixture({}, false)
    expect(f.app.state).toBe('starting')
    expect(() => restart(f)).toThrow(/already in use/)
    const first = f.app.close()
    expect(f.app.close()).toBe(first)
    await first
    expect(f.app.state).toBe('closed')
    await expect(f.app.listen(0)).rejects.toThrow(/closed/)
    const replacement = restart(f)
    expect(replacement.serverId).toBe(f.app.serverId)
    await replacement.close()
  })

  it('releases DB and directory lock after initialization and listen failures', async () => {
    const occupied = await fixture(), f = await fixture({}, false)
    await f.app.close()
    expect(() => restart(f, { mode: 'private' })).toThrow(/immutable/)
    const replacement = restart(f)
    await expect(replacement.listen(occupied.app.server.address().port)).rejects.toMatchObject({ code: 'EADDRINUSE' })
    expect(replacement.state).toBe('closed')
    expect(replacement.server.listenerCount('error')).toBe(0)
    const retry = restart(f)
    await retry.listen(0)
    expect(retry.state).toBe('ready')
  })

  it('handles close racing listen and removes temporary listener hooks', async () => {
    const f = await fixture({}, false)
    const listening = f.app.listen(0)
    const closed = f.app.close()
    await expect(listening).rejects.toThrow(/closed/)
    await closed
    expect(f.app.state).toBe('closed')
    expect(f.app.server.listening).toBe(false)
    expect(f.app.server.listenerCount('error')).toBe(0)
    await restart(f).close()
  })

  it('releases directory ownership when a schema migration fails', async () => {
    const f = await fixture({}, false)
    await f.app.close()
    const broken = new DatabaseSync(path.join(f.directory, 'relay.sqlite'))
    broken.exec('DROP TABLE devices; CREATE TABLE devices(wrong TEXT)')
    broken.close()
    // Factory initialization hits a schema mismatch, not a HTTP handler error.
    const original = DatabaseSync.prototype.exec
    const stub = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function(sql) {
      if (sql.startsWith('CREATE TABLE IF NOT EXISTS devices')) throw new Error('migration unavailable')
      return original.call(this, sql)
    })
    expect(() => restart(f)).toThrow(/migration unavailable/)
    stub.mockRestore()
    const repair = new DatabaseSync(path.join(f.directory, 'relay.sqlite'))
    repair.exec('DROP TABLE devices')
    repair.close()
    await restart(f).close()
  })

  it('releases an OS directory lock after a killed child, without stale-lock deletion', async () => {
    const f = await fixture({}, false)
    await f.app.close()
    const moduleUrl = new URL('../src/server.mjs', import.meta.url).href
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { createCentralServer } from ${JSON.stringify(moduleUrl)};
      const app = createCentralServer({directory:process.argv[1],mode:'public',adminToken:${JSON.stringify(adminToken)}});
      await app.listen(0); process.send({id:app.serverId});
    `, f.directory], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true })
    children.push(child)
    const [ready] = await once(child, 'message')
    expect(() => restart(f)).toThrow(/already in use/)
    const exited = once(child, 'close')
    child.kill('SIGKILL')
    await exited
    expect(restart(f).serverId).toBe(ready.id)
  })

  it('exposes minimal health/readiness and protects aggregate admin status', async () => {
    const f = await fixture()
    expect(await request(f, '/healthz')).toMatchObject({ status: 200, data: { status: 'alive' } })
    expect(await request(f, '/readyz')).toMatchObject({ status: 200, data: { status: 'ready' } })
    expect((await request(f, '/v1/ping')).data.features).toContain('device-delivery-v1')
    expect((await request(f, '/v1/admin/status')).status).toBe(403)
    const user = await login(f)
    expect((await request(f, '/v1/admin/status', user.token)).status).toBe(403)
    const stats = await request(f, '/v1/admin/status', adminToken)
    expect(stats.status).toBe(200)
    expect(stats.data).toMatchObject({ version: 1, users: 1, queue: { rows: 0, payloadBytes: 0, oldestAgeMs: null } })
    expect(JSON.stringify(stats.data)).not.toContain(user.userId)
    const prepare = f.app.db.prepare.bind(f.app.db)
    vi.spyOn(f.app.db, 'prepare').mockImplementation(sql => {
      if (sql === "SELECT value FROM meta WHERE key='id'") throw new Error('private DB diagnostic')
      return prepare(sql)
    })
    expect(await request(f, '/readyz')).toMatchObject({ status: 503, data: { status: 'not-ready' }, retryAfter: '1' })
    expect((await request(f, '/healthz')).status).toBe(200)
  })

  it('fails readiness if the persisted server identity disappears while keeping liveness minimal', async () => {
    const f = await fixture()
    f.app.db.exec("DELETE FROM meta WHERE key='id'")
    expect(await request(f, '/readyz')).toMatchObject({ status: 503, data: { status: 'not-ready' } })
    expect(await request(f, '/healthz')).toMatchObject({ status: 200, data: { status: 'alive' } })
  })

  it('drains an accepted partial write and makes it durable before releasing the directory', async () => {
    const f = await fixture({ shutdownTimeoutMs: 500 })
    const userId = 'usr_' + 'a'.repeat(64)
    const upload = await partialPost(f, { userId, allowed: false })
    const closing = f.app.close()
    expect(f.app.state).toBe('draining')
    expect(() => restart(f)).toThrow(/already in use/)
    upload.finish()
    expect((await upload.result).status).toBe(200)
    await closing
    const restored = restart(f)
    expect(restored.db.prepare('SELECT allowed FROM access WHERE id=?').get(userId).allowed).toBe(0)
  })

  it('aborts an unfinished body at deadline without applying a late write', async () => {
    const failures = [], f = await fixture({ shutdownTimeoutMs: 60, onError: error => failures.push(error) })
    const userId = 'usr_' + 'b'.repeat(64)
    const upload = await partialPost(f, { userId, allowed: false })
    const started = Date.now()
    await f.app.close()
    expect(Date.now() - started).toBeLessThan(1000)
    expect((await upload.result).error).toBeTruthy()
    upload.finish()
    await delay(20)
    const restored = restart(f)
    expect(restored.db.prepare('SELECT allowed FROM access WHERE id=?').get(userId)).toBeUndefined()
    expect(failures).toEqual([])
  })

  it('releases long polls promptly and reports not-ready to parsed traffic while draining', async () => {
    const f = await fixture({ shutdownTimeoutMs: 500 }), user = await login(f)
    const received = once(f.app.server, 'request')
    const poll = request(f, '/v1/events', user.token)
    await received
    const stalled = await partialPost(f, { userId: user.userId, allowed: true })
    const closing = f.app.close()
    // Model requests already parsed on a keep-alive socket. The listener itself
    // closes immediately, so new TCP connections correctly cannot probe it.
    for (const route of ['/readyz', '/v1/ping']) {
      const response = { destroyed: false, writableEnded: false, writeHead: vi.fn(), end: vi.fn() }
      f.app.server.emit('request', { method: 'GET', url: route }, response)
      expect(response.writeHead.mock.calls[0][0]).toBe(503)
      expect(response.writeHead.mock.calls[0][1].connection).toBe('close')
    }
    stalled.finish()
    expect((await poll).status).toBe(503)
    await closing
  })

  it('limits concurrent long polls per device and frees slots on disconnect', async () => {
    const f = await fixture(), user = await login(f)
    const controllers = [new AbortController(), new AbortController()]
    const polls = []
    for (const controller of controllers) {
      const received = once(f.app.server, 'request')
      polls.push(fetch(f.url + '/v1/events', { headers: { authorization: `Bearer ${user.token}` }, signal: controller.signal }).catch(() => null))
      await received
    }
    expect(await request(f, '/v1/events', user.token)).toMatchObject({ status: 429, retryAfter: '1' })
    controllers[0].abort()
    await polls[0]
    await delay(20)
    const stats = await request(f, '/v1/admin/status', adminToken)
    expect(stats.data.runtime.pendingPolls).toBe(1)
    await f.app.close()
    expect((await polls[1]).status).toBe(503)
  })

  it('bounds active body handlers and still answers lightweight health checks under load', async () => {
    const f = await fixture({ shutdownTimeoutMs: 60 })
    const body = { userId: 'usr_' + 'c'.repeat(64), allowed: false }
    const uploads = []
    for (let index = 0; index < 256; index++) uploads.push(await partialPost(f, body))
    expect(await request(f, '/v1/ping')).toMatchObject({ status: 429, retryAfter: '1' })
    expect((await request(f, '/healthz')).status).toBe(200)
    expect(f.app.server.maxConnections).toBe(1024)
    await f.app.close()
    await Promise.all(uploads.map(upload => upload.result))
    const restored = restart(f)
    expect(restored.db.prepare('SELECT 1 FROM access WHERE id=?').get(body.userId)).toBeUndefined()
  })

  it('bounds shutdown when a connection has sent only partial HTTP headers', async () => {
    const f = await fixture({ shutdownTimeoutMs: 60 })
    const accepted = once(f.app.server, 'connection')
    const socket = connect(f.app.server.address().port, '127.0.0.1')
    sockets.push(socket)
    socket.on('error', () => {})
    await accepted
    socket.write('GET /healthz HTTP/1.1\r\n')
    await delay(10)
    const started = Date.now()
    await f.app.close()
    expect(Date.now() - started).toBeLessThan(1000)
    expect(f.app.state).toBe('closed')
    await restart(f).close()
  })

  it('does not expose internal errors or misclassify malformed client keys', async () => {
    const errors = [], f = await fixture({ onError: error => errors.push(error) }), user = await login(f)
    expect((await request(f, '/v1/challenge', null, { publicKey: 'not-a-key', displayName: 'Invalid' })).status).toBe(400)
    f.app.db.exec('DROP TABLE users')
    const failed = await request(f, '/v1/directory?private=secret', user.token)
    expect(failed.status).toBe(500)
    expect(JSON.stringify(failed.data)).not.toContain('users')
    expect(errors).toEqual([{ code: 'REQUEST_FAILED', route: '/v1/directory' }])
  })
})
