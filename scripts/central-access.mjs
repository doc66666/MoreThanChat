// Operator-only CLI: the administrator token is never entered into client UI.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
const [operation, userId, address = 'http://localhost:8787'] =
  process.argv.slice(2)
if (
  !['allow', 'deny'].includes(operation) ||
  !/^usr_[a-f0-9]{64}$/.test(userId ?? '')
)
  throw new Error(
    'Usage: node scripts/central-access.mjs allow|deny usr_<global-id> [https://server]',
  )
const token =
  process.env.MTC_SERVER_ADMIN_TOKEN ??
  (
    await readFile(
      path.resolve(
        import.meta.dirname,
        '..',
        '.artifacts',
        'central-dev',
        'admin-token',
      ),
      'utf8',
    )
  ).trim()
const url = new URL(address)
if (
  url.username ||
  url.password ||
  url.search ||
  url.hash ||
  (url.protocol !== 'https:' &&
    !(
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    ))
)
  throw new Error('Use HTTPS for remote administration')
const response = await fetch(url.origin + '/v1/admin/access', {
  method: 'POST',
  headers: {
    authorization: 'Bearer ' + token,
    'content-type': 'application/json',
  },
  body: JSON.stringify({ userId, allowed: operation === 'allow' }),
  signal: AbortSignal.timeout(10000),
})
if (!response.ok)
  throw new Error('Access update failed: HTTP ' + response.status)
console.log(operation + ' ' + userId + ' on ' + url.origin)
