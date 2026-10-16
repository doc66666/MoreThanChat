import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { insertAtSelection, shouldSendOnEnter } from '../src/renderer/src/composer-input'
import { consumeDraft } from '../src/renderer/src/chat-drafts'
import { microphoneError, VoiceCapture } from '../src/renderer/src/voice-capture'
import type { AttachmentRef } from '@more-than-chat/central-protocol'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
function fixture() {
  const track = { stop: vi.fn() }
  const stream = { getTracks: () => [track] } as unknown as MediaStream
  const recording = {
    state: 'inactive', mimeType: 'audio/webm',
    ondataavailable: null as null | ((e: { data: Blob }) => void),
    onstop: null as null | (() => void), onerror: null as null | (() => void),
    start: vi.fn(() => { recording.state = 'recording' }),
    stop: vi.fn(() => {
      recording.state = 'inactive'
      recording.ondataavailable?.({ data: new Blob(['voice']) })
      recording.onstop?.()
    }),
  }
  const deliver = vi.fn()
  const options = {
    getStream: vi.fn(async () => stream),
    createRecorder: vi.fn(() => recording as unknown as MediaRecorder),
    onPhase: vi.fn(), onError: vi.fn(), prepare: vi.fn(async () => deliver),
  }
  return { track, stream, recording, deliver, options, capture: new VoiceCapture(options) }
}

describe('voice capture lifecycle without desktop or microphone access', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0) })
  afterEach(() => { vi.useRealTimers() })
  it('releases devices and freezes duration at pointer release, not after encoding', async () => {
    const f = fixture(), prepared = deferred<() => void>()
    f.options.prepare.mockImplementation(() => prepared.promise)
    await f.capture.begin(); vi.advanceTimersByTime(850); f.capture.finish()
    expect(f.track.stop).toHaveBeenCalledTimes(1)
    expect(f.options.prepare).toHaveBeenCalledWith(expect.any(Blob), 850)
    vi.advanceTimersByTime(10000); prepared.resolve(f.deliver); await flush()
    expect(f.deliver).toHaveBeenCalledTimes(1)
    expect(f.options.onPhase).toHaveBeenLastCalledWith('idle')
  })
  it('ignores permission arriving after release and stops the late stream', async () => {
    const f = fixture(), permission = deferred<MediaStream>()
    f.options.getStream.mockImplementation(() => permission.promise)
    const pending = f.capture.begin(); f.capture.finish()
    permission.resolve(f.stream); await pending
    expect(f.track.stop).toHaveBeenCalledOnce()
    expect(f.options.createRecorder).not.toHaveBeenCalled()
    expect(f.deliver).not.toHaveBeenCalled()
  })
  it('deduplicates presses while waiting for permission', async () => {
    const f = fixture(), permission = deferred<MediaStream>()
    f.options.getStream.mockImplementation(() => permission.promise)
    const pending = f.capture.begin(); await f.capture.begin()
    expect(f.options.getStream).toHaveBeenCalledOnce()
    f.capture.cancel(); permission.resolve(f.stream); await pending
  })
  it('does not send or show a failure when cancelled during recording', async () => {
    const f = fixture(); await f.capture.begin(); vi.advanceTimersByTime(1500); f.capture.cancel(); await flush()
    expect(f.track.stop).toHaveBeenCalledOnce()
    expect(f.options.prepare).not.toHaveBeenCalled()
    expect(f.options.onError).not.toHaveBeenCalled()
  })
  it('does not deliver a prepared recording after switching conversations', async () => {
    const f = fixture(), prepared = deferred<() => void>()
    f.options.prepare.mockImplementation(() => prepared.promise)
    await f.capture.begin(); vi.advanceTimersByTime(500); f.capture.finish(); f.capture.cancel()
    prepared.resolve(f.deliver); await flush()
    expect(f.deliver).not.toHaveBeenCalled()
  })
  it('rejects too-short recordings and remains usable', async () => {
    const f = fixture(); await f.capture.begin(); vi.advanceTimersByTime(100); f.capture.finish(); await flush()
    expect(f.options.onError).toHaveBeenCalledWith(expect.stringContaining('录音太短'))
    expect(f.options.prepare).not.toHaveBeenCalled()
    await f.capture.begin(); vi.advanceTimersByTime(600); f.capture.finish(); await flush()
    expect(f.deliver).toHaveBeenCalledOnce()
  })
  it('automatically finishes at the time limit exactly once', async () => {
    const f = fixture(); await f.capture.begin(); vi.advanceTimersByTime(59000); f.capture.finish(); await flush()
    expect(f.options.prepare).toHaveBeenCalledWith(expect.any(Blob), 59000)
    expect(f.recording.stop).toHaveBeenCalledOnce()
    expect(f.deliver).toHaveBeenCalledOnce()
  })
  it('releases streams when recorder initialization fails', async () => {
    const f = fixture(); f.options.createRecorder.mockImplementation(() => { throw new Error('unsupported') })
    await f.capture.begin()
    expect(f.track.stop).toHaveBeenCalledOnce()
    expect(f.options.onError).toHaveBeenCalledWith('unsupported')
    expect(f.options.onPhase).toHaveBeenLastCalledWith('idle')
  })
  it('handles hardware recording errors without delivering partial data', async () => {
    const f = fixture(); await f.capture.begin(); f.recording.onerror?.(); await flush()
    expect(f.track.stop).toHaveBeenCalledOnce()
    expect(f.options.onError).toHaveBeenCalledWith(expect.stringContaining('录音中断'))
    expect(f.deliver).not.toHaveBeenCalled()
  })
  it('reports preparation failures and allows retry', async () => {
    const f = fixture(); f.options.prepare.mockRejectedValueOnce(new Error('disk full'))
    await f.capture.begin(); vi.advanceTimersByTime(600); f.capture.finish(); await flush()
    expect(f.options.onError).toHaveBeenCalledWith('disk full')
    expect(f.options.onPhase).toHaveBeenLastCalledWith('idle')
  })
  it('explains permission, missing device and occupied device errors', () => {
    for (const [name, message] of [['NotAllowedError', '权限'], ['NotFoundError', '没有找到'], ['NotReadableError', '占用']]) {
      expect(microphoneError(Object.assign(new Error('raw'), { name }))).toContain(message)
    }
  })
})

describe('composer text and draft safety', () => {
  it('inserts emoji at the cursor and replaces a selection', () => {
    expect(insertAtSelection('你好世界', '🙂', 2, 2)).toEqual({ text: '你好🙂世界', cursor: 4 })
    expect(insertAtSelection('你好世界', '👍', 2, 4)).toEqual({ text: '你好👍', cursor: 4 })
  })
  it('never truncates an emoji to fit the input limit', () => {
    expect(insertAtSelection('abcd', '🙂', 4, 4, 5)).toEqual({ text: 'abcd', cursor: 4 })
  })
  it('only sends Enter outside IME composition and Shift+Enter', () => {
    const key = { key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13 }
    expect(shouldSendOnEnter(key)).toBe(true)
    expect(shouldSendOnEnter({ ...key, shiftKey: true })).toBe(false)
    expect(shouldSendOnEnter({ ...key, isComposing: true })).toBe(false)
    expect(shouldSendOnEnter({ ...key, keyCode: 229 })).toBe(false)
  })
  it('clears only the exact sent draft and preserves later edits', () => {
    const sent = { text: 'first', attachment: { id: 'a' } as AttachmentRef, quoteMessageId: 'quote-a' }
    expect(consumeDraft(sent, sent)).toEqual({ text: '', attachment: null, quoteMessageId: null })
    const current = { text: 'next', attachment: { id: 'b' } as AttachmentRef, quoteMessageId: 'quote-b' }
    expect(consumeDraft(current, sent)).toEqual(current)
    expect(consumeDraft({ ...sent, text: 'next' }, sent)).toEqual({ text: 'next', attachment: null, quoteMessageId: null })
    const renamed={...sent.attachment,name:'another name.txt'}
    expect(consumeDraft({...sent,attachment:renamed},sent).attachment).toEqual(renamed)
    const first={...sent,attachment:{id:'a',name:'test.txt',mime:'text/plain',size:1}}
    expect(consumeDraft({...first,attachment:{size:1,mime:'text/plain',name:'test.txt',id:'a'}},first).attachment).toBeNull()
  })
})
