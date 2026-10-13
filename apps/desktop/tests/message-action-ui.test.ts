import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage, Conversation } from '@more-than-chat/chat-core'
import { MessageActionGate, ForwardAttemptIds, forwardTargets } from '../src/renderer/src/message-actions'
import { MessageActionDialog } from '../src/renderer/src/MessageActionDialog'
import { HistoryNotice } from '../src/renderer/src/HistoryNotice'
import { MessageBubble } from '../src/renderer/src/App'

vi.mock('../src/renderer/src/theme', () => ({ useAppearance: () => ({ preference: 'light', resolved: 'light' }), setThemePreference: vi.fn() }))
vi.mock('../src/renderer/src/plugin-host', () => ({ chatNetworkService: {} }))

const conversation = (id: string, overrides: Partial<Conversation> = {}) => ({ id, title: id, kind: 'direct', serverId: 'server-a', transportId: 'builtin.central', ...overrides }) as Conversation
const message = { id: 'message-a', conversationId: 'chat-a', text: 'hello', senderId: 'user-a', senderName: 'A', senderAvatar: 'A', role: 'self', type: 'text', status: 'failed', serverId: 'server-a', createdAt: 1 } as ChatMessage

describe('message action locks and retry identity', () => {
  it('blocks same-tick duplicate clicks, then releases after completion', async () => {
    const gate = new MessageActionGate()
    let finish!: () => void
    const action = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const first = gate.run('a', action)
    expect(await gate.run('a', action)).toBe(false)
    expect(action).toHaveBeenCalledTimes(1)
    finish(); expect(await first).toBe(true)
    expect(await gate.run('a', async () => {})).toBe(true)
  })
  it('failure releases the lock and propagates the error to the UI', async () => {
    const gate = new MessageActionGate()
    await expect(gate.run('a', async () => { throw new Error('disk unavailable') })).rejects.toThrow('disk unavailable')
    expect(await gate.run('a', async () => {})).toBe(true)
  })
  it('does not unnecessarily block a different message', async () => {
    const gate = new MessageActionGate()
    let finish!: () => void
    const first = gate.run('a', () => new Promise<void>(resolve => { finish = resolve }))
    expect(await gate.run('b', async () => {})).toBe(true)
    finish(); await first
  })
  it('reuses a forward id for retries but never for a different destination', () => {
    let sequence = 0
    const ids = new ForwardAttemptIds(() => String(++sequence))
    expect(ids.forTarget('a')).toBe('1')
    expect(ids.forTarget('a')).toBe('1')
    expect(ids.forTarget('b')).toBe('2')
    expect(ids.forTarget('a')).toBe('1')
  })
  it('only offers available central conversations on the source server', () => {
    const rows = [conversation('friend'), conversation('group', { kind: 'group' }), conversation('other-server', { serverId: 'server-b' }), conversation('removed', { unavailable: true }), conversation('ai', { kind: 'assistant' }), conversation('plugin', { transportId: 'custom' })]
    expect(forwardTargets(rows, 'server-a').map(c => c.id)).toEqual(['friend', 'group'])
    expect(forwardTargets(rows, undefined)).toEqual([])
  })
})

describe('message recovery markup without a desktop window', () => {
  it('explains an empty forwarding list and keeps a close button', () => {
    const html = renderToStaticMarkup(createElement(MessageActionDialog, { kind: 'forward', message, conversations: [], onClose: vi.fn(), onComplete: vi.fn() }))
    expect(html).toContain('暂无可转发的好友或群')
    expect(html).toContain('aria-label="关闭"')
    expect(html).toContain('role="dialog"')
    expect(html).toContain('tabindex="-1"')
  })
  it('shows eligible forwarding targets and offline queue semantics', () => {
    const html = renderToStaticMarkup(createElement(MessageActionDialog, { kind: 'forward', message, conversations: [conversation('friend'), conversation('private', { serverId: 'server-b' })], onClose: vi.fn(), onComplete: vi.fn() }))
    expect(html).toContain('data-forward-target="friend"')
    expect(html).not.toContain('data-forward-target="private"')
    expect(html).toContain('离线时先保存在本机队列')
  })
  it('requires explicit retraction confirmation and explains limits', () => {
    const html = renderToStaticMarkup(createElement(MessageActionDialog, { kind: 'retract', message, conversations: [], onClose: vi.fn(), onComplete: vi.fn() }))
    expect(html).toContain('data-confirm-retract')
    expect(html).toContain('仅本人两分钟内')
    expect(html).toContain('无法保证删除')
    expect(html).not.toContain('data-forward-target')
  })
  it('shows history retry and return-to-latest actions without a disappearing toast', () => {
    const html = renderToStaticMarkup(createElement(HistoryNotice, { busy: false, error: '消息不存在', onRetry: vi.fn(), onLatest: vi.fn() }))
    expect(html).toContain('role="alert"')
    expect(html).toContain('消息不存在')
    expect(html).toContain('重新加载')
    expect(html).toContain('返回最新消息')
  })
  it('announces history loading and suppresses obsolete retry buttons', () => {
    const props = { busy: true, error: 'old error', onRetry: vi.fn(), onLatest: vi.fn() }
    const html = renderToStaticMarkup(createElement(HistoryNotice, props))
    expect(html).toContain('role="status"')
    expect(html).not.toContain('old error')
    expect(html).not.toContain('<button')
    expect(renderToStaticMarkup(createElement(HistoryNotice, { ...props, busy: false, error: '' }))).toBe('')
  })
  it('disables an in-flight retry and labels icon-only message actions', () => {
    const html = renderToStaticMarkup(createElement(MessageBubble, { message, compact: false, onCopy: vi.fn(), onRetry: undefined, onResend: vi.fn(), onQuote: vi.fn(), onForward: vi.fn(), onRetract: vi.fn(), resending: true }))
    expect(html.match(/<button[^>]*class="message-resend"[^>]*>/)?.[0]).toContain('disabled')
    expect(html).toContain('正在加入队列…')
    for (const label of ['复制消息', '引用回复', '转发消息', '撤回消息']) expect(html).toContain(`aria-label="${label}"`)
  })
})
