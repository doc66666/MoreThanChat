/** Shared by the assistant broker and trusted client plugins. Never accepts file paths. */
export type ChatAccessRequest =
  | { action: 'list'; offset?: number; limit?: number }
  | { action: 'history'; conversationId: string; before?: number; after?: number; around?: string; limit?: number }
  | { action: 'attachment'; conversationId: string; messageId: string; format: 'text' | 'base64' | 'image'; offset?: number; limit?: number }
  | { action: 'send'; conversationId: string; clientMessageId: string; text: string; attachmentMessageId?: string };
export interface ChatAccessResult { dataJson: string }
export const CHAT_ACCESS_TOOLS = ['list_conversations','read_chat_history','read_chat_attachment','send_chat_message'] as const;
export function parseChatAccessRequest(value: unknown): ChatAccessRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('聊天接口参数必须是对象');
  const v=value as Record<string,unknown>;
  const keys: Record<string,string[]>={list:['action','offset','limit'],history:['action','conversationId','before','after','around','limit'],attachment:['action','conversationId','messageId','format','offset','limit'],send:['action','conversationId','clientMessageId','text','attachmentMessageId']};
  if(typeof v.action!=='string'||!Object.hasOwn(keys,v.action)||Object.keys(v).some(k=>!keys[v.action as string]!.includes(k)))throw Error('聊天接口参数无效');
  const str=(k:string,max=256)=>{if(typeof v[k]!=='string'||!(v[k] as string).trim()||(v[k] as string).length>max)throw Error('无效参数：'+k)};
  if(v.action!=='list')str('conversationId');
  for(const k of ['offset','before','after','limit'])if(v[k]!==undefined&&(!Number.isSafeInteger(v[k])||Number(v[k])<(k==='limit'?1:k==='after'?-1:0)||Number(v[k])>Number.MAX_SAFE_INTEGER))throw Error('无效分页参数');
  if(v.limit!==undefined&&Number(v.limit)>(v.action==='attachment'?65536:100))throw Error('分页过大');
  if(v.action==='history'){
    if(v.around!==undefined)str('around');
    if(['before','after','around'].filter(k=>v[k]!==undefined).length>1)throw Error('历史游标不能混用');
  }
  if(v.action==='attachment'){str('messageId');if(typeof v.format!=='string'||!['text','base64','image'].includes(v.format))throw Error('附件格式无效');if(v.format==='image'&&(v.offset!==undefined||v.limit!==undefined))throw Error('图片输入不使用分块游标');}
  if(v.action==='send'){str('clientMessageId',80);if(typeof v.text!=='string'||v.text.length>100000)throw Error('消息文本无效');if(v.attachmentMessageId!==undefined)str('attachmentMessageId');if(!v.text.trim()&&!v.attachmentMessageId)throw Error('消息不能为空');}
  return v as ChatAccessRequest;
}
export function parseChatAccessResult(value: unknown): ChatAccessResult {
  const v=value as ChatAccessResult;
  if(!v||typeof v!=='object'||Object.keys(v).length!==1||typeof v.dataJson!=='string'||v.dataJson.length>8*1024*1024)throw Error('聊天接口结果无效');
  JSON.parse(v.dataJson);
  return v;
}
