import { randomUUID } from 'node:crypto'
import { createHostRequest, safeParseHostMessage, type HostResponse } from '@more-than-chat/protocol'

export interface ModelCredentials {
  read(): Promise<string | null>
  write(key: string | null): Promise<void>
}

/** Standalone/mock hosts keep keys in memory only. No plaintext disk fallback. */
export class MemoryModelCredentials implements ModelCredentials {
  #key: string | null = null
  async read(): Promise<string | null> { return this.#key }
  async write(key: string | null): Promise<void> { this.#key = key }
}

export class HostCredentialClient implements ModelCredentials {
  readonly #pending = new Map<string, { method: string; resolve: (response: HostResponse) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  constructor(readonly send: (message: unknown) => void) {}

  accept(raw: unknown): boolean {
    const parsed = safeParseHostMessage(raw)
    if (!parsed.success || parsed.data.kind !== 'response') return false
    const response = parsed.data
    const pending = this.#pending.get(response.requestId)
    if (!pending) return false
    clearTimeout(pending.timer)
    this.#pending.delete(response.requestId)
    if (response.method !== pending.method || !response.ok) pending.reject(new Error('Credential service is unavailable.'))
    else pending.resolve(response)
    return true
  }

  async read(): Promise<string | null> {
    const response = await this.#request('credentials.read', {})
    if (response.ok && response.method === 'credentials.read') return response.payload.apiKey
    throw new Error('Credential service is unavailable.')
  }
  async write(apiKey: string | null): Promise<void> { await this.#request('credentials.write', { apiKey }) }

  #request(method: 'credentials.read' | 'credentials.write', payload: Record<string, never> | { apiKey: string | null }): Promise<HostResponse> {
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error('Credential service timed out.')) }, 3000)
      this.#pending.set(id, { method, resolve, reject, timer })
      try { this.send(createHostRequest(method, id, payload)) }
      catch { clearTimeout(timer); this.#pending.delete(id); reject(new Error('Credential service is unavailable.')) }
    })
  }
}
