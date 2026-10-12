const secretFieldNames = new Set([
  'apiKey',
  'api_key',
  'authorization',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'password',
  'secret',
])

/** Drops credential-shaped object fields before chat state is written to disk. */
export function redactSecretFields(value: unknown, redactStrings = true): unknown {
  if (typeof value === 'string') return redactStrings ? value.replace(/bearer\s+\S+/gi, 'Bearer [redacted]').replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]') : value
  if (Array.isArray(value)) return value.map(item => redactSecretFields(item,redactStrings))
  if (!value || typeof value !== 'object') return value
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (secretFieldNames.has(key)) continue
    output[key] = redactSecretFields(item,redactStrings || ['errorMessage','summary'].includes(key))
  }
  return output
}
