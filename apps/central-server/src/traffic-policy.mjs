// Volatile, bounded token buckets. Identity limits are applied only after auth;
// neither session rotation nor a client-supplied proxy header creates a new budget.
export const TRAFFIC = Object.freeze({
  authentication: { burst: 240, rate: 40 },
  login: { burst: 16, rate: 0.5 },
  write: { burst: 60, rate: 5 },
  plugin: { burst: 120, rate: 20 },
  query: { burst: 120, rate: 10 },
  inbox: { burst: 120, rate: 20 },
  delivery: { burst: 240, rate: 40 },
})

export function tokenBuckets({ now = () => performance.now(), maxKeys = 8192, idleMs = 300000 } = {}) {
  const entries = new Map()
  let sweptAt = -Infinity
  return {
    get size() { return entries.size },
    take(key, policy) {
      const time = now()
      if (time - sweptAt >= idleMs) {
        for (const [id, item] of entries) if (time - item.at >= idleMs) entries.delete(id)
        sweptAt = time
      }
      let item = entries.get(key)
      if (!item) {
        // Do not evict active identities: churn must not reset their budgets.
        if (entries.size >= maxKeys) return 1
        item = { tokens: policy.burst, at: time }
        entries.set(key, item)
      }
      item.tokens = Math.min(policy.burst, item.tokens + Math.max(0, time - item.at) * policy.rate / 1000)
      item.at = Math.max(item.at, time)
      if (item.tokens < 1) return Math.max(1, Math.ceil((1 - item.tokens) / policy.rate))
      item.tokens -= 1
      return 0
    },
  }
}

export const isControlRequest = (method, route) =>
  (method === 'POST' && ['/v1/ack', '/v1/read', '/v1/logout', '/v1/devices/remove', '/v1/admin/access', '/v1/admin/mode', '/v1/admin/shutdown'].includes(route)) ||
  (method === 'GET' && ['/v1/admin/status','/v1/admin/access'].includes(route))

export function trafficClass(method, route) {
  if (route === '/v1/events') return 'inbox'
  if (isControlRequest(method, route)) return 'delivery'
  if (method === 'GET') return 'query'
  return route === '/v1/plugins/event' ? 'plugin' : 'write'
}

export function bodyLimit(route) {
  if (route === '/v1/plugins/submit') return 700 * 1024
  if (route === '/v1/messages') return 8 * 1024 * 1024
  if (['/v1/challenge', '/v1/session'].includes(route)) return 8 * 1024
  if (['/v1/ack', '/v1/read', '/v1/admin/access'].includes(route)) return 16 * 1024
  // Plugin payload limits are character-based; allow UTF-8 overhead as well.
  return 128 * 1024
}

export function bodyAdmission() {
  const identities = new Map()
  let large = 0
  return {
    acquire(uid, route, control) {
      const heavy = route === '/v1/messages'
      const key = uid ? `${control ? 'control' : 'business'}:${uid}` : null
      if ((heavy && large >= 4) || (key && (identities.get(key) ?? 0) >= 4)) return null
      if (heavy) large++
      if (key) identities.set(key, (identities.get(key) ?? 0) + 1)
      let released = false
      return () => {
        if (released) return
        released = true
        if (heavy) large--
        if (key) {
          const count = identities.get(key) - 1
          if (count) identities.set(key, count)
          else identities.delete(key)
        }
      }
    },
  }
}
