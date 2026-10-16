import { spawn } from 'node:child_process'
import { open, stat, mkdir, rename } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { createInterface } from 'node:readline/promises'
import { DEFAULT_CONFIG, initializeManagedConfig, loadManagedConfig, managedAddress, managedEnvironment, saveManagedConfig } from './managed-config.mjs'
import { operatorRequest } from './operator-client.mjs'
import { startCentralProcess } from './server-operations.mjs'
import { createCentralServer } from './server.mjs'

const help=`MoreThanChat 中心服务器管理
  init [--mode public|private] [--port 8787] [--host 0.0.0.0] [--name 名称]
  setup                         交互配置（停机后修改；首次运行也可直接 start）
  start | run | stop | restart   后台启动 / 前台运行 / 正常停止 / 重启
  status                        查看服务、队列、内存及当前模式
  config show                   查看配置（不显示管理员密钥）
  config set name|host|port|dataDir|logDir <值>  停机修改，下次启动生效
  mode public|private           在线切换黑名单/白名单模式，立即生效并持久保存
  whitelist|blacklist list       列出完整名单
  whitelist|blacklist add|remove usr_<全局UID>
  logs [--lines 100] [--follow]   查看日志；Ctrl+C 结束跟随
所有命令可带 --config /绝对路径/server.config.json。
public=黑名单模式；private=白名单模式（空白名单不允许用户连接）。
运行后以数据库保存的模式为准；切换模式不删除好友、群、队列或名单。`
const output=value=>console.log(typeof value==='string'?value:JSON.stringify(value,null,2))
function parse(args){
  let file=path.resolve(import.meta.dirname,'server.config.json');const rest=[]
  for(let i=0;i<args.length;i++)if(args[i]==='--config'){if(!args[i+1])throw Error('--config 缺少路径');file=path.resolve(args[++i])}else rest.push(args[i])
  return {file,args:rest}
}
const options=(config,file)=>({address:managedAddress(config),env:managedEnvironment(config,file)})
async function alive(config,file){
  try{await operatorRequest('/v1/admin/status',options(config,file));return true}
  catch(error){if(error.message==='Central operator request could not be completed')return false;if(error.message==='Central operation failed: HTTP 503')return true;throw error}
}
async function requireStopped(config,file){if(await alive(config,file))throw Error('服务器正在运行，请先 stop；模式切换使用 mode 命令，无需重启')}
async function tail(filename,lines){
  let handle
  try{handle=await open(filename,'r');const size=(await handle.stat()).size,buffer=Buffer.alloc(Math.min(size,1024*1024));await handle.read(buffer,0,buffer.length,Math.max(0,size-buffer.length));return {size,text:buffer.toString('utf8').trimEnd().split(/\r?\n/).slice(-lines).join('\n')}}
  catch(error){if(error.code==='ENOENT')return {size:0,text:'暂无日志'};throw error}finally{await handle?.close()}
}
async function stop(config,file){
  if(!await alive(config,file)){output('服务器未运行');return}
  await operatorRequest('/v1/admin/shutdown',{...options(config,file),body:{}})
  for(let i=0;i<80;i++){await delay(200);if(!await alive(config,file)){output('服务器已正常停止');return}}
  throw Error('停止尚未完成，请查看日志；未强制终止进程')
}
export async function runServerCli(raw=process.argv.slice(2)){
  const {file,args}=parse(raw),[command,...extra]=args
  if(!command||['help','--help','-h'].includes(command)){output(help);return}
  if(command==='init'){
    const values={}
    for(let i=0;i<extra.length;i+=2){const key=extra[i]?.slice(2);if(!['mode','port','host','name'].includes(key)||extra[i+1]===undefined)throw Error('init 参数无效，使用 --help 查看');values[key]=key==='port'?Number(extra[i+1]):extra[i+1]}
    const result=await initializeManagedConfig(file,values);output({created:result.created,configFile:file,...result.config});return
  }
  if(command==='setup'){
    if(extra.length||!process.stdin.isTTY)throw Error('setup 需要交互终端；脚本使用 init/config set')
    let previous
    try{previous=await loadManagedConfig(file);await requireStopped(previous,file)}catch(error){if(error.code!=='ENOENT')throw error}
    const current=previous??{...DEFAULT_CONFIG},reader=createInterface({input:process.stdin,output:process.stdout})
    try{for(const [key,label] of [['name','服务器名称'],['host','监听地址'],['port','端口'],...(!previous?[['mode','初始模式 public/private']]:[])]){const value=await reader.question(`${label} [${current[key]}]: `);if(value.trim())current[key]=key==='port'?Number(value):value.trim()}}
    finally{reader.close()}
    if(previous)await saveManagedConfig(file,current);else await initializeManagedConfig(file,current)
    output('配置已保存。运行 start 启动；已建服务的模式通过 mode 命令切换。');return
  }
  if(command==='start')await initializeManagedConfig(file)
  const config=await loadManagedConfig(file),logFile=path.resolve(path.dirname(file),config.logDir,'server.log')
  if(command==='config'){
    if(extra[0]==='show'&&extra.length===1){output({configFile:file,...config,modeNote:'mode 为初始模式；当前运行模式见 status'});return}
    if(extra[0]!=='set'||extra.length!==3||!['name','host','port','dataDir','logDir'].includes(extra[1]))throw Error('使用 config show 或 config set name|host|port|dataDir|logDir <值>；模式用 mode')
    await requireStopped(config,file)
    await saveManagedConfig(file,{...config,[extra[1]]:extra[1]==='port'?Number(extra[2]):extra[2]});output('配置已保存，下次启动生效');return
  }
  if(command==='logs'){
    let lines=100,follow=false
    for(let i=0;i<extra.length;i++)if(extra[i]==='--follow')follow=true;else if(extra[i]==='--lines'&&/^\d+$/.test(extra[i+1]??''))lines=Number(extra[++i]);else throw Error('使用 logs [--lines 100] [--follow]')
    if(lines<1||lines>10000)throw Error('日志行数应为 1–10000')
    const initial=await tail(logFile,lines);output(initial.text);let offset=initial.size
    while(follow){await delay(500);let handle;try{handle=await open(logFile,'r');const size=(await handle.stat()).size;if(size<offset)offset=0;if(size>offset){const buffer=Buffer.alloc(Math.min(size-offset,1024*1024));const read=await handle.read(buffer,0,buffer.length,offset);offset+=read.bytesRead;process.stdout.write(buffer.subarray(0,read.bytesRead))}}catch(error){if(error.code!=='ENOENT')throw error}finally{await handle?.close()}}
    return
  }
  if(command==='mode'){
    if(extra.length!==1||!['public','private'].includes(extra[0]))throw Error('使用 mode public|private')
    await operatorRequest('/v1/admin/mode',{...options(config,file),body:{mode:extra[0]}});output({ok:true,mode:extra[0],persisted:true});return
  }
  if(['whitelist','blacklist'].includes(command)){
    if(extra.length===1&&extra[0]==='list'){
      let offset=0;const entries=[];let mode
      do{const page=await operatorRequest('/v1/admin/access',{...options(config,file),query:{list:command,offset}});entries.push(...page.entries.map(row=>row.userId));mode=page.mode;if(page.nextOffset!==null&&page.nextOffset<=offset)throw Error('无效名单游标');offset=page.nextOffset}while(offset!==null)
      output({mode,list:command,userIds:entries});return
    }
    if(extra.length!==2||!['add','remove'].includes(extra[0])||!/^usr_[a-f0-9]{64}$/.test(extra[1]))throw Error('使用 '+command+' list|add|remove usr_<完整全局UID>')
    await operatorRequest('/v1/admin/access',{...options(config,file),body:{list:command,operation:extra[0],userId:extra[1]}});output({ok:true,list:command,operation:extra[0],userId:extra[1]});return
  }
  if(extra.length)throw Error('此命令不接受额外参数')
  if(command==='status'){const stats=await operatorRequest('/v1/admin/status',options(config,file)),access=await operatorRequest('/v1/admin/access',options(config,file));output({address:managedAddress(config),mode:access.mode,...stats});return}
  if(command==='stop'){await stop(config,file);return}
  if(command==='restart'){await stop(config,file);return runServerCli(['start','--config',file])}
  if(command==='run'){
    await startCentralProcess({factory:createCentralServer,env:managedEnvironment(config,file),log:line=>console.log(JSON.stringify({time:new Date().toISOString(),...JSON.parse(line)}))});return
  }
  if(command==='start'){
    if(await alive(config,file)){output('服务器已在运行：'+managedAddress(config));return}
    await mkdir(path.dirname(logFile),{recursive:true,mode:0o700})
    try{if((await stat(logFile)).size>10*1024*1024)await rename(logFile,logFile+'.'+Date.now())}catch(error){if(error.code!=='ENOENT')throw error}
    const handle=await open(logFile,'a',0o600)
    let child,error,exited=false
    try{child=spawn(process.execPath,[path.join(import.meta.dirname,'server-cli.mjs'),'run','--config',file],{detached:true,windowsHide:true,stdio:['ignore',handle.fd,handle.fd]});child.on('error',caught=>{error=caught});child.on('exit',()=>{exited=true});child.unref()}
    finally{await handle.close()}
    for(let i=0;i<100;i++){
      await delay(100)
      if(error||exited)throw Error('服务器启动失败，请运行 logs 查看原因')
      if(await alive(config,file)){output({started:true,pid:child.pid,address:managedAddress(config),logFile,mode:(await operatorRequest('/v1/admin/access',options(config,file))).mode});return}
    }
    throw Error('服务器尚未就绪，请运行 status / logs 核对；未强制停止进程')
  }
  throw Error('未知命令。使用 --help 查看命令列表')
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{await runServerCli()}catch(error){console.error(error.code==='ENOENT'?'未找到配置，请先运行 init 或 start。':error.message);process.exitCode=1}
}
