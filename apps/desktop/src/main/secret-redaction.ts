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
export function redactSecretFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => redactSecretFields(item))
  if (!value || typeof value !== 'object') return value
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (secretFieldNames.has(key)) continue
    output[key] = redactSecretFields(item)
  }
  return output
}
