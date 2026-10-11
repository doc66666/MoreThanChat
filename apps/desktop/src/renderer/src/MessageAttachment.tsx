import { useEffect, useState } from 'react'
import type { AttachmentRef } from '@more-than-chat/central-protocol'
export function MessageAttachment({
  attachment,
}: {
  attachment: AttachmentRef
}) {
  const [url, setUrl] = useState<string | null>(null),
    [error, setError] = useState(false)
  const preview = /^(image\/(png|jpeg|gif|webp)|audio\/(webm|ogg|mp4))$/.test(
    attachment.mime,
  )
  useEffect(() => {
    if (!preview) return
    let active = true,
      objectUrl: string | undefined
    void window.moreThanChat
      .readAttachment(attachment.id)
      .then((wire) => {
        if (!active) return
        const binary = atob(wire.data),
          bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
        objectUrl = URL.createObjectURL(
          new Blob([bytes], { type: attachment.mime }),
        )
        setUrl(objectUrl)
      })
      .catch(() => setError(true))
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [attachment.id, preview])
  return (
    <div className="message-attachment" data-attachment-id={attachment.id}>
      {url && attachment.mime.startsWith('audio/') ? (
        <audio controls src={url} />
      ) : url ? (
        <img src={url} alt={attachment.name} />
      ) : null}
      <button
        onClick={() =>
          void window.moreThanChat
            .saveAttachment(attachment.id)
            .catch(() => setError(true))
        }
      >
        {attachment.name}
        {attachment.durationMs === undefined
          ? ''
          : ` · ${(attachment.durationMs / 1000).toFixed(1)} 秒`}{' '}
        · {(attachment.size / 1024).toFixed(1)} KiB
      </button>
      {error && <small>附件加载或保存失败</small>}
    </div>
  )
}
