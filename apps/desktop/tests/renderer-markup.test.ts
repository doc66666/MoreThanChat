import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AttachmentRef, Directory, Group, ServerSnapshot } from '@more-than-chat/central-protocol'
import { MessageSearch } from '../src/renderer/src/MessageSearch'
import { MessageAttachment } from '../src/renderer/src/MessageAttachment'
import { GroupManager } from '../src/renderer/src/GroupManager'
import { NetworkPanel } from '../src/renderer/src/NetworkPanel'
vi.mock('../src/renderer/src/plugin-host',()=>({chatNetworkService:{}}))

const self='usr_'+'a'.repeat(64),peer='usr_'+'b'.repeat(64)
const group={id:'grp_'+'0'.repeat(36),name:'测试群',ownerId:self,members:[{id:self,displayName:'我',online:true},{id:peer,displayName:'好友',online:false}]} satisfies Group
const directory={groups:[group],friends:[],requests:[],outgoingRequests:[],groupRequests:[],plugins:[]} as unknown as Directory
function button(html:string,attribute:string){return html.match(new RegExp('<button[^>]*'+attribute+'[^>]*>'))?.[0]??''}

describe('renderer markup without launching a browser or desktop app',()=>{
  it('search has an accessible dialog, input and non-destructive empty-state guidance',()=>{
    const html=renderToStaticMarkup(createElement(MessageSearch,{conversationId:'room',title:'群',onClose:vi.fn(),onSelect:vi.fn()}))
    expect(html).toContain('role="dialog"');expect(html).toContain('aria-label="聊天记录关键词"')
    expect(html).toContain('清空关键词不会删除消息');expect(html).not.toContain('没有找到相关消息')
  })
  it('attachments expose save intent and escape untrusted filenames',()=>{
    const attachment={id:'a'.repeat(64),mime:'application/pdf',name:'<script>file</script>.pdf',size:1024} as AttachmentRef
    const html=renderToStaticMarkup(createElement(MessageAttachment,{attachment}))
    expect(html).toContain('另存为');expect(html).toContain('&lt;script&gt;file&lt;/script&gt;.pdf')
    expect(html).not.toContain('<script>');expect(html).not.toContain('正在加载预览')
  })
  it('group operations are disabled while offline without hiding local member information',()=>{
    const html=renderToStaticMarkup(createElement(GroupManager,{group,directory,userId:self,connected:false}))
    expect(html).toContain('当前离线');expect(html).toContain('好友')
    for(const attribute of ['data-transfer-owner','data-remove-member','data-rename-group','data-invite-group-confirm','data-dissolve-group'])expect(button(html,attribute)).toContain('disabled')
  })
  it('no unselected invite is submitted when all friends are already group members',()=>{
    const html=renderToStaticMarkup(createElement(GroupManager,{group,directory:{...directory,friends:[group.members[1]!]},userId:self,connected:true}))
    expect(button(html,'data-invite-group-confirm')).toContain('disabled')
    expect(html).toContain('没有可邀请的本服好友')
    expect(button(html,'data-dissolve-group')).not.toContain('disabled')
  })
  it('offline contacts cannot create groups, request friends or approve cached plugins',()=>{
    const cached={...directory,plugins:[{groupId:group.id,submittedBy:peer,status:'pending',digest:'hash',pack:{id:'plugin',version:1,displayName:'Demo',slot:'chat.details'}}]} as unknown as Directory
    const snapshot={status:'disconnected',serverId:'server',userId:self,directory:cached,address:'http://localhost:8787',displayName:'我'} as unknown as ServerSnapshot
    const html=renderToStaticMarkup(createElement(NetworkPanel,{snapshot,onClose:vi.fn(),onOpenChat:vi.fn()}))
    for(const attribute of ['data-request-friend','data-create-group','data-approve-group-plugin'])expect(button(html,attribute)).toContain('disabled')
    expect(html).toContain('群聊：测试群');expect(html).toContain('聊天详情侧栏（推荐）')
    expect(html).toContain('连接服务器后才能处理')
  })
})
