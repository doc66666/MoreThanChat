import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
const root=path.resolve(import.meta.dirname,'..'),args=process.argv.slice(2)
if(args.length&&!(args.length===2&&args[0]==='--release'))throw Error('Usage: verify-central-cli.mjs [--release directory]')
const entry=path.join(args.length?path.resolve(args[1]):path.join(root,'apps/central-server/src'),'server-cli.mjs')
const directory=await mkdtemp(path.join(tmpdir(),'mtc-central-cli-')),file=path.join(directory,'server.config.json')
const socket=createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve))
const url='http://127.0.0.1:'+port
async function cli(...args){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[entry,...args,'--config',file],{windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',error=''
    const timer=setTimeout(()=>{child.kill();reject(Error('CLI deadline: '+args.join(' ')))},20000)
    child.stdout.on('data',chunk=>out+=chunk);child.stderr.on('data',chunk=>error+=chunk)
    child.once('error',reject);child.once('close',code=>{clearTimeout(timer);resolve({code,out,error})})
  })
}
async function ok(...args){const result=await cli(...args);assert.equal(result.code,0,result.error+' '+result.out);return result.out}
async function request(route,body,token){const response=await fetch(url+route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});return {status:response.status,data:await response.json()}}
const identity=()=>{const pair=generateKeyPairSync('ed25519');return {privateKey:pair.privateKey,publicKey:pair.publicKey.export({type:'spki',format:'der'}).toString('base64url')}}
const challenge=user=>request('/v1/challenge',{publicKey:user.publicKey,displayName:'CLI verification'})
async function login(user){const c=await challenge(user);assert.equal(c.status,200);const s=await request('/v1/session',{challengeId:c.data.challengeId,signature:sign(null,Buffer.from(c.data.challenge),user.privateKey).toString('base64url')});assert.equal(s.status,200);return {...s.data,userId:c.data.userId}}
let running=false
try{
  await ok('init','--port',String(port),'--host','127.0.0.1','--mode','public')
  const token=await readFile(path.join(directory,'admin-token'),'utf8')
  await ok('init','--mode','private');assert.equal(await readFile(path.join(directory,'admin-token'),'utf8'),token)
  await ok('config','set','name','中心 CLI 验收')
  await ok('start');running=true
  assert.equal(JSON.parse(await ok('status')).mode,'public')
  assert.equal((await cli('config','set','port','12345')).code,1)
  await ok('start') // idempotent; no second process takes ownership
  const a=identity(),b=identity(),sa=await login(a),sb=await login(b)
  await ok('whitelist','add',sa.userId)
  await ok('mode','private')
  assert.equal((await request('/v1/directory',undefined,sb.token)).status,401)
  assert.equal((await challenge(b)).status,403)
  assert.equal((await request('/v1/directory',undefined,sa.token)).status,200)
  assert.deepEqual(JSON.parse(await ok('whitelist','list')).userIds,[sa.userId])
  await ok('mode','public');await ok('blacklist','add',sb.userId)
  assert.equal((await challenge(b)).status,403)
  assert.deepEqual(JSON.parse(await ok('blacklist','list')).userIds,[sb.userId])
  await ok('blacklist','remove',sb.userId);assert.equal((await challenge(b)).status,200)
  await ok('whitelist','remove',sa.userId);await ok('mode','private')
  await ok('restart');assert.equal(JSON.parse(await ok('status')).mode,'private')
  assert.deepEqual(JSON.parse(await ok('whitelist','list')).userIds,[])
  assert.equal((await challenge(a)).status,403)
  const logs=await ok('logs','--lines','100')
  assert(logs.includes('central.started')&&logs.includes('central.access_changed'));assert(!logs.includes(token.trim()))
  await ok('stop');running=false;await ok('stop')
  assert.equal((await cli('status')).code,1)
  console.log(JSON.stringify({ok:true,release:args[1]??null,checks:['initialize','configure','start/stop/restart','authenticated status','public/private switching','whitelist/blacklist add/list/remove','immediate session revocation','persistence','logs without tokens']}))
}finally{
  if(running)await cli('stop')
  await rm(directory,{recursive:true,force:true})
}
