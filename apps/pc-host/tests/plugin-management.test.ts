import {mkdtemp,readdir,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {it,expect,vi} from 'vitest'
import {PluginDraftService} from '../src/plugin-drafts'
import {HostPluginService} from '../src/plugin-service'
import {InstalledStaticToolStore} from '../src/installed-static-tools'
import {createPluginManagement} from '../src/plugin-management'
import {createAuthorToolExecutor} from '../src/author-tools'
import {PLUGIN_AUTHOR_CONTRACT} from '../src/author-contract'
import {installConfirmedTextTool} from '../src/static-tool-install'

it('lists both real plugin domains, deletes only the selected draft revision, and keeps client/host uninstall distinct',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'mtc-management-'))
  const plugins=new HostPluginService(1,[]),store=new InstalledStaticToolStore(dir)
  const drafts=new PluginDraftService({dataDir:dir,installedPlugins:()=>[]})
  const client={id:'example.client',version:'1.0.0',displayName:'Client',target:'client' as const,enabled:true,removable:true}
  let installed=true
  const manage=createPluginManagement(drafts,plugins,store,async request=>{
    if(request.action==='list')return {summary:'client',plugins:installed?[client]:[]}
    if(request.action!=='uninstall'||request.id!==client.id||request.version!==client.version)throw Error('stale')
    installed=false;return {summary:'removed',plugins:[]}
  })
  const tools=createAuthorToolExecutor(drafts,manage)
  const call=(name:string,args:unknown)=>tools.execute({id:'test',name,arguments:JSON.stringify(args)})
  const manifest={...PLUGIN_AUTHOR_CONTRACT.executableClient.manifestExample,id:'example.remove'}
  try {
    await plugins.start()
    expect(JSON.parse((await call('list_plugins',{})).content).plugins).toEqual([client])
    expect(JSON.parse((await call('inspect_drafts',{})).content).installed[0].target).toBe('client')
    await drafts.create({manifestJson:JSON.stringify(manifest),source:JSON.stringify({kind:'executable-client',code:'export default function(){}'})})
    expect((await call('delete_draft',{draftId:manifest.id,revision:2})).notice.ok).toBe(false)
    expect((await drafts.inspect()).drafts).toHaveLength(1)
    expect((await call('delete_draft',{draftId:manifest.id,revision:1})).notice.ok).toBe(true)
    expect((await drafts.inspect()).drafts).toHaveLength(0)
    expect(await readdir(path.join(dir,'plugin-drafts','.deleted'))).toHaveLength(1)
    const reopened = new PluginDraftService({dataDir:dir,installedPlugins:()=>[]})
    const recreated = await reopened.create({manifestJson:JSON.stringify(manifest),source:JSON.stringify({kind:'executable-client',code:'export default function(){}'}),baseRevision:0})
    expect(recreated.draft?.revision).toBe(2)
    await expect(reopened.delete(manifest.id,1)).rejects.toThrow('已变化')
    expect((await reopened.inspect()).drafts).toHaveLength(1)
    await reopened.delete(manifest.id,2)
    expect(installed).toBe(true)
    expect((await call('uninstall_plugin',{target:'host',id:client.id,version:client.version})).notice.ok).toBe(false)
    expect(installed).toBe(true)
    expect((await call('uninstall_plugin',{target:'client',id:client.id,version:client.version})).notice.ok).toBe(true)
    expect(installed).toBe(false)
    expect((await call('delete_draft',{draftId:'../outside',revision:1})).notice.ok).toBe(false)
    expect((await call('list_plugins',{action:'delete-draft'})).notice.ok).toBe(false)
  }finally{await plugins.stop();await rm(dir,{recursive:true,force:true})}
})

it('uninstalls persisted Host plugins without restoring them at next launch, but refuses built-ins',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'mtc-uninstall-')),plugins=new HostPluginService(1),store=new InstalledStaticToolStore(dir)
  const drafts=new PluginDraftService({dataDir:dir,installedPlugins:()=>[]}),manage=createPluginManagement(drafts,plugins,store,async()=>({summary:'',plugins:[]}))
  try{
    await plugins.start()
    const builtin=plugins.catalog().plugins[0]!
    await expect(manage({action:'uninstall',target:'host',id:builtin.id,version:builtin.version})).rejects.toThrow('内置')
    const manifest={...PLUGIN_AUTHOR_CONTRACT.manifestExample,id:'example.remove-host'}
    const tool={id:'note',label:'Note',text:'hello'}
    await plugins.installStaticTool(manifest,tool,()=>store.save({v:1,revision:1,enabled:true,kind:'text-tool',manifest,tool}))
    await expect(manage({action:'uninstall',target:'host',id:manifest.id,version:'9.0.0'})).rejects.toThrow('更新')
    const remove=vi.spyOn(store,'remove').mockRejectedValueOnce(new Error('disk failure'))
    await expect(manage({action:'uninstall',target:'host',id:manifest.id,version:manifest.version})).rejects.toThrow('disk failure')
    expect((await store.read(manifest.id))?.enabled).toBe(false)
    expect(plugins.catalog().plugins.find(p=>p.id===manifest.id)?.status).toBe('inactive')
    await manage({action:'uninstall',target:'host',id:manifest.id,version:manifest.version})
    remove.mockRestore()
    expect(await store.list()).toEqual([])
    expect(plugins.catalog().plugins.some(p=>p.id===manifest.id)).toBe(false)
    await drafts.create({manifestJson:JSON.stringify({...manifest,version:'0.2.0'}),source:JSON.stringify({kind:'host-text-tool',toolId:'note',label:'Updated',text:'new contents'})})
    const installed=await installConfirmedTextTool({drafts,plugins,store,draftId:manifest.id,confirmed:true})
    expect(installed.installed).toBe(true)
    expect((await store.read(manifest.id))?.revision).toBe(2)
  }finally{await plugins.stop();await rm(dir,{recursive:true,force:true})}
})
