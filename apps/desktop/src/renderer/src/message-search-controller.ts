export interface SearchState<T> {
  status: 'idle' | 'loading' | 'ready' | 'error'
  results: T[]
  error: string
}

/** Debounce work, but invalidate old results immediately (including empty input). */
export class MessageSearchController<T> {
  private generation = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  constructor(
    private readonly search: (query: string, conversationId?: string) => Promise<T[]>,
    private readonly publish: (state: SearchState<T>) => void,
  ) {}

  run(query: string, conversationId?: string, delay = 180) {
    this.cancel()
    const generation = this.generation, needle = query.trim()
    this.publish({ status: needle ? 'loading' : 'idle', results: [], error: '' })
    if (!needle) return
    this.timer = setTimeout(() => {
      void (async () => {
        try {
          const results = await this.search(needle, conversationId)
          if (generation === this.generation) this.publish({ status: 'ready', results, error: '' })
        } catch (error) {
          if (generation === this.generation) this.publish({ status: 'error', results: [], error: error instanceof Error ? error.message : '搜索失败，请重试。' })
        }
      })()
    }, delay)
  }

  cancel() { ++this.generation; clearTimeout(this.timer) }
}
