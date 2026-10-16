import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { readServerConfig } from './server-operations.mjs'

export const DEFAULT_CONFIG={version:1,name:'MoreThanChat 中心服务器',host:'0.0.0.0',port:8787,mode:'private',dataDir:'./data',logDir:'./logs',adminTokenFile:'./admin-token'}
const fields=Object.keys(DEFAULT_CONFIG)
export async function validateManagedConfig(value,file){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!fields.includes(key))||fields.some(key=>value[key]===undefined)||value.version!==1)throw Error('服务器配置格式无效')
  if(!['0.0.0.0','127.0.0.1','::','::1'].includes(value.host))throw Error('host 请使用 0.0.0.0、127.0.0.1、:: 或 ::1')
  if(!Number.isSafeInteger(value.port))throw Error('port 必须为整数')
  for(const key of ['dataDir','logDir','adminTokenFile'])if(typeof value[key]!=='string'||!value[key].trim()||value[key]!==value[key].trim()||/[\x00-\x1f]/.test(value[key]))throw Error('无效路径配置：'+key)
  await readServerConfig({...managedEnvironment(value,file),MTC_SERVER_ADMIN_TOKEN:'config-validation-placeholder-0001',MTC_SERVER_ADMIN_TOKEN_FILE:undefined})
  return value
}
export function managedEnvironment(config,file){
  return {MTC_SERVER_NAME:config.name,MTC_SERVER_HOST:config.host,MTC_SERVER_PORT:String(config.port),MTC_SERVER_MODE:config.mode,
    MTC_SERVER_DATA_DIR:path.resolve(path.dirname(file),config.dataDir),MTC_SERVER_ADMIN_TOKEN_FILE:path.resolve(path.dirname(file),config.adminTokenFile)}
}
export async function loadManagedConfig(file){return validateManagedConfig(JSON.parse(await readFile(file,'utf8')),file)}
export async function saveManagedConfig(file,config,{create=false}={}){
  await validateManagedConfig(config,file)
  await mkdir(path.dirname(file),{recursive:true,mode:0o700})
  const contents=JSON.stringify(config,null,2)+'\n'
  if(create){await writeFile(file,contents,{flag:'wx',mode:0o600});return}
  const temporary=file+'.'+randomUUID()+'.tmp'
  await writeFile(temporary,contents,{flag:'wx',mode:0o600})
  await rename(temporary,file)
}
export async function initializeManagedConfig(file,values={}){
  try{return {created:false,config:await loadManagedConfig(file)}}catch(error){if(error.code!=='ENOENT')throw error}
  const config=await validateManagedConfig({...DEFAULT_CONFIG,...values},file)
  const tokenFile=managedEnvironment(config,file).MTC_SERVER_ADMIN_TOKEN_FILE
  await mkdir(path.dirname(tokenFile),{recursive:true,mode:0o700})
  try{await writeFile(tokenFile,randomBytes(32).toString('base64url')+'\n',{flag:'wx',mode:0o600})}catch(error){if(error.code!=='EEXIST')throw error}
  await saveManagedConfig(file,config,{create:true})
  return {created:true,config}
}
export const managedAddress=config=>`http://${config.host.includes(':')?'[::1]':'127.0.0.1'}:${config.port}`
