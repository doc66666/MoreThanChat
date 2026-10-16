import { afterEach, expect, it, vi } from 'vitest'
import { createHostErrorResponse, createHostRequest, createHostSuccessResponse, type HostRequest } from '@more-than-chat/protocol'
import { HostCredentialClient } from '../src/credential-client'
import { executeChatTool } from '../src/chat-tools'

afterEach(()=>vi.useRealTimers())

it('matches concurrent chat requests by request ID and preserves service errors',async()=>{
  const sent:HostRequest[]=[],client=new HostCredentialClient(message=>sent.push(message as HostRequest))
  const read=client.accessChat({action:'history',conversationId:'friend'}),send=client.accessChat({action:'send',conversationId:'group',clientMessageId:'send-once',text:'hello'})
  const failure=expect(read).rejects.toThrow('找不到好友或群聊会话')
  client.accept(createHostSuccessResponse(sent[1]!,{dataJson:'{"queued":true}'}))
  client.accept(createHostErrorResponse(sent[0]!,{code:'INVALID_PAYLOAD',message:'找不到好友或群聊会话',retryable:false}))
  expect(await send).toEqual({dataJson:'{"queued":true}'});await failure
  expect(client.accept(createHostSuccessResponse(sent[1]!,{dataJson:'{}'}))).toBe(false)
})

it('does not consume a response for another method or describe chat transport failure as a credential issue',async()=>{
  let request!:HostRequest
  const client=new HostCredentialClient(message=>{request=message as HostRequest})
  const pending=client.accessChat({action:'list'}),failure=expect(pending).rejects.toThrow('聊天服务响应不匹配')
  client.accept(createHostSuccessResponse(createHostRequest('credentials.read',request.requestId,{}),{apiKey:null}))
  await failure
  const unavailable=new HostCredentialClient(()=>{throw Error('Port closed')})
  await expect(unavailable.accessChat({action:'list'})).rejects.toThrow('聊天服务连接中断')
})

it('returns the exact send identity on timeout and retries that identity after ignoring a late acknowledgement',async()=>{
  vi.useFakeTimers()
  const sent:HostRequest[]=[],client=new HostCredentialClient(message=>sent.push(message as HostRequest))
  const call={id:'first-call',name:'send_chat_message',arguments:JSON.stringify({conversationId:'group',clientMessageId:'stable-send-id',text:'指定的消息'})}
  const pending=executeChatTool(call,request=>client.accessChat(request))
  await vi.advanceTimersByTimeAsync(15001)
  const failed=await pending
  expect(failed.notice.ok).toBe(false)
  expect(JSON.parse(failed.content)).toMatchObject({ok:false,conversationId:'group',clientMessageId:'stable-send-id',error:'本机服务请求超时。'})
  expect(JSON.parse(failed.content).hint).toContain('超时不代表消息没有进入发送队列')
  expect(client.accept(createHostSuccessResponse(sent[0]!,{dataJson:'{"queued":true}'}))).toBe(false)
  const retry=executeChatTool({...call,id:'retry-call'},request=>client.accessChat(request))
  expect(sent[1]!.payload).toEqual(sent[0]!.payload)
  client.accept(createHostSuccessResponse(sent[1]!,{dataJson:'{"queued":true,"eventId":"stable-send-id"}'}))
  expect((await retry).notice).toMatchObject({ok:true,summary:'消息已加入发送队列，等待送达。'})
  expect(vi.getTimerCount()).toBe(0)
})
