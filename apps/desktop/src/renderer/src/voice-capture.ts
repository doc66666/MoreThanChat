export type VoicePhase = 'idle' | 'requesting' | 'recording' | 'preparing'

export function microphoneError(error: unknown): string {
  const name = error instanceof Error ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return '麦克风权限未开启，请在系统隐私设置中允许访问后重试。'
  if (name === 'NotFoundError') return '没有找到麦克风，请连接设备后重试。'
  if (name === 'NotReadableError') return '麦克风暂时不可用，可能正被其他应用占用。'
  return error instanceof Error ? error.message : '录音失败，请检查麦克风后重试。'
}

/** One press owns one stream. Late permission/encoding results cannot outlive it. */
export class VoiceCapture {
  private generation = 0
  private phase: VoicePhase = 'idle'
  private recorder: MediaRecorder | null = null
  private stream: MediaStream | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private started = 0
  private duration = 0

  constructor(private readonly options: {
    getStream: () => Promise<MediaStream>
    createRecorder: (stream: MediaStream) => MediaRecorder
    onPhase: (phase: VoicePhase) => void
    onError: (message: string) => void
    prepare: (blob: Blob, durationMs: number) => Promise<() => void | Promise<void>>
  }) {}

  private setPhase(phase: VoicePhase) { this.phase = phase; this.options.onPhase(phase) }
  private release() {
    clearTimeout(this.timer)
    this.stream?.getTracks().forEach(track => track.stop())
    this.stream = null
    this.recorder = null
  }

  async begin() {
    if (this.phase !== 'idle') return
    const generation = ++this.generation
    this.setPhase('requesting')
    try {
      const stream = await this.options.getStream()
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return }
      this.stream = stream
      const recorder = this.options.createRecorder(stream)
      this.recorder = recorder
      const chunks: BlobPart[] = []
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data) }
      recorder.onerror = () => {
        if (generation !== this.generation) return
        this.cancel()
        this.options.onError('录音中断，请检查麦克风后重新录制。')
      }
      recorder.onstop = () => {
        if (generation !== this.generation) return
        if (this.phase === 'recording') this.duration = Date.now() - this.started
        this.release()
        this.setPhase('preparing')
        void (async () => {
          try {
            if (this.duration < 300) throw new Error('录音太短，请按住至少半秒再松开。')
            const deliver = await this.options.prepare(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }), Math.min(60000, this.duration))
            if (generation === this.generation) await deliver()
          } catch (error) {
            if (generation === this.generation) this.options.onError(microphoneError(error))
          } finally {
            if (generation === this.generation) this.setPhase('idle')
          }
        })()
      }
      recorder.start()
      this.started = Date.now()
      this.setPhase('recording')
      this.timer = setTimeout(() => this.finish(), 59000)
    } catch (error) {
      if (generation !== this.generation) return
      this.cancel()
      this.options.onError(microphoneError(error))
    }
  }

  finish() {
    // Releasing while the permission prompt is open never sends a recording later.
    if (this.phase === 'requesting') { this.cancel(); return }
    if (this.phase !== 'recording') return
    this.duration = Date.now() - this.started
    clearTimeout(this.timer)
    this.setPhase('preparing')
    this.recorder?.stop()
  }

  cancel() {
    ++this.generation
    const recorder = this.recorder
    this.release()
    if (recorder && recorder.state !== 'inactive') recorder.stop()
    this.setPhase('idle')
  }
}
