import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
const root=path.resolve(import.meta.dirname,'..'),version=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version
const args=process.argv.slice(2),directory=path.resolve(args[0]??path.join(root,'.artifacts','release')),checkOnly=args[1]==='--check'
if(args.length>2||(args[1]&&!checkOnly))throw Error('Usage: publish-release.mjs <asset-directory> [--check]')
const names=(await readdir(directory)).filter(name=>/\.(exe|zip|tar\.gz)$/.test(name)).sort()
const required=[`MoreThanChat-${version}-x64-setup.exe`,`MoreThanChat-${version}-win.zip`,`MoreThanChat-central-server-${version}-windows-x64.zip`,`MoreThanChat-central-server-${version}-linux-x64.tar.gz`]
if(names.length!==required.length||required.some(name=>!names.includes(name)))throw Error('Release requires exactly the current Windows installer/ZIP and both central server distributions. Found: '+names.join(', '))
const notes=path.join(root,'docs','releases',`v${version}.md`);await readFile(notes,'utf8')
const lines=[];for(const name of names)lines.push(`${createHash('sha256').update(await readFile(path.join(directory,name))).digest('hex')}  ${name}`)
await writeFile(path.join(directory,'SHA256SUMS.txt'),lines.join('\n')+'\n')
if(checkOnly){console.log('Release assets complete: v'+version);process.exit(0)}
const result=spawnSync('gh',['release','create','v'+version,...names.map(name=>path.join(directory,name)),path.join(directory,'SHA256SUMS.txt'),'--repo','doc66666/MoreThanChat','--verify-tag','--title','MoreThanChat v'+version,'--notes-file',notes,'--latest'],{cwd:root,stdio:'inherit'})
if(result.error)throw result.error
if(result.status!==0)throw Error('Release publishing failed; inspect the remote release before retrying')
