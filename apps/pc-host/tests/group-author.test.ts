import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { PluginDraftService } from '../src/plugin-drafts'
import { createAuthorToolExecutor } from '../src/author-tools'
import { ModelService } from '../src/model-service'
import { groupGameArtifact } from '../../../scripts/fixtures/group-game.mjs'
const roots:string[]=[]
afterEach(async()=>{for(const dir of roots.splice(0))await rm(dir,{recursive:true,force:true})})
it('creates, validates and exports a pinned group draft through the model tool loop, never installs or submits',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'mtc-group-author-'));roots.push(dir)
  const drafts=new PluginDraftService({dataDir:dir,installedPlugins:()=>[]}),events:any[]=[]
  const service=new ModelService({dataDir:dir,generation:1,authorTools:createAuthorToolExecutor(drafts),providers:{mock:{async stream(request,onDelta){
    const n=request.messages.filter(m=>m.role==='tool').length
    if(n===0)return {toolCalls:[{id:'create',name:'create_draft',arguments:JSON.stringify({manifestJson:JSON.stringify(groupGameArtifact.manifest),source:JSON.stringify(groupGameArtifact.program)})}]}
    if(n===1)return {toolCalls:[{id:'validate',name:'validate_draft',arguments:JSON.stringify({draftId:'test.group-game'})}]}
    onDelta('草稿已校验，请选择群聊确认提交。');return {toolCalls:[]}
  }}}})
  try {
    await service.load();service.start({streamId:'group-test',conversationId:'more-ai',assistantMessageId:'reply',messages:[{role:'user',content:'创建实时群井字棋'}]},e=>events.push(e))
    await expect.poll(()=>events.some(e=>e.event==='model.chat.completed'),{timeout:5000}).toBe(true)
    const notices=events.filter(e=>e.event==='model.authorTool'&&e.payload.phase==='finished')
    expect(notices).toHaveLength(2)
    for(const notice of notices)expect(notice.payload).toMatchObject({ok:true,pendingInstall:false})
    const inspection=await drafts.inspect();expect(inspection.installed).toEqual([])
    expect(inspection.drafts[0]).toMatchObject({id:'test.group-game',distribution:'group',revision:1,ok:true})
    const exported=await drafts.exportGroup('test.group-game',1)
    expect(JSON.parse(exported.source)).toEqual(groupGameArtifact.program)
    expect((await drafts.planInstall('test.group-game',true)).installable).toBe(false)
    await drafts.create(exported)
    await expect(drafts.exportGroup('test.group-game',1)).rejects.toThrow(/更新/)
    expect(JSON.parse((await new PluginDraftService({dataDir:dir,installedPlugins:()=>[]}).exportGroup('test.group-game',2)).source)).toEqual(groupGameArtifact.program)
  } finally {service.close()}
})
it('rejects invalid group programs, forged capabilities, and author-side install/export tools',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'mtc-group-author-'));roots.push(dir)
  const drafts=new PluginDraftService({dataDir:dir,installedPlugins:()=>[]}),tools=createAuthorToolExecutor(drafts)
  const bad=structuredClone(groupGameArtifact);bad.program.actions.join.guard={op:'shell',args:[]}
  const result=await drafts.create({manifestJson:JSON.stringify(bad.manifest),source:JSON.stringify(bad.program)})
  expect(result.ok).toBe(false);await expect(drafts.exportGroup('test.group-game',1)).rejects.toThrow()
  for(const name of ['pluginDrafts.exportGroup','plugins/submit','install_draft'])expect((await tools.execute({id:'no',name,arguments:'{}'})).notice.ok).toBe(false)
})
