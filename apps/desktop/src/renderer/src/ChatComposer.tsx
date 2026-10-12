import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Mic, Paperclip, Plus, SendHorizontal } from 'lucide-react'
import type { AttachmentRef } from '@more-than-chat/central-protocol'
export function ChatComposer({
  draft,
  setDraft,
  onSend,
  onVoice,
  onError,
  canAttach,
  generating,
  onCancel,
  title,
  attachment,
  onAttachment,
  clearAttachment,
  children,
}: {
  draft: string
  setDraft: (value: string) => void
  onSend: () => void
  onVoice: (ref: AttachmentRef) => void
  onError: (message: string) => void
  canAttach: boolean
  generating: boolean
  onCancel: () => void
  title: string
  attachment: AttachmentRef | null
  onAttachment: (ref: AttachmentRef) => void
  clearAttachment: () => void
  children: React.ReactNode
}) {
  const [menu, setMenu] = useState(false),
    [recording, setRecording] = useState(false)
  const held = useRef(false),
    recorder = useRef<MediaRecorder | null>(null),
    cancelled = useRef(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.style.height = 'auto'
    input.style.height = Math.min(input.scrollHeight, 140) + 'px'
  }, [draft])
  useEffect(() => {
    if (!menu) return
    const outside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(false)
    }
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setMenu(false)
      menuRef.current?.querySelector('button')?.focus()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [menu])
  const begin = async () => {
    if (!canAttach || generating) return
    held.current = true
    cancelled.current = false
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (!held.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm'
      const value = new MediaRecorder(stream, { mimeType: mime }),
        chunks: BlobPart[] = [],
        started = Date.now()
      value.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data)
      }
      const timer = window.setTimeout(() => {
        held.current = false
        if (value.state !== 'inactive') value.stop()
      }, 59000)
      value.onstop = () => {
        window.clearTimeout(timer)
        stream.getTracks().forEach((track) => track.stop())
        setRecording(false)
        recorder.current = null
        if (cancelled.current) return
        void new Blob(chunks, { type: mime })
          .arrayBuffer()
          .then(async (buffer) => {
            const bytes = new Uint8Array(buffer)
            let binary = ''
            for (let i = 0; i < bytes.length; i += 32768)
              binary += String.fromCharCode(...bytes.subarray(i, i + 32768))
            const durationMs = Math.min(60000, Date.now() - started)
            if (durationMs < 300) throw new Error('录音太短，请按住说话')
            onVoice(
              await window.moreThanChat.recordVoice({
                data: btoa(binary),
                mime: 'audio/webm',
                durationMs,
              }),
            )
          })
          .catch((e) =>
            onError(e instanceof Error ? e.message : '录音发送失败'),
          )
      }
      recorder.current = value
      value.start()
      setRecording(true)
    } catch (e) {
      held.current = false
      onError(e instanceof Error ? e.message : '无法使用麦克风')
    }
  }
  const stop = (cancel = false) => {
    held.current = false
    if (cancel) cancelled.current = true
    if (recorder.current && recorder.current.state !== 'inactive')
      recorder.current.stop()
  }
  return (
    <div className="composer">
      <div className="normal-composer-row">
        <div className="composer-plus-wrap" ref={menuRef}>
          <button
            type="button"
            className="composer-plus"
            title="附件与表情"
            aria-expanded={menu}
            aria-controls="composer-attachments-menu"
            onClick={() => setMenu((value) => !value)}
          >
            <Plus size={22} />
          </button>
          {menu && (
            <div className="composer-menu" id="composer-attachments-menu" aria-label="附件与表情">
              <button
                type="button"
                className="composer-file-action"
                disabled={!canAttach}
                onClick={() => {
                  setMenu(false)
                  void window.moreThanChat
                    .chooseAttachment()
                    .then((ref) => {
                      if (ref) onAttachment(ref)
                    })
                    .catch((e) => onError(e.message))
                }}
              >
                <Paperclip size={16} /> 文件或图片 <small>5 MiB</small>
              </button>
              <div className="composer-emoji-grid">
                {['🙂', '😂', '👍', '❤️', '🎉', '😮'].map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    aria-label={`插入表情 ${emoji}`}
                    onClick={() => {
                      setDraft(draft + emoji)
                      setMenu(false)
                      inputRef.current?.focus()
                    }}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <textarea
          ref={inputRef}
          aria-label={`发消息给 ${title}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              onSend()
            }
          }}
          placeholder={`发消息给 ${title}`}
          rows={1}
        />
        {generating ? (
          <button className="send-button stop" onClick={onCancel}>
            停止
          </button>
        ) : (
          <>
            {(draft.trim() || attachment) && (
              <button
                className="send-button"
                title="发送文字或文件"
                onClick={onSend}
              >
                <SendHorizontal size={19} />
              </button>
            )}
            <button
              type="button"
              className={`voice-button ${recording ? 'recording' : ''}`}
              disabled={!canAttach}
              title="按住说话，松开发送；Esc 取消"
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId)
                void begin()
              }}
              onPointerUp={() => stop()}
              onPointerCancel={() => stop(true)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') stop(true)
              }}
            >
              <Mic size={18} />
              <span>{recording ? '松开发送' : '按住说话'}</span>
            </button>
          </>
        )}
      </div>
      {attachment && (
        <div className="attachment-pending">
          {attachment.name} · {(attachment.size / 1024).toFixed(1)} KiB{' '}
          <button onClick={clearAttachment}>移除</button>
        </div>
      )}
      <div className="composer-toolbar">
        <div className="composer-plugin-actions">{children}</div>
        <div className="send-area">
          <span>Enter 发送 · Shift+Enter 换行</span>
          {!generating && !draft.trim() && !attachment && (
            <button className="send-button" disabled aria-label="发送">
              <SendHorizontal size={18} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
