import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectServerStats, readAdminToken, readServerConfig, ServerConfigurationError, startCentralProcess } from '../src/server-operations.mjs'

const TOKEN = 'test-only-operation-token-123456789'
const roots = []
const env = additions => ({ MTC_SERVER_ADMIN_TOKEN: TOKEN, ...additions })
async function directory() {
  const dir = await mkdtemp(path.join(tmpdir(), 'mtc-operations-'))
  roots.push(dir)
  return dir
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
function processFixture() {
  const processLike = new EventEmitter(), server = new EventEmitter(), logs = []
  const app = { server, listen: vi.fn(async () => ({ address: '127.0.0.1', port: 8787 })), close: vi.fn(async () => {}) }
  const factory = vi.fn(() => app)
  return { app, factory, processLike, logs, options: { factory, env: env(), processLike, log: line => logs.push(JSON.parse(line)) } }
}

describe('strict central server configuration', () => {
  it('keeps private loopback defaults and resolves the data directory without creating files', async () => {
    const cwd = await directory()
    const config = await readServerConfig(env(), { cwd })
    expect(config).toEqual({ directory: path.join(cwd, '.data', 'central'), mode: 'private', adminToken: TOKEN, name: 'MoreThanChat 中心服务器', whitelist: [], blacklist: [], port: 8787, host: '127.0.0.1', shutdownTimeoutMs: 10000 })
    await expect(readFile(path.join(config.directory, 'relay.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('accepts explicit deployment settings and deduplicates valid access identities', async () => {
    const uid = 'usr_' + 'a'.repeat(64), other = 'usr_' + 'b'.repeat(64)
    const config = await readServerConfig(env({ MTC_SERVER_PORT: '65535', MTC_SERVER_HOST: '::', MTC_SERVER_MODE: 'public', MTC_SERVER_NAME: 'My 私服', MTC_SERVER_WHITELIST: `${uid}, ${uid}`, MTC_SERVER_BLACKLIST: other, MTC_SERVER_SHUTDOWN_TIMEOUT_MS: '500' }))
    expect(config).toMatchObject({ port: 65535, host: '::', mode: 'public', name: 'My 私服', whitelist: [uid], blacklist: [other], shutdownTimeoutMs: 500 })
  })

  it.each(['0', '-1', '65536', '1.5', '1e3', ' 8787', '8787 ', '', '0080', 'Infinity', 'NaN'])('rejects malformed CLI port %j', async port => {
    await expect(readServerConfig(env({ MTC_SERVER_PORT: port }))).rejects.toMatchObject({ field: 'MTC_SERVER_PORT' })
  })

  it.each([
    ['MTC_SERVER_HOST', 'https://host'], ['MTC_SERVER_HOST', '127.0.0.1:8787'], ['MTC_SERVER_HOST', '999.999.999.999'],
    ['MTC_SERVER_HOST', ''], ['MTC_SERVER_HOST', '[::1]'], ['MTC_SERVER_HOST', 'bad\nhost'],
    ['MTC_SERVER_MODE', 'PUBLIC'], ['MTC_SERVER_MODE', ''], ['MTC_SERVER_NAME', ''], ['MTC_SERVER_NAME', 'name\nline'],
    ['MTC_SERVER_NAME', 'a'.repeat(201)], ['MTC_SERVER_DATA_DIR', ''], ['MTC_SERVER_DATA_DIR', 'bad\0path'],
    ['MTC_SERVER_SHUTDOWN_TIMEOUT_MS', '0'], ['MTC_SERVER_SHUTDOWN_TIMEOUT_MS', '60001'],
    ['MTC_SERVER_WHITELIST', 'not-an-identity'], ['MTC_SERVER_BLACKLIST', 'usr_' + 'a'.repeat(64) + ','],
  ])('rejects invalid %s without echoing its value', async (key, input) => {
    await expect(readServerConfig(env({ [key]: input }))).rejects.toMatchObject({ field: key, message: `Invalid central server configuration: ${key}` })
  })

  it('rejects conflicting lists before reading credentials', async () => {
    const uid = 'usr_' + 'a'.repeat(64)
    await expect(readServerConfig({ MTC_SERVER_WHITELIST: uid, MTC_SERVER_BLACKLIST: uid })).rejects.toMatchObject({ field: 'MTC_SERVER_ACCESS_LISTS' })
  })

  it('rejects missing, whitespace, control, non-ASCII, and oversized secrets without returning them', async () => {
    await expect(readAdminToken({})).rejects.toMatchObject({ code: 'MISSING_ADMIN_TOKEN' })
    for (const secret of ['', ' '.repeat(30), 'a'.repeat(23), TOKEN + '\n', TOKEN + ' ', TOKEN + '中', TOKEN + '\0', 'x'.repeat(8193)]) {
      await expect(readAdminToken(env({ MTC_SERVER_ADMIN_TOKEN: secret }))).rejects.toMatchObject({ message: 'Invalid central server configuration: MTC_SERVER_ADMIN_TOKEN' })
    }
    await expect(readAdminToken(env({ MTC_SERVER_ADMIN_TOKEN_FILE: 'secret-file' }))).rejects.toMatchObject({ field: 'MTC_SERVER_ADMIN_TOKEN_SOURCE' })
  })

  it('reads a bounded ordinary token file and permits one trailing LF or CRLF', async () => {
    const dir = await directory(), filename = path.join(dir, 'token')
    for (const ending of ['', '\n', '\r\n']) {
      await writeFile(filename, TOKEN + ending, { mode: 0o600 })
      expect(await readAdminToken({ MTC_SERVER_ADMIN_TOKEN_FILE: 'token' }, { cwd: dir })).toBe(TOKEN)
    }
    await writeFile(filename, TOKEN + '\n\n')
    await expect(readAdminToken({ MTC_SERVER_ADMIN_TOKEN_FILE: filename })).rejects.toMatchObject({ field: 'MTC_SERVER_ADMIN_TOKEN_FILE' })
  })

  it('rejects missing files, directories, oversized files, and malformed UTF-8 without leaking paths', async () => {
    const dir = await directory(), filename = path.join(dir, 'sensitive-path-token')
    await expect(readAdminToken({ MTC_SERVER_ADMIN_TOKEN_FILE: filename })).rejects.toMatchObject({ message: 'Invalid central server configuration: MTC_SERVER_ADMIN_TOKEN_FILE' })
    await expect(readAdminToken({ MTC_SERVER_ADMIN_TOKEN_FILE: dir })).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    await writeFile(filename, 'x'.repeat(8193))
    await expect(readAdminToken({ MTC_SERVER_ADMIN_TOKEN_FILE: filename })).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    await writeFile(filename, Buffer.concat([Buffer.from(TOKEN), Buffer.from([0xff])]))
    await expect(readAdminToken({ MTC_SERVER_ADMIN_TOKEN_FILE: filename })).rejects.toMatchObject({ code: 'ADMIN_TOKEN_FILE_UNREADABLE' })
  })

  it.runIf(process.platform !== 'win32')('refuses a symlink token source', async () => {
    const dir = await directory(), filename = path.join(dir, 'token'), link = path.join(dir, 'link')
    await writeFile(filename, TOKEN)
    await symlink(filename, link)
    await expect(readAdminToken({ MTC_SERVER_ADMIN_TOKEN_FILE: link })).rejects.toMatchObject({ field: 'MTC_SERVER_ADMIN_TOKEN_FILE' })
  })
})

describe('central process lifecycle', () => {
  it('starts with parsed configuration and removes only its own signal listeners after idempotent stop', async () => {
    const f = processFixture(), existing = vi.fn()
    f.processLike.on('SIGTERM', existing)
    const running = await startCentralProcess(f.options)
    expect(f.app.listen).toHaveBeenCalledWith(8787, '127.0.0.1')
    expect(f.factory.mock.calls[0][0]).toMatchObject({ mode: 'private', adminToken: TOKEN })
    expect(f.factory.mock.calls[0][0]).not.toHaveProperty('port')
    const first = running.stop(), second = running.stop()
    expect(second).toBe(first)
    f.processLike.emit('SIGINT')
    f.processLike.emit('SIGTERM')
    await first
    expect(f.app.close).toHaveBeenCalledTimes(1)
    expect(f.processLike.exitCode).toBe(0)
    expect(f.processLike.listeners('SIGTERM')).toEqual([existing])
    expect(f.processLike.listenerCount('SIGINT')).toBe(0)
    expect(f.logs.map(line => line.event)).toEqual(['central.started', 'central.stopping', 'central.stopped'])
    expect(JSON.stringify(f.logs)).not.toContain(TOKEN)
  })

  it('redacts configuration failures before constructing the server', async () => {
    const f = processFixture()
    f.options.env = env({ MTC_SERVER_PORT: TOKEN })
    expect(await startCentralProcess(f.options)).toBeNull()
    expect(f.factory).not.toHaveBeenCalled()
    expect(f.processLike.exitCode).toBe(1)
    expect(f.logs).toEqual([{ event: 'central.start_failed', code: 'INVALID_CONFIGURATION', field: 'MTC_SERVER_PORT' }])
  })

  it('cleans up listening failures and does not log arbitrary error messages or codes', async () => {
    const f = processFixture()
    f.app.listen.mockRejectedValue(Object.assign(new Error(TOKEN), { code: TOKEN }))
    expect(await startCentralProcess(f.options)).toBeNull()
    expect(f.app.close).toHaveBeenCalledTimes(1)
    expect(f.processLike.exitCode).toBe(1)
    expect(JSON.stringify(f.logs)).not.toContain(TOKEN)
    expect(f.logs[0]).toEqual({ event: 'central.start_failed', code: 'OPERATION_FAILED' })
    expect(f.processLike.eventNames()).toEqual([])
  })

  it('keeps useful safe OS codes and makes factory/close failures nonzero', async () => {
    const failed = processFixture()
    failed.factory.mockImplementation(() => { throw Object.assign(new Error(TOKEN), { code: 'EACCES' }) })
    expect(await startCentralProcess(failed.options)).toBeNull()
    expect(failed.logs).toEqual([{ event: 'central.start_failed', code: 'EACCES' }])
    const f = processFixture(), running = await startCentralProcess(f.options)
    f.app.close.mockRejectedValue(Object.assign(new Error(TOKEN), { code: 'ENOSPC' }))
    await running.stop()
    expect(f.processLike.exitCode).toBe(1)
    expect(f.logs.at(-1)).toEqual({ event: 'central.stop_failed', code: 'ENOSPC' })
    expect(f.processLike.eventNames()).toEqual([])
  })

  it('does not trust arbitrary configuration error fields from a factory', async () => {
    const f = processFixture()
    f.factory.mockImplementation(() => { throw new ServerConfigurationError(TOKEN, TOKEN) })
    expect(await startCentralProcess(f.options)).toBeNull()
    expect(f.logs).toEqual([{ event: 'central.start_failed', code: 'OPERATION_FAILED' }])
  })

  it.each([['ERR_SQLITE_ERROR', 'DB_FAILURE'], ['DATA_DIR_IN_USE', 'DATA_DIR_IN_USE'], ['DATA_DIR_LOCK_FAILED', 'DATA_DIR_LOCK_FAILED'], ['SERVER_MODE_MISMATCH', 'SERVER_MODE_MISMATCH']])('logs safe diagnostics for %s', async (code, expected) => {
    const f = processFixture()
    f.factory.mockImplementation(() => { throw Object.assign(new Error(TOKEN), { code }) })
    expect(await startCentralProcess(f.options)).toBeNull()
    expect(f.logs).toEqual([{ event: 'central.start_failed', code: expected }])
    expect(JSON.stringify(f.logs)).not.toContain(TOKEN)
    expect(f.processLike.exitCode).toBe(1)
  })

  it('waits for the same shutdown when a signal arrives during listen', async () => {
    const f = processFixture()
    let finishListen, finishClose
    f.app.listen.mockImplementation(() => new Promise(resolve => { finishListen = resolve }))
    f.app.close.mockImplementation(() => new Promise(resolve => { finishClose = resolve }))
    const starting = startCentralProcess(f.options)
    await vi.waitFor(() => expect(finishListen).toBeTypeOf('function'))
    f.processLike.emit('SIGTERM')
    f.processLike.emit('SIGINT')
    await vi.waitFor(() => expect(finishClose).toBeTypeOf('function'))
    finishListen({ port: 8787 })
    finishClose()
    const running = await starting
    await running.stop()
    expect(f.app.close).toHaveBeenCalledTimes(1)
    expect(f.logs.map(line => line.event)).toEqual(['central.stopping', 'central.stopped'])
    expect(f.processLike.exitCode).toBe(0)
  })

  it('turns runtime server errors into one redacted nonzero shutdown', async () => {
    const f = processFixture(), running = await startCentralProcess(f.options)
    f.app.server.emit('error', Object.assign(new Error(TOKEN), { code: 'ENOSPC' }))
    await running.stop()
    expect(f.processLike.exitCode).toBe(1)
    expect(f.app.close).toHaveBeenCalledTimes(1)
    expect(f.logs.find(line => line.event === 'central.failed')).toEqual({ event: 'central.failed', code: 'ENOSPC' })
    expect(f.app.server.listenerCount('error')).toBe(0)
  })

  it('does not report a user-requested startup cancellation as failure', async () => {
    const f = processFixture()
    let cancelListen
    f.app.listen.mockImplementation(() => new Promise((resolve, reject) => { cancelListen = () => reject(Object.assign(new Error(TOKEN), { code: 'SERVER_CLOSING' })) }))
    f.app.close.mockImplementation(async () => cancelListen())
    const starting = startCentralProcess(f.options)
    await vi.waitFor(() => expect(cancelListen).toBeTypeOf('function'))
    f.processLike.emit('SIGTERM')
    const running = await starting
    expect(running.address).toBeNull()
    expect(f.processLike.exitCode).toBe(0)
    expect(f.logs.map(line => line.event)).toEqual(['central.stopping', 'central.stopped'])
  })

  it('logs request failures without payload fields and still shuts down if the log sink throws', async () => {
    const f = processFixture(), running = await startCentralProcess(f.options)
    f.factory.mock.calls[0][0].onError({ route: TOKEN, message: TOKEN, body: TOKEN })
    expect(f.logs.at(-1)).toEqual({ event: 'central.request_failed', code: 'REQUEST_FAILED' })
    await running.stop()
    const brokenLog = processFixture()
    const other = await startCentralProcess({ ...brokenLog.options, log: () => { throw new Error('closed output') } })
    await other.stop()
    expect(brokenLog.app.close).toHaveBeenCalledTimes(1)
    expect(brokenLog.processLike.exitCode).toBe(0)
  })
})

describe('privacy-preserving administrator statistics', () => {
  it('reports byte-accurate pending storage and obligations without leaking identifiers or content', () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec('CREATE TABLE users(id TEXT); CREATE TABLE groups(id TEXT); CREATE TABLE devices(id TEXT,revoked INTEGER); CREATE TABLE queue(id TEXT,recipient TEXT,payload TEXT,created_at INTEGER); CREATE TABLE queue_devices(event_id TEXT,user_id TEXT,device_id TEXT)')
      db.prepare('INSERT INTO users VALUES (?)').run('private-user-id')
      db.prepare('INSERT INTO groups VALUES (?)').run('private-group-id')
      db.exec("INSERT INTO devices VALUES ('private-device',0),('revoked-device',1)")
      const payload = JSON.stringify({ text: '私密内容 ' + TOKEN })
      db.prepare('INSERT INTO queue VALUES (?,?,?,?)').run('private-event-id', 'private-user-id', payload, 1000)
      db.prepare('INSERT INTO queue_devices VALUES (?,?,?)').run('private-event-id', 'private-user-id', 'private-device')
      const result = collectServerStats(db, { startedAt: 500, now: 5000, activeSessions: 2, pendingPolls: 1 })
      expect(result).toEqual({ version: 1, uptimeMs: 4500, closing: false, runtime: { activeSessions: 2, pendingPolls: 1 }, users: 1, groups: 1, devices: { active: 1, revoked: 1 }, queue: { rows: 1, payloadBytes: Buffer.byteLength(payload), deviceObligations: 1, oldestAgeMs: 4000 } })
      expect(JSON.stringify(result)).not.toMatch(/private|私密|token|revoked-device/)
      expect(db.prepare('SELECT payload FROM queue').get().payload).toBe(payload)
      db.exec('DELETE FROM queue; DELETE FROM queue_devices')
      const empty = collectServerStats(db, { startedAt: 6000, now: 5000, closing: true, activeSessions: -2, pendingPolls: Infinity })
      expect(empty).toMatchObject({ uptimeMs: 0, closing: true, runtime: { activeSessions: 0, pendingPolls: 0 }, queue: { rows: 0, payloadBytes: 0, deviceObligations: 0, oldestAgeMs: null } })
    } finally { db.close() }
  })
})
