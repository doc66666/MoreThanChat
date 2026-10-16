import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
const root=path.resolve(import.meta.dirname,'..'),version=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version
const platform=process.platform==='win32'?'win':process.platform==='linux'?'linux':null
if(!platform||process.arch!=='x64')throw Error('Central distribution packaging currently supports Windows/Linux x64')
const runtimeVersion='24.12.0',runtimeName=`node-v${runtimeVersion}-${platform}-x64`,archiveName=runtimeName+(platform==='win'?'.zip':'.tar.xz')
const output=path.join(root,'.artifacts','central-distributions',`${version}-${platform}-${Date.now()}`),name=`MoreThanChat-central-server-${version}-${platform==='win'?'windows':'linux'}-x64`,staged=path.join(output,name)
await mkdir(output,{recursive:true})
function run(program,args,options={}){const result=spawnSync(program,args,{stdio:'inherit',...options});if(result.error)throw result.error;if(result.status!==0)throw Error(`${program} failed: ${result.status}`)}
run(process.execPath,[path.join(root,'scripts/stage-central-release.mjs'),'--output',staged])
const origin=`https://nodejs.org/dist/v${runtimeVersion}/`
async function download(file){const response=await fetch(origin+file,{signal:AbortSignal.timeout(120000)});if(!response.ok)throw Error('Node runtime download failed: '+response.status);return Buffer.from(await response.arrayBuffer())}
const sums=(await download('SHASUMS256.txt')).toString(),expected=sums.split(/\r?\n/).find(line=>line.endsWith('  '+archiveName))?.split(/\s+/)[0]
if(!expected||!/^[a-f0-9]{64}$/.test(expected))throw Error('Node runtime checksum missing')
const archive=await download(archiveName)
if(createHash('sha256').update(archive).digest('hex')!==expected)throw Error('Node runtime checksum mismatch')
const archivePath=path.join(output,archiveName);await writeFile(archivePath,archive)
run('tar',['-xf',archivePath,'-C',output])
const runtime=path.join(staged,'runtime');await mkdir(path.join(runtime,'bin'),{recursive:true})
const binary=platform==='win'?'node.exe':'bin/node'
await copyFile(path.join(output,runtimeName,binary),path.join(runtime,binary))
await copyFile(path.join(output,runtimeName,'LICENSE'),path.join(runtime,'LICENSE'))
await writeFile(path.join(runtime,'SOURCE.txt'),`${origin}${archiveName}\nSHA256 ${expected}\n`)
if(platform==='linux')for(const file of ['runtime/bin/node','start.sh','mtc-server.sh'])await chmod(path.join(staged,file),0o755)
run(path.join(runtime,binary),['--version'])
// Validate the exact staged release and its bundled runtime before archiving.
run(path.join(runtime,binary),[path.join(root,'scripts/verify-central-cli.mjs'),'--release',staged])
const target=path.join(output,name+(platform==='win'?'.zip':'.tar.gz'))
run('tar',[...(platform==='win'?['-a','-cf']:['-czf']),target,'-C',output,name])
const hash=createHash('sha256').update(await readFile(target)).digest('hex')
await writeFile(path.join(output,'SHA256SUMS.txt'),`${hash}  ${path.basename(target)}\n`)
console.log('Central distribution: '+target)
