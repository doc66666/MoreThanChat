// Operator-only transport: tokens never go in URLs, CLI arguments or output.
import { readAdminToken } from './server-operations.mjs'

export function operatorAddress(value = 'http://localhost:8787') {
  let url
  try { url = new URL(value) } catch { throw new Error('Invalid central server address') }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('Use an HTTPS server origin, or loopback HTTP, without a path or credentials')
  }
  return url.origin
}

export async function operatorRequest(route, { address, env = process.env, defaultTokenFile, body, query, fetchImpl = fetch } = {}) {
  if (!['/v1/admin/access', '/v1/admin/status','/v1/admin/mode','/v1/admin/shutdown'].includes(route) ||
      (route === '/v1/admin/status' && body !== undefined) ||
      (['/v1/admin/mode','/v1/admin/shutdown'].includes(route)&&body===undefined)) throw new Error('Invalid operator route or method')
  if(query!==undefined&&(route!=='/v1/admin/access'||body!==undefined||!['all','whitelist','blacklist'].includes(query.list)||!Number.isSafeInteger(query.offset)||query.offset<0||query.offset>999999999))throw new Error('Invalid operator pagination')
  const origin = operatorAddress(address)
  const credentials = { ...env }
  if (credentials.MTC_SERVER_ADMIN_TOKEN === undefined && credentials.MTC_SERVER_ADMIN_TOKEN_FILE === undefined && defaultTokenFile) {
    credentials.MTC_SERVER_ADMIN_TOKEN_FILE = defaultTokenFile
  }
  const token = await readAdminToken(credentials)
  let response
  try {
    response = await fetchImpl(origin + route+(query?'?'+new URLSearchParams({list:query.list,offset:String(query.offset)}):''), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error', signal: AbortSignal.timeout(10000),
    })
  } catch { throw new Error('Central operator request could not be completed') }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new Error('Central operation failed: HTTP ' + response.status)
  }
  try {
    let length = 0
    const chunks = []
    for await (const chunk of response.body) {
      length += chunk.length
      if (length > 16384) throw new Error('Response limit exceeded')
      chunks.push(chunk)
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (route === '/v1/admin/status') return statusResult(value)
    if(route==='/v1/admin/access'&&body===undefined){
      if(!['public','private'].includes(value?.mode)||!Array.isArray(value.entries)||value.entries.length>100||value.entries.some(row=>!/^usr_[a-f0-9]{64}$/.test(row.userId)||typeof row.allowed!=='boolean')||!(value.nextOffset===null||Number.isSafeInteger(value.nextOffset)&&value.nextOffset>=0))throw new Error('Invalid access listing')
      return {mode:value.mode,entries:value.entries.map(({userId,allowed})=>({userId,allowed})),nextOffset:value.nextOffset}
    }
    if (value?.ok !== true) throw new Error('Invalid access result')
    return { ok: true }
  } catch { throw new Error('Central operator response was invalid') }
}

function statusResult(value) {
  const number = value => {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid metric')
    return value
  }
  if (value?.version !== 1 || typeof value.closing !== 'boolean') throw new Error('Invalid status')
  return {
    version: 1, uptimeMs: number(value.uptimeMs), closing: value.closing,
    runtime: {
      activeSessions: number(value.runtime.activeSessions), pendingPolls: number(value.runtime.pendingPolls),
      ...(value.runtime.outbound ? { outbound: Object.fromEntries(['active', 'bytes', 'peakBytes', 'rejected', 'timeouts'].map(key => [key, number(value.runtime.outbound[key])])) } : {}),
      ...(value.runtime.memory ? { memory: Object.fromEntries(['rssBytes', 'heapUsedBytes', 'externalBytes'].map(key => [key, number(value.runtime.memory[key])])) } : {}),
      ...(value.runtime.statements ? { statements: Object.fromEntries(['size', 'capacity', 'prepared', 'hits', 'active'].map(key => [key, number(value.runtime.statements[key])])) } : {}),
    },
    users: number(value.users), groups: number(value.groups),
    devices: { active: number(value.devices.active), revoked: number(value.devices.revoked) },
    queue: { rows: number(value.queue.rows), payloadBytes: number(value.queue.payloadBytes),
      deviceObligations: number(value.queue.deviceObligations),
      oldestAgeMs: value.queue.oldestAgeMs === null ? null : number(value.queue.oldestAgeMs) },
  }
}

export async function runAccessCli(args = process.argv.slice(2), options = {}) {
  const [operation, userId, address] = args
  if (args.length < 2 || args.length > 3 || !['allow', 'deny'].includes(operation) || !/^usr_[a-f0-9]{64}$/.test(userId ?? '')) {
    throw new Error('Usage: central-access.mjs allow|deny usr_<global-id> [https://server]')
  }
  await operatorRequest('/v1/admin/access', { ...options, address, body: { userId, allowed: operation === 'allow' } })
  return { ok: true, operation, userId, origin: operatorAddress(address) }
}

export async function runStatusCli(args = process.argv.slice(2), options = {}) {
  if (args.length > 1) throw new Error('Usage: central-status.mjs [https://server]')
  return operatorRequest('/v1/admin/status', { ...options, address: args[0] })
}
