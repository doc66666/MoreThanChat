import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Mic, Paperclip, Plus, SendHorizontal } from 'lucide-react'
import type { AttachmentRef } from '@more-than-chat/central-protocol'
import { VoiceCapture, type VoicePhase } from './voice-capture'
import { insertAtSelection, shouldSendOnEnter } from './composer-input'
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
  reference,
}: {
  draft: string
  setDraft: (value: string) => void
  onSend: () => void | Promise<void>
  onVoice: (ref: AttachmentRef) => void | Promise<void>
  onError: (message: string) => void
  canAttach: boolean
  generating: boolean
  onCancel: () => void
  title: string
  attachment: AttachmentRef | null
  onAttachment: (ref: AttachmentRef) => void
  clearAttachment: () => void
  children: React.ReactNode
  reference?:React.ReactNode
}) {
  const [menu, setMenu] = useState(false)
  const [voicePhase, setVoicePhase] = useState<VoicePhase>('idle')
  const [seconds, setSeconds] = useState(0)
  const [preparingFile, setPreparingFile] = useState(false)
  const [sending, setSending] = useState(false)
  const [problem, setProblem] = useState('')
  const mounted = useRef(true)
  const operation = useRef(false)
  const callbacks = useRef({ onVoice, onError })
  callbacks.current = { onVoice, onError }
  const voice = useRef<VoiceCapture | null>(null)
  const recording = voicePhase === 'recording'
  const locked = preparingFile || sending || voicePhase !== 'idle'
  function report(message: string) { if (mounted.current) { setProblem(message); callbacks.current.onError(message) } }
  if (!voice.current) voice.current = new VoiceCapture({
    getStream: () => navigator.mediaDevices.getUserMedia({ audio: true }),
    createRecorder: stream => new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm' }),
    onPhase: phase => { if (mounted.current) setVoicePhase(phase) },
    onError: report,
    prepare: async (blob, durationMs) => {
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let binary = ''
      for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768))
      const ref = await window.moreThanChat.recordVoice({ data: btoa(binary), mime: 'audio/webm', durationMs })
      return () => callbacks.current.onVoice(ref)
    },
  })
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
  const begin = () => {
    if (!canAttach || generating || operation.current || attachment) return
    setProblem('')
    void voice.current!.begin()
  }
  useEffect(() => {
    mounted.current = true
    const cancel = () => voice.current?.cancel()
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') cancel() }
    const hidden = () => { if (document.hidden) cancel() }
    window.addEventListener('blur', cancel)
    document.addEventListener('visibilitychange', hidden)
    document.addEventListener('keydown', escape)
    return () => {
      mounted.current = false; cancel()
      window.removeEventListener('blur', cancel)
      document.removeEventListener('visibilitychange', hidden)
      document.removeEventListener('keydown', escape)
    }
  }, [])
  useEffect(() => {
    if (!recording) return
    setSeconds(0)
    const start = Date.now()
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [recording])
  async function send() {
    if (operation.current || locked || generating || (!draft.trim() && !attachment)) return
    operation.current = true; setSending(true); setProblem('')
    try { await onSend() }
    catch (error) { report(error instanceof Error ? error.message : '消息发送失败，请重试。') }
    finally { operation.current = false; if (mounted.current) { setSending(false); inputRef.current?.focus() } }
  }
  async function chooseFile() {
    if (operation.current || locked) return
    operation.current = true; setPreparingFile(true); setProblem(''); setMenu(false)
    try {
      const ref = await window.moreThanChat.chooseAttachment()
      if (mounted.current && ref) onAttachment(ref)
    } catch (error) { report(error instanceof Error ? error.message : '附件准备失败，请重试。') }
    finally { operation.current = false; if (mounted.current) { setPreparingFile(false); inputRef.current?.focus() } }
  }
  return (
    <div className="composer">
      {reference}
      <div className="normal-composer-row">
        <div className="composer-plus-wrap" ref={menuRef}>
          <button
            type="button"
            className="composer-plus"
            title="附件与表情"
            aria-label="附件与表情"
            disabled={locked}
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
                onClick={() => void chooseFile()}
              >
                <Paperclip size={16} /> 文件或图片 <small>5 MiB</small>
              </button>
              {!canAttach && <p className="composer-menu-note">文件和语音仅用于好友或群聊。</p>}
              <div className="composer-emoji-grid">
                {['🙂', '😂', '👍', '❤️', '🎉', '😮'].map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    aria-label={`插入表情 ${emoji}`}
                    onClick={() => {
                      const input = inputRef.current
                      const result = insertAtSelection(draft, emoji, input?.selectionStart ?? draft.length, input?.selectionEnd ?? draft.length)
                      setDraft(result.text)
                      setMenu(false)
                      requestAnimationFrame(() => { if (mounted.current) { input?.focus(); input?.setSelectionRange(result.cursor, result.cursor) } })
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
          maxLength={100000}
          aria-label={`发消息给 ${title}`}
          value={draft}
          readOnly={sending}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (shouldSendOnEnter({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing, keyCode: e.nativeEvent.keyCode })) {
              e.preventDefault()
              void send()
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
                aria-label={sending ? '正在发送' : '发送文字或文件'}
                disabled={locked}
                onClick={() => void send()}
              >
                <SendHorizontal size={19} />
              </button>
            )}
            <button
              type="button"
              className={`voice-button ${recording ? 'recording' : ''}`}
              disabled={!canAttach || preparingFile || sending || voicePhase === 'preparing' || !!attachment}
              aria-label="按住说话，松开发送；可按住空格录音，Esc 取消"
              title={attachment ? '请先发送或移除当前附件' : !canAttach ? '语音仅用于好友或群聊' : '按住说话，松开发送；空格录音，Esc 取消'}
              onPointerDown={(event) => {
                if (event.button !== 0) return
                event.currentTarget.setPointerCapture(event.pointerId)
                begin()
              }}
              onPointerUp={() => voice.current?.finish()}
              onPointerCancel={() => voice.current?.cancel()}
              onKeyDown={(e) => {
                if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (!e.repeat) begin() }
              }}
              onKeyUp={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); voice.current?.finish() } }}
              onBlur={() => { if (voicePhase === 'requesting' || voicePhase === 'recording') voice.current?.cancel() }}
            >
              <Mic size={18} />
              <span>{recording ? '松开发送' : voicePhase === 'requesting' ? '等待麦克风' : voicePhase === 'preparing' ? '正在准备' : '按住说话'}</span>
            </button>
          </>
        )}
      </div>
      {(preparingFile || sending || voicePhase !== 'idle') && <div className="composer-progress" role="status">
        <span>{preparingFile ? '正在选择或准备附件…' : sending ? '正在加入发送队列…' : recording ? `正在录音 ${seconds}s / 59s · 松开发送，Esc 取消` : voicePhase === 'requesting' ? '等待麦克风权限，请保持按住；松开取消。' : '正在准备语音…'}</span>
        {(voicePhase === 'requesting' || recording) && <button type="button" onClick={() => voice.current?.cancel()}>取消录音</button>}
      </div>}
      {problem && <div className="composer-problem" role="alert"><span>{problem}</span><button type="button" aria-label="关闭输入提示" onClick={() => setProblem('')}>关闭</button></div>}
      {attachment && (
        <div className="attachment-pending">
          <Paperclip size={15} /><span title={attachment.name}>{attachment.name}</span><small>{(attachment.size / 1024).toFixed(1)} KiB</small>
          <button disabled={locked} onClick={clearAttachment} aria-label={`移除附件 ${attachment.name}`}>移除</button>
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
