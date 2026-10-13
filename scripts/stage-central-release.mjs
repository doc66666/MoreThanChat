import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
const root = path.resolve(import.meta.dirname, '..'),
  output = path.join(root, '.artifacts', 'central-release')
await mkdir(output, { recursive: true })
for(const file of await readdir(path.join(root,'apps','central-server','src'))){
  if(file.endsWith('.mjs'))await copyFile(path.join(root,'apps','central-server','src',file),path.join(output,file))
}
for(const [file,method] of [['central-access.mjs','runAccessCli'],['central-status.mjs','runStatusCli']]){
  await writeFile(path.join(output,file),`import { ${method} } from './operator-client.mjs'\ntry { console.log(JSON.stringify(await ${method}(),null,2)) } catch { console.error('Operator command failed: check arguments, address, token configuration and server availability.'); process.exitCode=1 }\n`)
}
const deployment=path.join(output,'deploy')
await mkdir(deployment,{recursive:true})
for(const file of ['more-than-chat.service','server.env.example','Caddyfile.example'])await copyFile(path.join(root,'deploy','central',file),path.join(deployment,file))
await copyFile(path.join(root,'docs','central-and-plugin-stage-2026-10-11.md'),path.join(output,'OPERATIONS.md'))
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
      scripts: { start: 'node server.mjs', status:'node central-status.mjs' },
      engines: { node: '>=24.12.0 <25' },
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
