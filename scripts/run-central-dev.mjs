import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { createCentralServer } from '../apps/central-server/src/server.mjs'
const directory = path.resolve(
  import.meta.dirname,
  '..',
  '.artifacts',
  'central-dev',
)
await mkdir(directory, { recursive: true, mode: 0o700 })
const tokenPath = path.join(directory, 'admin-token')
let token
try {
  token = (await readFile(tokenPath, 'utf8')).trim()
} catch (e) {
  if (e.code !== 'ENOENT') throw e
  token = randomBytes(32).toString('base64url')
  await writeFile(tokenPath, token, { flag: 'wx', mode: 0o600 })
}
const app = createCentralServer({
  directory,
  mode: 'public',
  adminToken: token,
  name: 'MoreThanChat 本机开发服务器',
})
await app.listen(8787, '127.0.0.1')
console.log(
  'Development central server: http://localhost:8787 (loopback only; public blacklist mode)',
)
console.log('Admin credential path: ' + tokenPath)
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    void app.close().then(() => process.exit(0))
  })
