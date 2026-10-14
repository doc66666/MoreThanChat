import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile, readdir, writeFile, access } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { verifyPackagedHost } from './package-dir.mjs'

if (process.platform !== 'win32') throw new Error('Windows installer packaging requires Windows. Linux can still build/test the shared source and central server.')
const root = path.resolve(import.meta.dirname, '..'), desktop = path.join(root, 'apps/desktop')
const manifest = JSON.parse(await readFile(path.join(desktop, 'package.json'), 'utf8'))
// Unique output: never overwrite a running unpacked app or an earlier published release.
const output = path.join(root, '.artifacts', 'windows-distributions', `${manifest.version}-${Date.now()}`)
await access(path.join(root, '.artifacts/host-resources/main.js'))
const require = createRequire(path.join(desktop, 'package.json'))
const cli = require.resolve('electron-builder/cli.js')
const result = spawnSync(process.execPath, [cli, '--win', 'nsis', 'zip', '--x64', '--publish', 'never', `--config.directories.output=${output}`], {cwd: desktop, stdio: 'inherit', env: {...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false'}})
if (result.error) throw result.error
if (result.status !== 0) throw new Error(`Windows packaging exited ${result.status}`)
await verifyPackagedHost(output)
const files = (await readdir(output)).filter(name => /\.(exe|zip)$/.test(name)).sort()
if (!files.some(n => n.endsWith('-setup.exe')) || !files.some(n => n.endsWith('.zip'))) throw new Error('Missing installer or ZIP')
const hashes = []
for (const file of files) hashes.push(`${createHash('sha256').update(await readFile(path.join(output, file))).digest('hex')}  ${file}`)
await writeFile(path.join(output, 'SHA256SUMS.txt'), hashes.join('\n') + '\n')
console.log(`Installer, ZIP and checksums: ${output}`)
console.log('Local build only: nothing uploaded, no release tag changed, no auto-updater. Installer execution has not been accepted by this build check.')
