import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { createCentralServer } from '../apps/central-server/src/server.mjs'
import { startCentralProcess } from '../apps/central-server/src/server-operations.mjs'
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
const running = await startCentralProcess({
  factory:createCentralServer,
  env:{
    MTC_SERVER_DATA_DIR:directory,
    MTC_SERVER_MODE:'public',
    MTC_SERVER_ADMIN_TOKEN_FILE:tokenPath,
    MTC_SERVER_NAME:'MoreThanChat 本机开发服务器',
    MTC_SERVER_HOST:'127.0.0.1',
    MTC_SERVER_PORT:'8787',
  },
})
if(running){console.log(
  'Development central server: http://localhost:8787 (loopback only; public blacklist mode)',
)
console.log('Admin credential path: ' + tokenPath)
}
