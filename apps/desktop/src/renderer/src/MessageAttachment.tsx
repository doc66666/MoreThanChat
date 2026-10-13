import { useEffect, useRef, useState } from 'react'
import { Download, Paperclip } from 'lucide-react'
import type { AttachmentRef } from '@more-than-chat/central-protocol'
import { AttachmentPreview, type PreviewState } from './attachment-preview'
export function MessageAttachment({
  attachment,
}: {
  attachment: AttachmentRef
}) {
  return <AttachmentContent key={`${attachment.id}:${attachment.mime}`} attachment={attachment}/>
}

function AttachmentContent({attachment}:{attachment:AttachmentRef}) {
  const [state,setState]=useState<PreviewState>({status:'loading',url:null})
  const [saving,setSaving]=useState(false),[saveError,setSaveError]=useState(''),[saved,setSaved]=useState(false)
  const mounted=useRef(true),inFlight=useRef(false)
  const loader=useRef<AttachmentPreview|null>(null)
  if(!loader.current)loader.current=new AttachmentPreview({
    read:id=>window.moreThanChat.readAttachment(id),
    create:(data,mime)=>{
      const bytes=Uint8Array.from(atob(data),c=>c.charCodeAt(0))
      return URL.createObjectURL(new Blob([bytes],{type:mime}))
    },
    revoke:url=>URL.revokeObjectURL(url),publish:setState,
  })
  const preview = /^(image\/(png|jpeg|gif|webp)|audio\/(webm|ogg|mp4))$/.test(
    attachment.mime,
  )
  useEffect(() => {
    mounted.current=true
    if(preview)void loader.current!.load(attachment.id,attachment.mime)
    return () => {
      mounted.current=false
      loader.current!.dispose()
    }
  }, [attachment.id, attachment.mime, preview])
  async function save() {
    if(inFlight.current)return
    inFlight.current=true;setSaving(true);setSaveError('');setSaved(false)
    try {
      const result=await window.moreThanChat.saveAttachment(attachment.id)
      if(mounted.current)setSaved(result==='saved')
    }catch(error){if(mounted.current)setSaveError(error instanceof Error?error.message:'无法保存附件，请重试。')}
    finally{inFlight.current=false;if(mounted.current)setSaving(false)}
  }
  const url=state.url
  return (
    <div className="message-attachment" data-attachment-id={attachment.id}>
      {url && attachment.mime.startsWith('audio/') ? (
        <audio controls preload="metadata" src={url} aria-label={attachment.name} onError={()=>loader.current!.mediaError(url)} />
      ) : url ? (
        <img src={url} alt={attachment.name} loading="lazy" onError={()=>loader.current!.mediaError(url)} />
      ) : null}
      {preview&&state.status==='loading'&&<small role="status">正在加载预览…</small>}
      {preview&&state.status==='error'&&<div className="attachment-error"><small role="alert">无法预览附件。可以重试，或另存为后查看。</small><button onClick={()=>void loader.current!.load(attachment.id,attachment.mime)}>重试预览</button></div>}
      <div className="attachment-metadata"><Paperclip size={14}/><span title={attachment.name}>{attachment.name}</span></div>
      <small className="attachment-size">
        {attachment.durationMs === undefined
          ? ''
          : `${(attachment.durationMs / 1000).toFixed(1)} 秒 · `}
        {(attachment.size / 1024).toFixed(1)} KiB
      </small>
      <button disabled={saving} aria-label={`另存为 ${attachment.name}`} onClick={()=>void save()}>
        <Download size={14}/>{saving?'正在保存…':'另存为'}
      </button>
      {saved&&<small role="status">已保存到所选位置</small>}
      {saveError&&<small className="attachment-save-error" role="alert">保存失败：{saveError}。可再次点击「另存为」重试。</small>}
    </div>
  )
}
