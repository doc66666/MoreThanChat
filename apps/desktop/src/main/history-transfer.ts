import { constants } from 'node:fs'
import { copyFile, link, lstat, mkdir, mkdtemp, open, realpath, rm, unlink } from 'node:fs/promises'
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto'
import path from 'node:path'
import { MAX_ATTACHMENT_BYTES, validateWireAttachment, type AttachmentRef, type WireAttachment } from '@more-than-chat/central-protocol'
import { ChatStore } from './chat-store'
import { ClientIdentity } from './identity-store'
import { AttachmentStore } from './attachments'
import { readHistoryArchive, writeHistoryArchive } from './history-archive'

const FORMAT='more-than-chat.history.v1'
const SIGNING_DOMAIN='MoreThanChat history v1\n'
const MAX_RECORDS=1_000_000
export interface HistoryExportSummary { conversations:number; messages:number; attachments:number; cleanupWarning?:true }
export interface HistoryRestoreSummary { conversationsAdded:number; messagesAdded:number; messagesSkipped:number; retractionsApplied:number; attachments:number; cleanupWarning?:true }
export interface HistoryBackupInfo extends HistoryExportSummary { ownerId:string; createdAt:number }
interface Context {
  directory:string
  store:ChatStore
  identity:ClientIdentity
  attachments:AttachmentStore
  progress?(stage:string):void
  beforeCommit?():Promise<void>
}
type JsonRecord=Record<string,unknown>
function object(value:unknown):JsonRecord {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('历史备份记录无效')
  return value as JsonRecord
}
function exact(value:JsonRecord,keys:string[]):void {
  if(Object.keys(value).length!==keys.length||Object.keys(value).some(key=>!keys.includes(key)))throw new Error('历史备份记录格式不受支持')
}
function addReference(refs:Map<string,AttachmentRef>,raw:unknown):void {
  if(raw===undefined)return
  const ref=object(raw)
  if(typeof ref.id!=='string'||!/^[a-f0-9]{64}$/.test(ref.id)||!Number.isSafeInteger(ref.size)||Number(ref.size)<1||Number(ref.size)>MAX_ATTACHMENT_BYTES||typeof ref.name!=='string'||ref.name.length>200||typeof ref.mime!=='string'||ref.mime.length>100||
    (ref.durationMs!==undefined&&(!Number.isFinite(ref.durationMs)||Number(ref.durationMs)<0||Number(ref.durationMs)>60000)))throw new Error('历史备份附件引用无效')
  if(refs.has(ref.id)&&refs.get(ref.id)!.size!==ref.size)throw new Error('历史备份附件长度冲突')
  if(!refs.has(ref.id))refs.set(ref.id,{id:ref.id,name:ref.name,mime:ref.mime,size:Number(ref.size),...(ref.durationMs===undefined?{}:{durationMs:Number(ref.durationMs)})})
}
async function workspace(directory:string):Promise<{directory:string;dispose():Promise<void>}> {
  await mkdir(directory,{recursive:true,mode:0o700})
  const parent=await realpath(directory)
  const work=await mkdtemp(path.join(parent,'.history-work-'))
  const original=await lstat(work)
  return {directory:work,async dispose(){
    if(path.dirname(path.resolve(work))!==parent||!path.basename(work).startsWith('.history-work-'))throw new Error('无效临时目录')
    const current=await lstat(work)
    if(!current.isDirectory()||current.isSymbolicLink()||current.dev!==original.dev||current.ino!==original.ino)throw new Error('临时目录已变化，未执行清理')
    await rm(work,{recursive:true,force:true})
  }}
}
async function blobBytes(directory:string,ref:AttachmentRef):Promise<Buffer> {
  const file=path.join(directory,ref.id),info=await lstat(file)
  if(!info.isFile()||info.isSymbolicLink()||info.size!==ref.size)throw new Error('附件缺失或已损坏，未完成历史备份/恢复')
  const handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0))
  try{
    const current=await handle.stat()
    if(!current.isFile()||current.size!==ref.size||current.dev!==info.dev||current.ino!==info.ino)throw new Error('附件已变化，请重试')
    const bytes=Buffer.alloc(ref.size)
    let offset=0
    while(offset<bytes.length){const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,offset);if(!bytesRead)throw new Error('附件读取不完整');offset+=bytesRead}
    if((await handle.stat()).size!==ref.size||createHash('sha256').update(bytes).digest('hex')!==ref.id)throw new Error('附件校验失败')
    return bytes
  }finally{await handle.close()}
}
async function syncNewFile(file:string,bytes:Buffer|string):Promise<void> {
  const handle=await open(file,'wx',0o600)
  try{await handle.writeFile(bytes);await handle.sync()}finally{await handle.close()}
}
async function checkMetadata(directory:string,ref:AttachmentRef):Promise<void> {
  const file=path.join(directory,ref.id+'.json'),info=await lstat(file)
  if(!info.isFile()||info.isSymbolicLink()||info.size>4096)throw new Error('已有附件元信息损坏，未覆盖原文件')
  const handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0))
  try{
    const current=await handle.stat()
    if(!current.isFile()||current.size!==info.size||current.dev!==info.dev||current.ino!==info.ino)throw new Error('附件元信息已变化')
    const bytes=Buffer.alloc(info.size)
    let offset=0
    while(offset<bytes.length){const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,offset);if(!bytesRead)throw new Error('附件元信息读取不完整');offset+=bytesRead}
    const existing=object(JSON.parse(bytes.toString('utf8')))
    addReference(new Map(),existing)
    if(existing.id!==ref.id||existing.size!==ref.size||(await handle.stat()).size!==info.size)throw new Error('已有附件元信息损坏，未覆盖原文件')
  }finally{await handle.close()}
}
async function ifPresent(check:()=>Promise<unknown>):Promise<boolean> {
  try{await check();return true}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error}
}
async function publishNewFile(file:string,bytes:Buffer|string):Promise<boolean> {
  const temporary=file+'.import-'+randomUUID()+'.tmp'
  let ownsTemporary=false
  try{
    const handle=await open(temporary,'wx',0o600)
    ownsTemporary=true
    try{await handle.writeFile(bytes);await handle.sync()}finally{await handle.close()}
    try{
      // A hard link atomically publishes the already-fsynced file without replacing data.
      try{await link(temporary,file)}catch(error){
        if(!['EPERM','ENOSYS','ENOTSUP','EOPNOTSUPP','EXDEV'].includes((error as NodeJS.ErrnoException).code??''))throw error
        await copyFile(temporary,file,constants.COPYFILE_EXCL)
        const handle=await open(file,'r+');try{await handle.sync()}finally{await handle.close()}
      }
      return true
    }catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')return false;throw error}
  }finally{if(ownsTemporary)await unlink(temporary).catch(()=>undefined)}
}
async function publishAttachments(source:string,target:string,refs:Map<string,AttachmentRef>):Promise<number> {
  await mkdir(target,{recursive:true,mode:0o700})
  // Validate every existing blob and sidecar before publishing any new attachment.
  // A subsequent I/O/DB failure may leave new unreferenced blobs, never overwrite old ones.
  for(const ref of refs.values()){
    await blobBytes(source,ref)
    await ifPresent(()=>blobBytes(target,ref))
    await ifPresent(()=>checkMetadata(target,ref))
  }
  let added=0
  for(const ref of refs.values()){
    const bytes=await blobBytes(source,ref)
    if(!await ifPresent(()=>blobBytes(target,ref))){
      if(await publishNewFile(path.join(target,ref.id),bytes))added++
      else await blobBytes(target,ref)
    }
    if(!await ifPresent(()=>checkMetadata(target,ref))){
      if(!await publishNewFile(path.join(target,ref.id+'.json'),JSON.stringify(ref)))await checkMetadata(target,ref)
    }
  }
  if(process.platform!=='win32'){const folder=await open(target,'r');try{await folder.sync()}finally{await folder.close()}}
  return added
}
async function cleanup(resources:(()=>unknown)[],result?:{cleanupWarning?:true}):Promise<void> {
  for(const dispose of resources){
    try{await dispose()}catch{
      // Cleanup must not turn a committed merge into a reported failure or suppress its UI refresh.
      if(result)result.cleanupWarning=true
      console.warn('History operation temporary data cleanup failed; original chat data was not removed.')
    }
  }
}

export async function exportHistory(context:Context,target:string,password:string):Promise<HistoryExportSummary> {
  const work=await workspace(context.directory)
  let snapshot:Awaited<ReturnType<ChatStore['createHistorySnapshot']>>|undefined
  let completed:HistoryExportSummary|undefined
  try{
    context.progress?.('建立一致的聊天快照…')
    snapshot=await context.store.createHistorySnapshot(path.join(work.directory,'snapshot.sqlite'))
    const history=snapshot,summary:HistoryExportSummary={conversations:0,messages:0,attachments:0},refs=new Map<string,AttachmentRef>()
    async function* records():AsyncIterable<unknown>{
      const hash=createHash('sha256'),track=(record:unknown)=>{hash.update(JSON.stringify(record)+'\n');return record}
      yield track({type:'header',format:FORMAT,ownerId:context.identity.userId,createdAt:Date.now()})
      let count=0
      for(const record of history.records()){
        if(++count>MAX_RECORDS)throw new Error('单份备份记录数量超过上限')
        if(record.type==='conversation')summary.conversations++
        if(record.type==='message'){summary.messages++;addReference(refs,record.value.attachment)}
        yield track(record)
        if(count%250===0){context.progress?.(`正在备份 ${summary.messages} 条消息…`);await new Promise<void>(resolve=>setImmediate(resolve))}
      }
      context.progress?.('校验并加密附件…')
      for(const ref of refs.values()){
        const bytes=await blobBytes(context.attachments.directory,ref),wire={...ref,data:bytes.toString('base64')}
        validateWireAttachment(wire)
        yield track({type:'attachment',value:wire});summary.attachments++
      }
      const digest=hash.digest('hex')
      yield {type:'end',digest,signature:context.identity.sign(SIGNING_DOMAIN+digest)}
    }
    await writeHistoryArchive(target,password,records())
    completed=summary;return summary
  }finally{await cleanup([()=>snapshot?.close(),()=>work.dispose()],completed)}
}

export async function restoreHistory(context:Context,source:string,password:string,confirm:(info:HistoryBackupInfo)=>Promise<boolean>):Promise<HistoryRestoreSummary|null> {
  const work=await workspace(context.directory)
  let archive:Awaited<ReturnType<typeof readHistoryArchive>>|undefined,staging:ChatStore|undefined
  let completed:HistoryRestoreSummary|undefined
  try{
    context.progress?.('解密并验证完整备份…')
    archive=await readHistoryArchive(source,password,work.directory)
    staging=await ChatStore.open(path.join(work.directory,'staging'),{historyStaging:true})
    const blobDirectory=path.join(work.directory,'attachments');await mkdir(blobDirectory,{mode:0o700})
    const hash=createHash('sha256'),refs=new Map<string,AttachmentRef>(),blobs=new Set<string>()
    const summary:HistoryExportSummary={conversations:0,messages:0,attachments:0}
    let header:HistoryBackupInfo|undefined,ended=false,attachmentsStarted=false,count=0
    for await(const raw of archive.records()){
      const record=object(raw)
      if(ended)throw new Error('备份结束后仍有多余记录')
      if(!header){
        exact(record,['type','format','ownerId','createdAt'])
        if(record.type!=='header'||record.format!==FORMAT||record.ownerId!==context.identity.userId)throw new Error('历史备份不属于当前身份，请先导入并切换原身份')
        if(!Number.isSafeInteger(record.createdAt)||Number(record.createdAt)<0||Number(record.createdAt)>8640000000000000)throw new Error('历史备份时间无效')
        header={...summary,ownerId:context.identity.userId,createdAt:Number(record.createdAt)}
      }else if(record.type==='end'){
        exact(record,['type','digest','signature'])
        const digest=hash.digest('hex')
        if(record.digest!==digest||typeof record.signature!=='string'||!/^[\w-]{86}$/.test(record.signature)||!verify(null,Buffer.from(SIGNING_DOMAIN+digest),createPublicKey({key:Buffer.from(context.identity.publicKey,'base64url'),format:'der',type:'spki'}),Buffer.from(record.signature,'base64url')))throw new Error('历史备份身份签名无效，未修改现有记录')
        ended=true;continue
      }else if(record.type==='attachment'){
        attachmentsStarted=true;exact(record,['type','value'])
        const wire=record.value as WireAttachment;validateWireAttachment(wire)
        const ref=refs.get(wire.id),bytes=Buffer.from(wire.data,'base64')
        if(!ref||blobs.has(wire.id)||ref.size!==wire.size||bytes.toString('base64')!==wire.data||bytes.length!==ref.size||createHash('sha256').update(bytes).digest('hex')!==wire.id)throw new Error('历史备份附件校验失败')
        await syncNewFile(path.join(blobDirectory,wire.id),bytes);blobs.add(wire.id);summary.attachments++
      }else{
        if(attachmentsStarted||++count>MAX_RECORDS)throw new Error('历史备份记录顺序或数量无效')
        staging.stageHistoryRecord(record)
        if(record.type==='conversation')summary.conversations++
        if(record.type==='message'){summary.messages++;addReference(refs,object(record.value).attachment)}
        if(count%250===0){context.progress?.(`已校验 ${summary.messages} 条消息…`);await new Promise<void>(resolve=>setImmediate(resolve))}
      }
      hash.update(JSON.stringify(record)+'\n')
    }
    if(!header||!ended||refs.size!==blobs.size)throw new Error('历史备份不完整或附件缺失，未恢复任何消息')
    context.progress?.('等待确认合并历史记录…')
    if(!await confirm({...header,...summary}))return null
    context.progress?.('准备附件，保留已有数据…')
    const attachments=await publishAttachments(blobDirectory,context.attachments.directory,refs)
    await context.beforeCommit?.()
    context.progress?.('合并聊天记录…')
    // No awaits between the current-store conflict check and its atomic merge.
    completed={...context.store.mergeHistory(staging),attachments};return completed
  }finally{await cleanup([()=>staging?.close(),()=>archive?.dispose(),()=>work.dispose()],completed)}
}
