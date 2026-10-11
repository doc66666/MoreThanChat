import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
const root = path.resolve(import.meta.dirname, '..'),
  output = path.join(root, '.artifacts', 'central-release')
await mkdir(output, { recursive: true })
await copyFile(
  path.join(root, 'apps', 'central-server', 'src', 'server.mjs'),
  path.join(output, 'server.mjs'),
)
await copyFile(
  path.join(root, 'scripts', 'central-access.mjs'),
  path.join(output, 'central-access.mjs'),
)
const moduleRoot = path.join(
    output,
    'node_modules',
    '@more-than-chat',
    'central-protocol',
  ),
  dist = path.join(moduleRoot, 'dist')
await mkdir(dist, { recursive: true })
await copyFile(
  path.join(root, 'packages', 'central-protocol', 'package.json'),
  path.join(moduleRoot, 'package.json'),
)
for (const file of await readdir(
  path.join(root, 'packages', 'central-protocol', 'dist'),
))
  if (file.endsWith('.js') || file.endsWith('.d.ts'))
    await copyFile(
      path.join(root, 'packages', 'central-protocol', 'dist', file),
      path.join(dist, file),
    )
await writeFile(
  path.join(output, 'package.json'),
  JSON.stringify(
    {
      name: 'more-than-chat-central-release',
      version: '0.1.0',
      private: true,
      type: 'module',
      scripts: { start: 'node server.mjs' },
    },
    null,
    2,
  ),
)
const result = spawnSync(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    "import('./server.mjs').then(m=>{if(typeof m.createCentralServer!=='function')process.exit(1)})",
  ],
  { cwd: output, encoding: 'utf8' },
)
if (result.status !== 0)
  throw new Error(
    'Standalone server dependency verification failed: ' + result.stderr,
  )
console.log('Standalone central server prepared: ' + output)
console.log('Only code was staged; any existing .data directory was preserved.')
