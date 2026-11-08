/** Portable message data. Renderers are installed plugins, never code embedded in a message. */
export interface MessageContent { format: string; version: number; body: string }
export const MESSAGE_CONTENT_SCHEMA={type:'object',additionalProperties:false,required:['format','version','body'],properties:{format:{type:'string',maxLength:80,pattern:'^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$'},version:{type:'integer',minimum:1,maximum:2147483647},body:{type:'string',minLength:1,maxLength:100000,pattern:'.*\\S.*'}}} as const
export function parseMessageContent(value: unknown): MessageContent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效消息正文')
  const v=value as Record<string,unknown>
  if(Object.keys(v).some(k=>!['format','version','body'].includes(k)) ||
    typeof v.format!=='string'||v.format.length>80||!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(v.format)||
    !Number.isSafeInteger(v.version)||Number(v.version)<1||Number(v.version)>2147483647||
    typeof v.body!=='string'||!v.body.trim()||v.body.length>100000) throw new Error('消息格式、版本或正文无效')
  return {format:v.format,version:Number(v.version),body:v.body}
}
