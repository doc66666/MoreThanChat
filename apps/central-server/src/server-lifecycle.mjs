import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

// This file must never be unlinked while a process is running. SQLite's OS lock,
// not its existence or a PID, owns the directory and is released after a crash.
export function acquireDirectoryLock(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const lock = new DatabaseSync(path.join(directory, 'server.lock.sqlite'))
  try {
    lock.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE')
  } catch (cause) {
    lock.close()
    const error = new Error('Server data directory is already in use or cannot be locked', { cause })
    error.code = [5, 6].includes(cause?.errcode & 0xff) ? 'DATA_DIR_IN_USE' : 'DATA_DIR_LOCK_FAILED'
    throw error
  }
  let released = false
  return () => {
    if (released) return
    released = true
    lock.close()
  }
}

export function serverLifecycle(server, { shutdownTimeoutMs, onDrain, dispose }) {
  let state = 'starting', closePromise, binding, cancelBinding, expired = false
  const active = new Set(), sockets = new Set(), settled = new Set()
  const listenAbort = new AbortController()
  const closingError = () => Object.assign(new Error('Server closed before listening'), { code: 'SERVER_CLOSING' })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    if (state === 'draining' || state === 'closed') socket.destroy()
  })
  const stopSockets = () => {
    expired = true
    for (const request of active) request.destroy()
    for (const socket of sockets) socket.destroy()
  }
  const close = () => {
    if (closePromise) return closePromise
    state = 'draining'
    // Assign the promise before invoking hooks or cancelling a pending listen.
    closePromise = Promise.resolve().then(async () => {
      const deadline = setTimeout(stopSockets, shutdownTimeoutMs)
      try {
        onDrain()
        cancelBinding?.()
        if (binding) await binding.catch(() => {})
        const stopped = new Promise((resolve, reject) => {
          server.close(error => {
            if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
            else resolve()
          })
          server.closeIdleConnections()
        })
        // Request handlers only await body input and long polling. On deadline,
        // destroying their streams releases both before closing the database.
        const idle = active.size ? new Promise(resolve => settled.add(resolve)) : Promise.resolve()
        await Promise.all([stopped, idle])
      } finally {
        clearTimeout(deadline)
        stopSockets()
        try { dispose() } finally { state = 'closed' }
      }
    })
    return closePromise
  }
  return {
    get state() { return state },
    get activeRequests() { return active.size },
    get expired() { return expired },
    track(request) {
      active.add(request)
      return () => {
        active.delete(request)
        if (!active.size) { for (const resolve of settled) resolve(); settled.clear() }
      }
    },
    async listen(port, host) {
      if (state === 'draining' || state === 'closed') throw closingError()
      if (binding) throw new Error('Server has already been started')
      binding = new Promise((resolve, reject) => {
        const cleanup = () => {
          server.off('error', failed)
          server.off('listening', listening)
          cancelBinding = undefined
        }
        const failed = error => { cleanup(); reject(error) }
        const listening = () => { cleanup(); resolve(server.address()) }
        cancelBinding = () => {
          failed(closingError())
          listenAbort.abort()
        }
        server.once('error', failed)
        server.once('listening', listening)
        try { server.listen({ port, host, signal: listenAbort.signal }) } catch (error) { failed(error) }
      })
      try {
        const address = await binding
        if (state !== 'starting') throw closingError()
        state = 'ready'
        return address
      } catch (error) {
        await close()
        throw error
      }
    },
    close,
  }
}
