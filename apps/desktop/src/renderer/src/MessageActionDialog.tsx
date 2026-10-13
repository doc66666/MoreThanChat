import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { ChatMessage, Conversation } from '@more-than-chat/chat-core'
import { useDialogFocus } from './use-dialog-focus'
import { ForwardAttemptIds, MessageActionGate, forwardTargets } from './message-actions'

export function MessageActionDialog({ kind, message, conversations, onClose, onComplete }: {
  kind: 'forward' | 'retract'
  message: ChatMessage
  conversations: Conversation[]
  onClose: () => void
  onComplete: (notice: string) => void
}) {
  const focus = useDialogFocus()
  const gate = useRef(new MessageActionGate())
  const ids = useRef(new ForwardAttemptIds(() => crypto.randomUUID()))
  const running = useRef(false)
  const live = useRef(false)
  const [busyTarget, setBusyTarget] = useState<string | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const busy = busyTarget !== null
  const close = () => { if (!running.current) onClose() }
  async function submit(target: string) {
    await gate.current.run('dialog', async () => {
      running.current = true; setBusyTarget(target); setError('')
      // Disabled buttons can lose focus; keep Escape/Tab inside the dialog.
      focus.current?.focus()
      try {
        if (kind === 'forward') await window.moreThanChat.forwardChatMessage({ messageId: message.id, conversationId: target, clientMessageId: ids.current.forTarget(target) })
        else await window.moreThanChat.retractChatMessage(message.id)
        if (live.current) onComplete(kind === 'forward' ? '转发已加入发送队列' : '消息已撤回')
      } catch (cause) {
        if (live.current) setError(cause instanceof Error ? cause.message : '操作失败，请重试')
      } finally {
        running.current = false
        if (live.current) setBusyTarget(null)
      }
    })
  }
  const targets = forwardTargets(conversations, message.serverId)
  return <div className="modal-backdrop" onMouseDown={close}>
    <section ref={focus} tabIndex={-1} className="new-chat-modal message-action-modal" data-forward-dialog={kind === 'forward' ? '' : undefined} data-retract-dialog={kind === 'retract' ? '' : undefined}
      role="dialog" aria-modal="true" aria-label={kind === 'forward' ? '转发消息' : '确认撤回'} aria-busy={busy}
      onMouseDown={e => e.stopPropagation()} onKeyDown={e => { if (e.key === 'Escape' && !e.nativeEvent.isComposing) { e.preventDefault(); e.stopPropagation(); close() } }}>
      <div className="drawer-header"><h2>{kind === 'forward' ? '转发消息' : '撤回这条消息？'}</h2><button className="icon-button" disabled={busy} onClick={close} aria-label="关闭" data-dialog-initial-focus><X size={18}/></button></div>
      <p className="settings-note">{kind === 'forward' ? '作为独立新消息发送，只能选择同一中心服务器的好友或群。离线时先保存在本机队列，重连后发送。' : '仅本人两分钟内的消息可以撤回。离线成员上线后会收到撤回通知；已经转发、下载或复制的内容无法保证删除。'}</p>
      {error && <p className="settings-error" role="alert">{error}</p>}
      {kind === 'forward' ? <>
        <p className="forward-preview">{message.text.slice(0, 160) || message.attachment?.name}</p>
        {targets.length === 0 && <p className="settings-note" role="status">暂无可转发的好友或群，请先在此消息所属服务器添加好友或加入群聊。</p>}
        <div className="forward-targets">{targets.map(c => <button className="secondary-button" key={c.id} data-forward-target={c.id} disabled={busy} onClick={() => void submit(c.id)}><span>{c.title}</span><small>{busyTarget === c.id ? '正在加入队列…' : c.kind === 'group' ? '群聊' : '好友'}</small></button>)}</div>
      </> : <div className="modal-actions"><button className="secondary-button" disabled={busy} onClick={close}>取消</button><button className="primary-button" data-confirm-retract disabled={busy} onClick={() => void submit(message.id)}>{busy ? '正在撤回…' : '确认撤回'}</button></div>}
    </section>
  </div>
}
