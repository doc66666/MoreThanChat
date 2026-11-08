import type {ReactNode} from 'react'
import type {ChatMessage} from '@more-than-chat/chat-core'
import {MessageMarkdown} from './MessageMarkdown'
import {MessageAttachment} from './MessageAttachment'

export type MessageViewContext={message:ChatMessage;text?:string}
export type MessageSurfaceRenderer=(name:string,context?:unknown,fallback?:unknown)=>ReactNode
/** Timeline-owned location survives a user replacing the complete message view. */
export function MessageFrame({message,children,highlighted=false}:{message:ChatMessage;children:ReactNode;highlighted?:boolean|undefined}){
  return <div className={`message-entry${highlighted?' message-highlight':''}`} data-message-id={message.id} data-retracted-message={message.retractedAt?true:undefined}>{children}</div>
}
export function displayText(message:ChatMessage):string {
  if(message.text)return message.text
  if(message.status==='streaming')return '正在生成…'
  if(message.status==='cancelled')return '回复已取消。'
  if(message.status==='failed')return message.role==='self'?'消息发送失败。':'回复没有完成。'
  return ''
}
export function MessageBodyFallback({message}:MessageViewContext){
  return <div data-message-fallback><p>{displayText(message)}</p>{message.content&&<small className="message-format-note">{message.content.format} · v{message.content.version} · 当前显示文字摘要，可启用对应渲染插件</small>}</div>
}
export function MessageBodyView({context,renderSurface}:{context:MessageViewContext;renderSurface:MessageSurfaceRenderer}){
  const {message}=context,format=message.content?.format??'markdown'
  return renderSurface('message.body.'+format,{...context,text:message.content?.body??displayText(message)},<MessageBodyFallback message={message}/>)
}
export function MarkdownMessageView({context}:{context:MessageViewContext}){
  return context.message.content&&context.message.content.version!==1?<MessageBodyFallback message={context.message}/>:<MessageMarkdown text={context.text??displayText(context.message)}/>
}
export function PlainMessageView({context}:{context:MessageViewContext}){
  return context.message.content&&context.message.content.version!==1?<MessageBodyFallback message={context.message}/>:<p>{context.text??displayText(context.message)}</p>
}
export function AttachmentMessageView({context}:{context:MessageViewContext}){
  return context.message.attachment?<MessageAttachment attachment={context.message.attachment}/>:null
}
export function AttachmentMessageFallback({message}:MessageViewContext){
  return message.attachment?<p data-attachment-fallback>附件：{message.attachment.name}<small className="message-format-note">可启用附件渲染插件查看</small></p>:null
}
