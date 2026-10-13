export interface SnapshotState<T> { value: T | null; loading: boolean; error: string }

/** A push event is newer than any read already in flight. Supports retry and remount. */
export class LiveSnapshot<T> {
  private revision = 0
  private active = false
  private epoch = 0
  private value: T | null = null
  private unsubscribe: (() => void) | undefined
  constructor(private readonly read: () => Promise<T>, private readonly subscribe: (listener: (value: T) => void) => () => void, private readonly publish: (state: SnapshotState<T>) => void) {}
  start() {
    this.stop(); this.active = true
    const epoch=this.epoch
    this.unsubscribe = this.subscribe(value => {
      if (!this.active||epoch!==this.epoch) return
      ++this.revision; this.value = value
      this.publish({ value, loading: false, error: '' })
    })
    return this.refresh()
  }
  async refresh() {
    if (!this.active) return
    const revision = ++this.revision
    this.publish({ value: this.value, loading: true, error: '' })
    try {
      const value = await this.read()
      if (this.active && revision === this.revision) {
        this.value = value; this.publish({ value, loading: false, error: '' })
      }
    } catch (error) {
      if (this.active && revision === this.revision) this.publish({ value: this.value, loading: false, error: error instanceof Error ? error.message : '暂时无法读取状态，请重试。' })
    }
  }
  stop() { this.active = false; ++this.epoch; ++this.revision; this.unsubscribe?.(); this.unsubscribe = undefined }
}
