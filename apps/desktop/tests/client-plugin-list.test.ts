// @vitest-environment happy-dom
import {act, createElement} from 'react'
import {createRoot} from 'react-dom/client'
import {afterEach, expect, it, vi} from 'vitest'
import type {InstalledClientPackage} from '@more-than-chat/plugin-runtime'

vi.mock('../src/renderer/src/plugin-host', () => ({pluginRuntime:{list:()=>[],subscribe:()=>()=>{}}}))
vi.mock('../src/renderer/src/SharedClientPlugins', () => ({ShareClientPlugin:()=>null,SharedPluginChoices:()=>null}))
vi.mock('../src/renderer/src/app-api', () => ({appApi:{}}))
vi.mock('../src/renderer/src/chat-sdk', () => ({chatSdk:{}}))
import {ClientPlugins} from '../src/renderer/src/ClientPlugins'

function deferred<T>() {
  let resolve!:(value:T)=>void, reject!:(error:Error)=>void
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no})
  return {promise,resolve,reject}
}
const pack=(id:string)=>({manifest:{id,displayName:id,version:'1.0.0'},enabled:false} as InstalledClientPackage)
afterEach(()=>vi.restoreAllMocks())

it.each(['older result','older error'])('keeps the latest plugin inventory when a slower request returns an %s', async stale => {
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true})
  const old=deferred<InstalledClientPackage[]>(),latest=deferred<InstalledClientPackage[]>()
  window.moreThanChat={getClientPlugins:vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise)} as unknown as Window['moreThanChat']
  const container=document.createElement('div');document.body.append(container)
  const root=createRoot(container)
  try {
    await act(async()=>root.render(createElement(ClientPlugins,{snapshot:null})))
    await act(async()=>window.dispatchEvent(new Event('client-plugins-changed')))
    await act(async()=>latest.resolve([pack('user.latest')]))
    expect(container.querySelector('[data-client-plugin="user.latest"]')).not.toBeNull()
    await act(async()=>{if(stale==='older result')old.resolve([pack('user.removed')]);else old.reject(new Error('stale inventory error'))})
    expect(container.querySelector('[data-client-plugin="user.latest"]')).not.toBeNull()
    expect(container.querySelector('[data-client-plugin="user.removed"]')).toBeNull()
    expect(container.textContent).not.toContain('stale inventory error')
  } finally {await act(async()=>root.unmount());container.remove()}
})
