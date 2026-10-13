// Isolated packaged-client fixture only. All acceptance interactions happen in the UI.
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { createCentralServer } from '../apps/central-server/src/server.mjs'

const root = path.resolve(import.meta.dirname, '..')
// Restart only fixture clients after a rebuild; the original fixture server stays alive.
// The caller must first close the old test clients to avoid concurrent profile access.
if (process.argv[2] === '--resume-clients') {
  const fixture = JSON.parse(await readFile(path.resolve(process.argv[3]), 'utf8'))
  const exits = []
  for (const { role, profile } of fixture.children) {
    const child = spawn(fixture.executable, [], { env: { ...process.env, MTC_QA_MODE: '1', MTC_QA_USER_DATA_DIR: profile, MTC_DEFAULT_CENTRAL_URL: fixture.url }, windowsHide: false, stdio: 'ignore' })
    exits.push(new Promise(resolve => child.once('exit', resolve)))
    console.log(JSON.stringify({ role, pid: child.pid, profile }))
    await new Promise(resolve => setTimeout(resolve, 1500))
  }
  await Promise.all(exits)
  process.exit(0)
}
const directory = path.join(process.env.LOCALAPPDATA, 'MoreThanChat-Acceptance', `group-ui-${Date.now()}`)
await mkdir(directory, { recursive: true })
const server = createCentralServer({ directory: path.join(directory, 'server'), mode: 'public', adminToken: randomBytes(32).toString('hex') })
const address = await server.listen(0)
const url = `http://127.0.0.1:${address.port}`
const executable = path.join(root, '.artifacts', 'desktop-release', 'win-unpacked', 'MoreThanChat.exe')
const children = []
for (const role of ['author', 'admin', 'player']) {
  const profile = path.join(directory, role)
  const child = spawn(executable, [], { env: { ...process.env, MTC_QA_MODE: '1', MTC_QA_USER_DATA_DIR: profile, MTC_DEFAULT_CENTRAL_URL: url }, windowsHide: false, stdio: 'ignore' })
  children.push({ role, pid: child.pid, profile })
  // Keep launch order unambiguous for initial window selection.
  await new Promise(resolve => setTimeout(resolve, 1500))
}
const metadata = { directory, url, executable, children }
await writeFile(path.join(directory, 'fixture.json'), JSON.stringify(metadata, null, 2))
console.log(JSON.stringify(metadata, null, 2))
// Process is kept alive by the server. Preserve clients and evidence on SIGINT.
process.on('SIGINT', async () => { await server.close(); process.exit(0) })
