const MiB = 1024 * 1024
export const RESPONSE_LIMIT = 32 * MiB
export const RESPONSE_BUDGET = 64 * MiB

// Counts retained serialized UTF-8 payloads, not process RSS or kernel buffers.
export function responseBudget() {
  const users = new Map()
  let bytes = 0, active = 0, peakBytes = 0, rejected = 0, timeouts = 0
  return {
    snapshot: () => ({ active, bytes, peakBytes, rejected, timeouts }),
    timeout() { timeouts++ },
    acquire(size, uid) {
      if (!Number.isSafeInteger(size) || size < 0 || size > RESPONSE_LIMIT || bytes + size > RESPONSE_BUDGET || (uid && (users.get(uid) ?? 0) >= 2)) {
        rejected++
        return null
      }
      bytes += size; active++; peakBytes = Math.max(peakBytes, bytes)
      if (uid) users.set(uid, (users.get(uid) ?? 0) + 1)
      let released = false
      return () => {
        if (released) return
        released = true
        bytes -= size; active--
        if (uid) {
          const count = users.get(uid) - 1
          if (count) users.set(uid, count)
          else users.delete(uid)
        }
      }
    },
  }
}

// At most 64 KiB of UTF-8 per write, waiting for drain before writing more.
// Completion is transport completion only. It must never acknowledge a message.
export function writeResponse(response, payload, release, { timeoutMs = 30000, onTimeout = () => {} } = {}) {
  return new Promise(resolve => {
    let offset = 0, settled = false
    const finish = () => settle(true)
    const closed = () => settle(false)
    const settle = success => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      response.off('drain', pump)
      response.off('finish', finish)
      response.off('close', closed)
      response.off('error', closed)
      payload = ''
      release()
      resolve(success)
    }
    const pump = () => {
      if (settled) return
      if (response.destroyed) return closed()
      try {
        while (offset < payload.length) {
          let end = Math.min(offset + 16384, payload.length)
          // Never split a UTF-16 surrogate pair across separate UTF-8 writes.
          const last = payload.charCodeAt(end - 1)
          if (end < payload.length && last >= 0xd800 && last <= 0xdbff) end--
          const chunk = payload.slice(offset, end)
          offset = end
          if (!response.write(chunk, 'utf8')) return
        }
        response.end()
      } catch { response.destroy(); closed() }
    }
    const timer = setTimeout(() => {
      try { onTimeout() } finally { response.destroy(); closed() }
    }, timeoutMs)
    timer.unref?.()
    response.on('drain', pump)
    response.once('finish', finish)
    response.once('close', closed)
    response.once('error', closed)
    pump()
  })
}
