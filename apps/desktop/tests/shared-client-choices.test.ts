import { expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { directPluginScope, type ServerSnapshot, type GroupPlugin } from '@more-than-chat/central-protocol'
import { SharedPluginChoices } from '../src/renderer/src/SharedClientPlugins'

vi.mock('../src/renderer/src/plugin-host',()=>({pluginRuntime:{},chatNetworkService:{}}))

it('distinguishes the same shared package in a group and direct conversation',()=>{
  const uid='usr_'+'a'.repeat(64),peer='usr_'+'b'.repeat(64),group='grp_test',direct=directPluginScope(uid,peer)
  const plugin={pack:{id:'same-package',kind:'executable',displayName:'Game',version:1},digest:'same-digest',status:'approved'} as GroupPlugin
  const snapshot={status:'connected',serverId:'test',userId:uid,directory:{groups:[{id:group,name:'Test group'}],friends:[{id:peer,displayName:'Test friend'}],plugins:[{...plugin,groupId:group},{...plugin,groupId:direct}]}} as ServerSnapshot
  const markup=renderToStaticMarkup(createElement(SharedPluginChoices,{snapshot,onError:()=>{}}))
  expect(markup).toContain('群聊 · Test group')
  expect(markup).toContain('好友 · Test friend')
  expect(markup).toContain(`data-plugin-scope="${group}"`)
  expect(markup).toContain(`data-plugin-scope="${direct}"`)
  const scoped=renderToStaticMarkup(createElement(SharedPluginChoices,{snapshot,scope:direct,onError:()=>{}}))
  expect(scoped).toContain('好友 · Test friend')
  expect(scoped).not.toContain('群聊 · Test group')
})
