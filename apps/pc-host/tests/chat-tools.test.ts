import { expect, it, vi } from 'vitest'
import { executeChatTool } from '../src/chat-tools'

it('routes all four tools and keeps original image data out of the textual tool response',async()=>{
 const access=vi.fn(async()=>({dataJson:JSON.stringify({untrustedData:true,image:{mime:'image/png',data:'aW1hZ2U='},attachment:{name:'x.png'}})}))
 const result=await executeChatTool({id:'call',name:'read_chat_attachment',arguments:JSON.stringify({conversationId:'c',messageId:'m',format:'image'})},access)
 expect(access).toHaveBeenCalledWith({action:'attachment',conversationId:'c',messageId:'m',format:'image'})
 expect(result.image).toEqual({mime:'image/png',data:'aW1hZ2U='});expect(result.content).not.toContain('aW1hZ2U=');expect(result.notice.ok).toBe(true)
 for(const [name,args,action] of [
  ['list_conversations',{},'list'],['read_chat_history',{conversationId:'c',before:12},'history'],
  ['send_chat_message',{conversationId:'c',clientMessageId:'retry-id',text:'hi'},'send'],
 ] as const){await executeChatTool({id:'call',name,arguments:JSON.stringify(args)},access);expect(access).toHaveBeenLastCalledWith({action,...args})}
})
it('returns actionable errors, rejects an action override, and never falls back to another conversation',async()=>{
 const access=vi.fn(async()=>{throw Error('会话不可用')})
 const result=await executeChatTool({id:'call',name:'send_chat_message',arguments:'{"conversationId":"c","clientMessageId":"x","text":"hello"}'},access)
 expect(result.notice).toMatchObject({ok:false,summary:'会话不可用'});expect(access).toHaveBeenCalledTimes(1)
 const bad=await executeChatTool({id:'call',name:'list_conversations',arguments:'{"action":"send"}'},access)
 expect(bad.notice.ok).toBe(false);expect(access).toHaveBeenCalledTimes(1)
 expect((await executeChatTool({id:'call',name:'list_conversations',arguments:'{}'})).notice.ok).toBe(false)
})
