import type { ProtocolErrorCode } from '@more-than-chat/protocol'

export type ModelErrorCode = Extract<ProtocolErrorCode,
  'MODEL_NOT_CONFIGURED' | 'MODEL_REQUEST_FAILED' | 'MODEL_STREAM_NOT_FOUND' | 'CREDENTIAL_UNAVAILABLE' | 'INVALID_PAYLOAD'>

export class ModelServiceError extends Error {
  constructor(
    readonly code: ModelErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'ModelServiceError'
  }
}

/** Removes credential material from text that may be shown or stored. */
export function sanitizeProviderText(message: string, secret: string): string {
  let text = message.replace(/bearer\s+\S+/gi, 'Bearer [redacted]')
  const token = secret.trim()
  if (token.length >= 4) text = text.split(token).join('[redacted]')
  text = text.replace(/\s+/g, ' ').trim()
  if (!text) return '模型请求失败。'
  return text.length > 240 ? `${text.slice(0, 237)}...` : text
}
