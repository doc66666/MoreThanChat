import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'

const args = process.argv.slice(2)
if (args.length && (args.length !== 2 || args[0] !== '--release')) {
  throw new Error('Usage: node scripts/verify-central-ops.mjs [--release <standalone-directory>]')
}
const root = path.resolve(import.meta.dirname, '..')
const entry = args.length
  ? path.join(path.resolve(args[1]), 'server.mjs')
  : path.join(root, 'apps', 'central-server', 'src', 'server.mjs')
const statusEntry = args.length
  ? path.join(path.resolve(args[1]), 'central-status.mjs')
  : path.join(root, 'scripts', 'central-status.mjs')
await access(entry)
await access(statusEntry)
const temporary = await mkdtemp(path.join(tmpdir(), 'mtc-central-ops-'))
const directory = path.join(temporary, 'relay')
const adminToken = randomBytes(32).toString('base64url')
const children = new Set()
const cleanupErrors = []

async function reservePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

async function start() {
  const port = await reservePort()
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MTC_SERVER_')))
  const child = spawn(process.execPath, [entry], {
    cwd: path.dirname(entry),
    windowsHide: true,
    env: {
      ...env,
      MTC_SERVER_DATA_DIR: directory,
      MTC_SERVER_MODE: 'public',
      MTC_SERVER_ADMIN_TOKEN: adminToken,
      MTC_SERVER_HOST: '127.0.0.1',
      MTC_SERVER_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const state = { child, url: `http://127.0.0.1:${port}`, output: '', exit: null }
  children.add(state)
  state.exited = new Promise(resolve => {
    child.once('error', error => { state.exit = { error: error.message }; resolve(state.exit) })
    child.once('exit', (code, signal) => { state.exit = { code, signal }; resolve(state.exit) })
  })
  const capture = chunk => {
    state.output = (state.output + chunk.toString()).slice(-16384)
  }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  return state
}

async function waitForReady(state) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (state.exit) throw new Error(`Server exited before readiness: ${safeOutput(state)}`)
    try {
      const response = await fetch(state.url + '/readyz', { signal: AbortSignal.timeout(750) })
      if (response.status === 200) {
        const result = await response.json()
        assert.equal(JSON.stringify(result).includes(adminToken), false)
        return
      }
    } catch { /* The process can still be binding its listener. */ }
    await delay(40)
  }
  throw new Error(`Server did not become ready: ${safeOutput(state)}`)
}

function safeOutput(state) {
  let output = state.output
  for (const value of [adminToken, ...(state.redactions ?? [])]) output = output.split(value).join('[redacted]')
  return output
}

async function waitForExit(state, timeout = 10000) {
  const deadline = Date.now() + timeout
  while (!state.exit && Date.now() < deadline) await delay(25)
  assert.ok(state.exit, `Child failed to stop: ${safeOutput(state)}`)
  await state.exited
  children.delete(state)
  return state.exit
}

async function stop(state, signal = 'SIGKILL') {
  if (!state.exit) state.child.kill(signal)
  return waitForExit(state)
}

async function request(state, route, token, body, expected = 200) {
  const response = await fetch(state.url + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  })
  const data = await response.json()
  assert.equal(response.status, expected, `${route}: ${JSON.stringify(data)}`)
  return data
}

function identity(name) {
  const keys = generateKeyPairSync('ed25519')
  const der = keys.publicKey.export({ format: 'der', type: 'spki' })
  return { name, privateKey: keys.privateKey, publicKey: der.toString('base64url'), userId: 'usr_' + createHash('sha256').update(der).digest('hex') }
}

const device = (id, name) => ({ ...id, deviceId: randomUUID(), deviceName: name })
async function login(state, id) {
  const challenge = await request(state, '/v1/challenge', null, {
    publicKey: id.publicKey,
    displayName: id.name,
    features: ['message-actions-v1', 'device-delivery-v1'],
    deviceId: id.deviceId,
    deviceName: id.deviceName,
  })
  const result = await request(state, '/v1/session', null, {
    challengeId: challenge.challengeId,
    signature: sign(null, Buffer.from(challenge.challenge), id.privateKey).toString('base64url'),
  })
  return { ...id, token: result.token }
}

async function acknowledge(state, user, ids) {
  return request(state, '/v1/ack', user.token, { ids })
}

async function verifyStatusCli(server, privateValues) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MTC_SERVER_')))
  const child = spawn(process.execPath, [statusEntry, server.url], {
    cwd: path.dirname(statusEntry), windowsHide: true,
    // An explicit temporary credential overrides the source CLI's real local-dev
    // token-file default. Credentials are never passed through command arguments.
    env: { ...env, MTC_SERVER_ADMIN_TOKEN: adminToken },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const state = { child, output: '', stdout: '', stderr: '', exit: null, overflow: false, redactions: privateValues }
  children.add(state)
  state.exited = new Promise(resolve => {
    child.once('error', error => { state.exit = { error: error.message } })
    child.once('close', (code, signal) => { state.exit ??= { code, signal }; resolve(state.exit) })
  })
  for (const [stream, name] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) stream.on('data', chunk => {
    state[name] += chunk.toString()
    if (state[name].length > 16384) { state.overflow = true; state[name] = state[name].slice(-16384) }
    state.output = (state.output + chunk.toString()).slice(-16384)
  })
  const exit = await waitForExit(state, 15000)
  assert.equal(exit.code, 0, 'Administrator status CLI must successfully query the running test server')
  assert.equal(state.overflow, false, 'Status CLI must emit only bounded aggregate diagnostics')
  for (const value of [adminToken, directory, temporary, ...privateValues]) {
    assert.equal((state.stdout + state.stderr).includes(value), false, 'Status CLI exposed a credential, identity or message detail')
  }
  let result
  try { result = JSON.parse(state.stdout) } catch { throw new Error('Status CLI returned invalid JSON') }
  const keys = (value, expected) => assert.deepEqual(Object.keys(value).sort(), expected.sort())
  keys(result, ['version', 'uptimeMs', 'closing', 'runtime', 'users', 'groups', 'devices', 'queue'])
  keys(result.runtime, ['activeSessions', 'pendingPolls'])
  keys(result.devices, ['active', 'revoked'])
  keys(result.queue, ['rows', 'payloadBytes', 'deviceObligations', 'oldestAgeMs'])
  assert.equal(result.version, 1)
  assert.equal(result.closing, false)
  assert.equal(result.users, 3)
  assert.equal(result.groups, 1)
  assert.equal(result.devices.active, 4)
  assert.equal(result.devices.revoked, 0)
  assert.equal(result.runtime.activeSessions, 4)
  assert.equal(result.runtime.pendingPolls, 0)
  assert.ok(Number.isSafeInteger(result.uptimeMs) && result.uptimeMs >= 0)
  assert.ok(Number.isSafeInteger(result.queue.oldestAgeMs) && result.queue.oldestAgeMs >= 0)
  inspectDatabase(db => {
    assert.equal(result.queue.rows, db.prepare('SELECT COUNT(*) AS n FROM queue').get().n)
    assert.equal(result.queue.payloadBytes, db.prepare('SELECT SUM(length(CAST(payload AS BLOB))) AS n FROM queue').get().n)
    assert.equal(result.queue.deviceObligations, db.prepare('SELECT COUNT(*) AS n FROM queue_devices').get().n)
  })
  console.log('PASS: real administrator status CLI returns accurate aggregates without identities, credentials or message content')
}

function inspectDatabase(inspect) {
  const db = new DatabaseSync(path.join(directory, 'relay.sqlite'), { readOnly: true })
  try { return inspect(db) } finally { db.close() }
}

function obligations(messageId) {
  return inspectDatabase(db => db.prepare('SELECT user_id,device_id FROM queue_devices WHERE event_id=? ORDER BY user_id,device_id').all(messageId).map(row => `${row.user_id}/${row.device_id}`))
}

function assertObligations(messageId, users) {
  assert.deepEqual(obligations(messageId), users.map(user => `${user.userId}/${user.deviceId}`).sort())
}

function assertPurged(ids, privateMarkers) {
  inspectDatabase(db => {
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok')
    for (const id of ids) {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM queue WHERE id=?').get(id).n, 0)
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM queue_devices WHERE event_id=?').get(id).n, 0)
    }
    // This is logical deletion, not a claim about backups or forensic disk erasure.
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
    const values = tables.map(({ name }) => db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all())
    const serialized = JSON.stringify(values)
    for (const marker of privateMarkers) assert.equal(serialized.includes(marker), false, 'Delivered body leaked into a retained server table')
  })
}

try {
  let server = await start()
  await waitForReady(server)
  const ping = await request(server, '/v1/ping')
  assert.match(ping.serverId, /^srv_/)
  for (const endpoint of ['/healthz', '/readyz']) {
    const probe = await request(server, endpoint)
    assert.equal(JSON.stringify(probe).includes(adminToken), false)
    assert.equal(JSON.stringify(probe).includes(directory), false)
  }
  const duplicate = await start()
  const duplicateExit = await waitForExit(duplicate)
  assert.equal(duplicateExit.code, 1, 'A second process must not open the same data directory')
  assert.match(duplicate.output, /DATA_DIR_IN_USE/, 'Duplicate startup must fail specifically because the live process owns the directory')
  await request(server, '/readyz')
  console.log('PASS: health/readiness and exclusive data-directory ownership')

  const aIdentity = device(identity('Ops Alice'), 'Alice PC')
  const bIdentity = identity('Ops Bob')
  const b1Identity = device(bIdentity, 'Bob PC 1')
  const b2Identity = device(bIdentity, 'Bob PC 2')
  const cIdentity = device(identity('Ops Carol'), 'Carol PC')
  let a = await login(server, aIdentity)
  let b1 = await login(server, b1Identity)
  let b2 = await login(server, b2Identity)
  let c = await login(server, cIdentity)
  for (const token of [undefined, 'invalid-test-operator-token-0001', a.token]) {
    const denied = await request(server, '/v1/admin/status', token, undefined, 403)
    assert.deepEqual(Object.keys(denied), ['error'], 'Unauthenticated users and ordinary sessions must not receive administrator metrics')
  }
  for (const peer of [b1, c]) {
    await request(server, '/v1/friends/request', a.token, { userId: peer.userId })
    await request(server, '/v1/friends/accept', peer.token, { userId: a.userId })
  }
  const { groupId } = await request(server, '/v1/groups', a.token, { name: 'Ops recovery group', memberIds: [b1.userId, c.userId] })
  for (const user of [a, b1, b2, c]) {
    const events = await request(server, '/v1/events', user.token)
    await acknowledge(server, user, events.events.map(event => event.id))
  }
  const marker = 'private-ops-body-' + randomUUID()
  const bytes = Buffer.from('private-ops-attachment-' + randomUUID())
  const attachment = { id: createHash('sha256').update(bytes).digest('hex'), name: 'recovery.txt', mime: 'text/plain', size: bytes.length, data: bytes.toString('base64') }
  const groupBody = { clientMessageId: randomUUID(), targetKind: 'group', targetId: groupId, text: marker }
  const directBody = { clientMessageId: randomUUID(), targetKind: 'direct', targetId: b1.userId, text: '', attachment }
  const group = await request(server, '/v1/messages', a.token, groupBody)
  const direct = await request(server, '/v1/messages', a.token, directBody)
  await verifyStatusCli(server, [
    ping.serverId, groupId, group.messageId, direct.messageId,
    groupBody.clientMessageId, directBody.clientMessageId, marker, attachment.data,
    attachment.id, attachment.name, bytes.toString(), 'Ops recovery group',
    ...[a, b1, b2, c].flatMap(user => [user.userId, user.deviceId, user.publicKey, user.name, user.deviceName, user.token]),
  ])
  const firstDelivery = await request(server, '/v1/events', b1.token)
  assert.equal(firstDelivery.events.find(event => event.id === group.messageId)?.message.text, marker)
  await acknowledge(server, b1, [group.messageId])
  assertObligations(group.messageId, [b2, c])
  assertObligations(direct.messageId, [b1, b2])
  const oldToken = a.token
  await stop(server)

  server = await start()
  await waitForReady(server)
  assert.equal((await request(server, '/v1/ping')).serverId, ping.serverId)
  await request(server, '/v1/directory', oldToken, undefined, 401)
  a = await login(server, aIdentity)
  b1 = await login(server, b1Identity)
  b2 = await login(server, b2Identity)
  c = await login(server, cIdentity)
  assert.equal((await request(server, '/v1/messages', a.token, groupBody)).messageId, group.messageId)
  assert.equal((await request(server, '/v1/messages', a.token, directBody)).messageId, direct.messageId)
  assertObligations(group.messageId, [b2, c])
  assertObligations(direct.messageId, [b1, b2])
  for (const user of [b1, b2, c]) {
    const messages = (await request(server, '/v1/events', user.token)).events.filter(event => event.kind === 'message')
    const expected = user === b1 ? [direct.messageId] : user === b2 ? [direct.messageId, group.messageId] : [group.messageId]
    assert.deepEqual(messages.map(event => event.id).sort(), expected.sort())
    for (const event of messages) {
      if (event.id === group.messageId) assert.equal(event.message.text, marker)
      else assert.deepEqual(event.message.attachment, attachment)
    }
  }
  console.log('PASS: hard crash, stable identity, stale-session rejection, offline delivery and send deduplication')

  await acknowledge(server, b1, [direct.messageId])
  assertObligations(direct.messageId, [b2])
  await acknowledge(server, b2, [group.messageId, direct.messageId])
  assertObligations(group.messageId, [c])
  assertObligations(direct.messageId, [])
  await acknowledge(server, c, [group.messageId])
  await acknowledge(server, c, [group.messageId])
  const receipts = (await request(server, '/v1/directory', a.token)).receipts
  assert.equal(receipts.find(receipt => receipt.messageId === group.messageId)?.deliveredCount, 2)
  assert.equal(receipts.find(receipt => receipt.messageId === direct.messageId)?.deliveredCount, 1)
  assertPurged([group.messageId, direct.messageId], [marker, attachment.data])
  await stop(server)
  assertPurged([group.messageId, direct.messageId], [marker, attachment.data])

  server = await start()
  await waitForReady(server)
  a = await login(server, aIdentity)
  b1 = await login(server, b1Identity)
  b2 = await login(server, b2Identity)
  c = await login(server, cIdentity)
  assert.equal((await request(server, '/v1/messages', a.token, groupBody)).messageId, group.messageId)
  assert.equal((await request(server, '/v1/messages', a.token, directBody)).messageId, direct.messageId)
  assertPurged([group.messageId, direct.messageId], [marker, attachment.data])
  const afterRestart = await request(server, '/v1/messages', a.token, { ...groupBody, clientMessageId: randomUUID(), text: 'New traffic after recovery' })
  for (const user of [b1, b2, c]) {
    const events = await request(server, '/v1/events', user.token)
    assert.deepEqual(events.events.filter(event => event.kind === 'message').map(event => event.id), [afterRestart.messageId])
    await acknowledge(server, user, events.events.map(event => event.id))
  }
  assertPurged([group.messageId, direct.messageId, afterRestart.messageId], [marker, attachment.data, 'New traffic after recovery'])
  console.log('PASS: last-device ACK purges bodies, restart does not resurrect them, new group traffic still works')

  if (process.platform === 'win32') {
    await stop(server)
    console.log('SKIP: graceful POSIX SIGTERM (Windows process termination is not a POSIX signal test)')
  } else {
    const pending = fetch(server.url + '/v1/events', { headers: { authorization: `Bearer ${b1.token}` }, signal: AbortSignal.timeout(10000) })
      .then(response => ({ status: response.status })).catch(() => ({ disconnected: true }))
    await delay(100)
    const result = await stop(server, 'SIGTERM')
    assert.equal(result.code, 0, 'Graceful SIGTERM must exit successfully')
    const response = await pending
    assert.ok(response.disconnected || response.status === 503, 'Shutdown must not fabricate a successful delivery')
    console.log('PASS: graceful SIGTERM while a receiver is long-polling')
  }
  assertPurged([group.messageId, direct.messageId], [marker, attachment.data])
  console.log(`Central operations verification passed (${args.length ? 'standalone release' : 'workspace source'}).`)
} finally {
  for (const state of children) {
    try { await stop(state) } catch (error) { cleanupErrors.push(error) }
  }
  // Only this invocation's mkdtemp directory is ever removed, never configured server data.
  if (!cleanupErrors.length) await rm(temporary, { recursive: true, force: true })
  else console.error('Temporary test directory retained because a test child could not be stopped:', temporary)
}
