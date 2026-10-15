import { expect, it, vi } from 'vitest'
const mocks=vi.hoisted(()=>({api:null as any,invoke:vi.fn(),on:vi.fn()}))
vi.mock('electron',()=>({contextBridge:{exposeInMainWorld:(_name:string,api:unknown)=>{mocks.api=api}},ipcRenderer:{invoke:mocks.invoke,on:mocks.on,removeListener:vi.fn()}}))
import '../src/main/preload'

it.each([7,11,13])('delivers %i-request completion through the actual preload bridge',requestCount=>{
  const listener=vi.fn(),dispose=mocks.api.onModelChatEvent(listener)
  const handler=mocks.on.mock.calls.at(-1)![1]
  const event={type:'completed',streamId:'s',conversationId:'c',assistantMessageId:'a',generation:1,text:'done',usage:{inputTokens:10,outputTokens:4,totalTokens:14,reportedRequests:requestCount,requestCount}}
  handler({},event)
  expect(listener).toHaveBeenCalledWith(event)
  dispose()
})
it('rejects inconsistent or malformed usage at the preload boundary',()=>{
  const listener=vi.fn(),dispose=mocks.api.onModelChatEvent(listener)
  const handler=mocks.on.mock.calls.at(-1)![1]
  const event={type:'completed',streamId:'s',conversationId:'c',assistantMessageId:'a',generation:1,text:'done',usage:{inputTokens:10,outputTokens:4,totalTokens:14,reportedRequests:13,requestCount:13}}
  for(const bad of [{totalTokens:15},{reportedRequests:14},{requestCount:0},{requestCount:1.5},{apiKey:'unexpected'}])handler({},{...event,usage:{...event.usage,...bad}})
  expect(listener).not.toHaveBeenCalled()
  dispose()
})

it('preserves group draft routing through the real preload parser',async()=>{
  const draft={id:'test.group-game',displayName:'Game',revision:1,version:'0.1.0',updatedAt:1,ok:true,distribution:'group'}
  mocks.invoke.mockResolvedValueOnce({installed:[],drafts:[draft]})
  expect((await mocks.api.inspectPluginDrafts()).drafts[0]).toEqual(draft)
  mocks.invoke.mockResolvedValueOnce({persisted:true,draft,ok:true,summary:'校验通过',issues:[]})
  expect((await mocks.api.createPluginDraft({manifestJson:'{}',source:'{}'})).draft.distribution).toBe('group')
  mocks.invoke.mockResolvedValueOnce({installed:[],drafts:[{...draft,distribution:'execute-shell'}]})
  await expect(mocks.api.inspectPluginDrafts()).rejects.toThrow()
})
it('exposes only user-confirmation IPC and does not give the renderer the Host export method',async()=>{
  expect(mocks.api.exportGroupDraft).toBeUndefined()
  mocks.invoke.mockResolvedValueOnce('pending')
  const input={groupId:'g',pluginId:'p',digest:'digest'}
  expect(await mocks.api.groupPluginConsent(input)).toBe('pending')
  expect(mocks.invoke).toHaveBeenLastCalledWith('central:plugin-consent',input)
})
it('distinguishes an attachment save from a cancelled file dialog',async()=>{
  mocks.invoke.mockResolvedValueOnce('cancelled')
  expect(await mocks.api.saveAttachment('hash')).toBe('cancelled')
  expect(mocks.invoke).toHaveBeenLastCalledWith('attachment:save','hash')
  mocks.invoke.mockResolvedValueOnce('saved')
  expect(await mocks.api.saveAttachment('hash')).toBe('saved')
  mocks.invoke.mockResolvedValueOnce(undefined)
  await expect(mocks.api.saveAttachment('hash')).rejects.toThrow('无效附件保存结果')
})
it('validates initial notification settings instead of silently rendering an empty panel',async()=>{
  mocks.invoke.mockResolvedValueOnce(undefined)
  await expect(mocks.api.getDesktopSettings()).rejects.toThrow('尚未就绪')
  const value={preferences:{notifications:true,preview:false,sound:false,closeToTray:false},trayAvailable:true,notificationsSupported:true,error:null}
  mocks.invoke.mockResolvedValueOnce(value)
  expect(await mocks.api.getDesktopSettings()).toEqual(value)
  mocks.invoke.mockResolvedValueOnce({...value,preferences:{...value.preferences,notifications:'yes'}})
  await expect(mocks.api.configureDesktop({notifications:true})).rejects.toThrow('无效通知偏好')
})
it('preserves cancelled identity and device actions and rejects ambiguous results',async()=>{
  for(const result of ['cancelled','restarting','unchanged']){
    mocks.invoke.mockResolvedValueOnce(result)
    expect(await mocks.api.switchIdentity('profile')).toBe(result)
  }
  for(const result of ['cancelled','removed']){
    mocks.invoke.mockResolvedValueOnce(result)
    expect(await mocks.api.removeDevice('device')).toBe(result)
  }
  mocks.invoke.mockResolvedValueOnce(undefined)
  await expect(mocks.api.switchIdentity('profile')).rejects.toThrow('无效操作结果')
  mocks.invoke.mockResolvedValueOnce('unexpected')
  await expect(mocks.api.removeDevice('device')).rejects.toThrow('无效操作结果')
})
