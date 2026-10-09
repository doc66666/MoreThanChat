import { describe, expect, it } from 'vitest'
import { redactSecretFields } from '../src/main/secret-redaction'

describe('redactSecretFields', () => {
  it('removes credential fields before chat state is persisted', () => {
    const secret = 'sk-test-more-than-chat-secret'
    const redacted = redactSecretFields({
      version: 1,
      messages: [{ text: '普通消息', apiKey: secret }],
      nested: { authorization: `Bearer ${secret}`, accessToken: secret, keep: 'visible' },
    })
    expect(redacted).toEqual({
      version: 1,
      messages: [{ text: '普通消息' }],
      nested: { keep: 'visible' },
    })
    expect(JSON.stringify(redacted)).not.toContain(secret)
  })
})
