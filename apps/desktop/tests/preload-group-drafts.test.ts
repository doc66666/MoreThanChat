import { expect, it, vi } from 'vitest'
const mocks=vi.hoisted(()=>({api:null as any,invoke:vi.fn()}))
vi.mock('electron',()=>({contextBridge:{exposeInMainWorld:(_name:string,api:unknown)=>{mocks.api=api}},ipcRenderer:{invoke:mocks.invoke,on:vi.fn(),removeListener:vi.fn()}}))
import '../src/main/preload'

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
