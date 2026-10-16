import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { generateKeyPairSync, sign } from 'node:crypto'
import { expect, it } from 'vitest'
import { createCentralServer, publicUserId } from '../src/server.mjs'
import { operatorRequest } from '../src/operator-client.mjs'

const token='access-management-test-only-token-0001'
const keys=()=>{const pair=generateKeyPairSync('ed25519'),publicKey=pair.publicKey.export({type:'spki',format:'der'}).toString('base64url');return {...pair,publicKey,userId:publicUserId(publicKey)}}
it('switches modes online, revokes excluded sessions/challenges, retains data and persists removals over bootstrap seeds',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'mtc-access-management-')),a=keys(),b=keys(),apps=[]
  let app,url
  const start=async()=>{app=createCentralServer({directory,mode:'public',adminToken:token,whitelist:[a.userId],blacklist:[b.userId]});apps.push(app);url='http://127.0.0.1:'+(await app.listen(0)).port}
  const req=async(route,body,auth)=>{const response=await fetch(url+route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(auth?{authorization:'Bearer '+auth}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,data:await response.json()}}
  const admin=(route,body)=>req('/v1/admin/'+route,body,token)
  const challenge=user=>req('/v1/challenge',{publicKey:user.publicKey,displayName:'Test'})
  const session=async(user,pending)=>{pending??=await challenge(user);return req('/v1/session',{challengeId:pending.data.challengeId,signature:sign(null,Buffer.from(pending.data.challenge),user.privateKey).toString('base64url')})}
  try{
    await start();const id=app.serverId
    expect((await req('/v1/admin/mode',{mode:'private'},'wrong')).status).toBe(403)
    expect((await req('/v1/admin/access')).status).toBe(403)
    expect((await admin('mode',{mode:'other'})).status).toBe(400)
    expect((await admin('access',{userId:b.userId,list:'blacklist',operation:'remove'})).status).toBe(200)
    const sa=await session(a),sb=await session(b),pending=await challenge(b)
    expect(sa.status).toBe(200);expect(sb.status).toBe(200)
    expect((await admin('mode',{mode:'private'})).status).toBe(200)
    expect((await req('/v1/ping')).data.mode).toBe('private')
    expect((await req('/v1/directory',undefined,sa.data.token)).status).toBe(200)
    expect((await req('/v1/directory',undefined,sb.data.token)).status).toBe(401)
    expect((await session(b,pending)).status).not.toBe(200)
    expect((await challenge(b)).status).toBe(403)
    await admin('access',{userId:a.userId,list:'whitelist',operation:'remove'})
    expect((await req('/v1/directory',undefined,sa.data.token)).status).toBe(401)
    expect((await admin('access')).data.entries).toEqual([])
    await app.close();await start()
    expect(app.serverId).toBe(id);expect(app.mode).toBe('private')
    expect((await admin('access')).data.entries).toEqual([])
    expect(app.db.prepare('SELECT COUNT(*) AS n FROM users').get().n).toBe(2)
    await admin('mode',{mode:'public'});expect((await challenge(b)).status).toBe(200)
    await admin('access',{userId:b.userId,list:'blacklist',operation:'add'});expect((await challenge(b)).status).toBe(403)
    await admin('access',{userId:b.userId,list:'whitelist',operation:'add'});expect((await challenge(b)).status).toBe(200)
    expect((await admin('access')).data.entries).toEqual([{userId:b.userId,allowed:true}])
  }finally{for(const item of apps)await item.close();await rm(directory,{recursive:true,force:true})}
})

it('paginates both lists through the authenticated operator transport',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'mtc-access-pages-'))
  const whitelist=Array.from({length:205},(_,i)=>'usr_'+i.toString(16).padStart(64,'0')),blacklist=['usr_'+'f'.repeat(64)]
  const app=createCentralServer({directory,mode:'private',adminToken:token,whitelist,blacklist})
  try{
    const address='http://127.0.0.1:'+(await app.listen(0)).port,env={MTC_SERVER_ADMIN_TOKEN:token},all=[]
    for(let offset=0;offset!==null;){const page=await operatorRequest('/v1/admin/access',{address,env,query:{list:'whitelist',offset}});all.push(...page.entries.map(row=>row.userId));offset=page.nextOffset}
    expect(all).toEqual(whitelist)
    expect(await operatorRequest('/v1/admin/access',{address,env,query:{list:'blacklist',offset:0}})).toEqual({mode:'private',entries:[{userId:blacklist[0],allowed:false}],nextOffset:null})
  }finally{await app.close();await rm(directory,{recursive:true,force:true})}
})
