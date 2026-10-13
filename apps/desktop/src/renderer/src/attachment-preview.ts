export interface PreviewState {
  status: 'loading' | 'ready' | 'error'
  url: string | null
}

/** Owns object URLs; stale reads never allocate a URL or update another message. */
export class AttachmentPreview {
  private generation = 0
  private url: string | null = null
  constructor(private readonly options: {
    read: (id: string) => Promise<{ data: string }>
    create: (data: string, mime: string) => string
    revoke: (url: string) => void
    publish: (state: PreviewState) => void
  }) {}
  private release() { if (this.url) this.options.revoke(this.url); this.url = null }
  async load(id: string, mime: string) {
    const generation = ++this.generation
    this.release()
    this.options.publish({ status: 'loading', url: null })
    try {
      const wire = await this.options.read(id)
      if (generation !== this.generation) return
      this.url = this.options.create(wire.data, mime)
      this.options.publish({ status: 'ready', url: this.url })
    } catch {
      if (generation === this.generation) this.options.publish({ status: 'error', url: null })
    }
  }
  mediaError(url: string) {
    if (url !== this.url) return
    ++this.generation; this.release()
    this.options.publish({ status: 'error', url: null })
  }
  dispose() { ++this.generation; this.release() }
}
