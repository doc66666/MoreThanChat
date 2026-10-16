import { expect, it } from 'vitest'
import { createHostRequest, createHostSuccessResponse, parseHostMessage, parseChatAccessRequest, parseChatAccessResult } from '../src'
it('round trips the chat bridge without exposing filesystem or credentials',()=>{
 const request=createHostRequest('chat.access','chat-test',{action:'history',conversationId:'c',before:2,limit:5})
 expect(parseHostMessage(request)).toEqual(request)
 const response=createHostSuccessResponse(request,{dataJson:'{"messages":[]}'})
 expect(parseHostMessage(response)).toEqual(response)
 expect(parseHostMessage(createHostRequest('chat.access','from-start',{action:'history',conversationId:'c',after:-1}))).toBeDefined()
 for(const value of [
  {action:'list',path:'secret'}, {action:'history',conversationId:'c',before:1,around:'m'},
  {action:'history',conversationId:'c',limit:101},{action:'attachment',conversationId:'c',messageId:'m',format:'image',offset:0},
  {action:'history',conversationId:'c',after:-2},{action:'history',conversationId:'c',before:-1},{action:'list',offset:-1},
  {action:'send',conversationId:'c',clientMessageId:'x',text:' '},
 ])expect(()=>parseChatAccessRequest(value)).toThrow()
 expect(()=>parseChatAccessResult({dataJson:'not-json'})).toThrow()
})
it('rejects non-string attachment formats instead of coercing them into a different read mode',()=>{
 for(const format of [['text'],['image'],['base64'],{toString:()=> 'text'},null,1]){
  expect(()=>parseChatAccessRequest({action:'attachment',conversationId:'c',messageId:'m',format})).toThrow('附件格式无效')
 }
 for(const action of ['constructor','toString','__proto__'])expect(()=>parseChatAccessRequest({action})).toThrow('聊天接口参数无效')
})
