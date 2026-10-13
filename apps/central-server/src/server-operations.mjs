import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { isIP } from 'node:net'
import path from 'node:path'

const TOKEN_LIMIT = 8192
const UID = /^usr_[a-f0-9]{64}$/
const visibleToken = /^[\x21-\x7e]{24,8192}$/
const errorCodes = new Set(['EACCES', 'EADDRINUSE', 'EADDRNOTAVAIL', 'ENOENT', 'ENOSPC', 'EROFS', 'EMFILE', 'ENFILE', 'DATA_DIR_IN_USE', 'DATA_DIR_LOCK_FAILED', 'SERVER_CLOSING', 'SERVER_MODE_MISMATCH'])
const configFields = new Set(['MTC_SERVER_ADMIN_TOKEN', 'MTC_SERVER_ADMIN_TOKEN_FILE', 'MTC_SERVER_ADMIN_TOKEN_SOURCE', 'MTC_SERVER_PORT', 'MTC_SERVER_HOST', 'MTC_SERVER_MODE', 'MTC_SERVER_NAME', 'MTC_SERVER_DATA_DIR', 'MTC_SERVER_WHITELIST', 'MTC_SERVER_BLACKLIST', 'MTC_SERVER_ACCESS_LISTS', 'MTC_SERVER_SHUTDOWN_TIMEOUT_MS'])
const configCodes = new Set(['INVALID_CONFIGURATION', 'MISSING_ADMIN_TOKEN', 'ADMIN_TOKEN_FILE_UNREADABLE'])

export class ServerConfigurationError extends Error {
  constructor(field, code = 'INVALID_CONFIGURATION') {
    super(`Invalid central server configuration: ${field}`)
    this.name = 'ServerConfigurationError'
    this.code = code
    this.field = field
  }
}
const invalid = field => { throw new ServerConfigurationError(field) }
const value = (env, key, fallback) => {
  const result = env[key] ?? fallback
  if (typeof result !== 'string') invalid(key)
  return result
}
const integer = (env, key, fallback, min, max) => {
  const raw = value(env, key, String(fallback))
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) invalid(key)
  const result = Number(raw)
  if (!Number.isSafeInteger(result) || result < min || result > max) invalid(key)
  return result
}
const absolutePath = (raw, key, cwd) => {
  if (!raw || raw !== raw.trim() || raw.length > 32768 || /[\x00-\x1f]/.test(raw)) invalid(key)
  return path.resolve(cwd, raw)
}

// Never include a configured value, OS error message, or underlying cause in errors.
export async function readAdminToken(env = process.env, { cwd = process.cwd() } = {}) {
  const tokenKey = 'MTC_SERVER_ADMIN_TOKEN', fileKey = 'MTC_SERVER_ADMIN_TOKEN_FILE'
  if (env[tokenKey] !== undefined && env[fileKey] !== undefined) invalid('MTC_SERVER_ADMIN_TOKEN_SOURCE')
  if (env[tokenKey] !== undefined) {
    const token = value(env, tokenKey)
    if (!visibleToken.test(token)) invalid(tokenKey)
    return token
  }
  if (env[fileKey] === undefined) throw new ServerConfigurationError('MTC_SERVER_ADMIN_TOKEN_SOURCE', 'MISSING_ADMIN_TOKEN')
  const filename = absolutePath(value(env, fileKey), fileKey, cwd)
  let handle
  try {
    const before = await lstat(filename)
    if (!before.isFile() || before.isSymbolicLink() || before.size < 24 || before.size > TOKEN_LIMIT) invalid(fileKey)
    handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) invalid(fileKey)
    // Bounded reads also reject files grown after stat; never follow a substituted path.
    const bytes = Buffer.alloc(TOKEN_LIMIT + 1)
    let length = 0
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    const after = await handle.stat()
    if (length !== opened.size || length > TOKEN_LIMIT || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) invalid(fileKey)
    const token = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)).replace(/\r?\n$/, '')
    if (!visibleToken.test(token)) invalid(fileKey)
    return token
  } catch (error) {
    if (error instanceof ServerConfigurationError) throw error
    throw new ServerConfigurationError(fileKey, 'ADMIN_TOKEN_FILE_UNREADABLE')
  } finally {
    await handle?.close().catch(() => {})
  }
}

export async function readServerConfig(env = process.env, { cwd = process.cwd() } = {}) {
  const port = integer(env, 'MTC_SERVER_PORT', 8787, 1, 65535)
  const host = value(env, 'MTC_SERVER_HOST', '127.0.0.1')
  const hostname = /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/
  if (!isIP(host) && (!hostname.test(host) || /^[0-9.]+$/.test(host))) invalid('MTC_SERVER_HOST')
  const mode = value(env, 'MTC_SERVER_MODE', 'private')
  if (!['private', 'public'].includes(mode)) invalid('MTC_SERVER_MODE')
  const name = value(env, 'MTC_SERVER_NAME', 'MoreThanChat 中心服务器')
  if (!name.trim() || name !== name.trim() || name.length > 200 || /[\x00-\x1f\x7f]/.test(name)) invalid('MTC_SERVER_NAME')
  const directory = absolutePath(value(env, 'MTC_SERVER_DATA_DIR', '.data/central'), 'MTC_SERVER_DATA_DIR', cwd)
  const identities = key => {
    const raw = value(env, key, '')
    if (!raw) return []
    const ids = raw.split(',').map(id => id.trim())
    if (ids.length > 4096 || ids.some(id => !UID.test(id))) invalid(key)
    return [...new Set(ids)]
  }
  const whitelist = identities('MTC_SERVER_WHITELIST'), blacklist = identities('MTC_SERVER_BLACKLIST')
  if (whitelist.some(id => blacklist.includes(id))) invalid('MTC_SERVER_ACCESS_LISTS')
  const shutdownTimeoutMs = integer(env, 'MTC_SERVER_SHUTDOWN_TIMEOUT_MS', 10000, 1, 60000)
  const adminToken = await readAdminToken(env, { cwd })
  return { directory, mode, adminToken, name, whitelist, blacklist, port, host, shutdownTimeoutMs }
}

function safeError(error) {
  if (error instanceof ServerConfigurationError && configCodes.has(error.code) && configFields.has(error.field)) return { code: error.code, field: error.field }
  if (error?.code === 'ERR_SQLITE_ERROR') return { code: 'DB_FAILURE' }
  return { code: errorCodes.has(error?.code) ? error.code : 'OPERATION_FAILED' }
}

// Dependency injection keeps this module usable by both the executable and tests.
// No forced process.exit(): allow HTTP shutdown, SQLite checkpoint, and log flushing.
export async function startCentralProcess({ factory, env = process.env, processLike = process, log = line => console.log(line), cwd = process.cwd() }) {
  const emit = data => {
    try { log(JSON.stringify(data)) } catch { /* A closed log sink must not skip shutdown. */ }
  }
  let app, stopping, runtimeFailure = false
  const onInt = () => { void stop('SIGINT') }, onTerm = () => { void stop('SIGTERM') }
  const onError = error => {
    runtimeFailure = true
    processLike.exitCode = 1
    emit({ event: 'central.failed', ...safeError(error) })
    void stop('server-error')
  }
  const removeListeners = () => {
    processLike.off('SIGINT', onInt)
    processLike.off('SIGTERM', onTerm)
    app?.server?.off('error', onError)
  }
  function stop(reason = 'manual') {
    if (stopping) return stopping
    const signal = ['SIGINT', 'SIGTERM', 'server-error'].includes(reason) ? reason : 'manual'
    stopping = Promise.resolve().then(async () => {
      emit({ event: 'central.stopping', signal })
      try {
        await app?.close()
        if (!runtimeFailure && processLike.exitCode !== 1) processLike.exitCode = 0
        emit({ event: 'central.stopped' })
      } catch (error) {
        processLike.exitCode = 1
        emit({ event: 'central.stop_failed', ...safeError(error) })
      } finally { removeListeners() }
    })
    return stopping
  }
  try {
    const { port, host, ...config } = await readServerConfig(env, { cwd })
    app = factory({ ...config, onError: () => emit({ event: 'central.request_failed', code: 'REQUEST_FAILED' }) })
    processLike.on('SIGINT', onInt)
    processLike.on('SIGTERM', onTerm)
    const address = await app.listen(port, host)
    if (stopping) { await stopping; return { app, address, stop } }
    app.server?.on('error', onError)
    emit({ event: 'central.started', mode: config.mode, host, port: address?.port ?? port })
    return { app, address, stop }
  } catch (error) {
    if (stopping && error?.code === 'SERVER_CLOSING') {
      await stopping
      return { app, address: null, stop }
    }
    runtimeFailure = true
    processLike.exitCode = 1
    emit({ event: 'central.start_failed', ...safeError(error) })
    if (app) await stop('manual')
    else removeListeners()
    return null
  }
}

const nonnegative = value => Number.isSafeInteger(value) && value >= 0 ? value : 0

// Aggregate-only administrator diagnostics. Payloads are counted inside SQLite;
// no message text, token, public key, user/device identifier, or IP leaves this function.
export function collectServerStats(db, { startedAt, now = Date.now(), activeSessions = 0, pendingPolls = 0, closing = false, outbound, memory, statements } = {}) {
  const count = sql => Number(db.prepare(sql).get().count)
  const queue = db.prepare('SELECT COUNT(*) AS rows, COALESCE(SUM(length(CAST(payload AS BLOB))),0) AS payload_bytes, MIN(created_at) AS oldest FROM queue').get()
  return {
    version: 1,
    uptimeMs: nonnegative(Math.max(0, now - startedAt)),
    closing: closing === true,
    runtime: {
      activeSessions: nonnegative(activeSessions), pendingPolls: nonnegative(pendingPolls),
      ...(outbound ? { outbound: Object.fromEntries(['active', 'bytes', 'peakBytes', 'rejected', 'timeouts'].map(key => [key, nonnegative(outbound[key])])) } : {}),
      ...(memory ? { memory: { rssBytes: nonnegative(memory.rss), heapUsedBytes: nonnegative(memory.heapUsed), externalBytes: nonnegative(memory.external) } } : {}),
      ...(statements ? { statements: Object.fromEntries(['size', 'capacity', 'prepared', 'hits', 'active'].map(key => [key, nonnegative(statements[key])])) } : {}),
    },
    users: count('SELECT COUNT(*) AS count FROM users'),
    groups: count('SELECT COUNT(*) AS count FROM groups'),
    devices: {
      active: count('SELECT COUNT(*) AS count FROM devices WHERE revoked=0'),
      revoked: count('SELECT COUNT(*) AS count FROM devices WHERE revoked<>0'),
    },
    queue: {
      rows: Number(queue.rows),
      payloadBytes: Number(queue.payload_bytes),
      deviceObligations: count('SELECT COUNT(*) AS count FROM queue_devices'),
      oldestAgeMs: queue.oldest === null ? null : nonnegative(Math.max(0, now - queue.oldest)),
    },
  }
}
