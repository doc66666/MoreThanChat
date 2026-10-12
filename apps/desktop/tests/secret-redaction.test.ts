import { describe, expect, it } from 'vitest'
import { redactSecretFields } from '../src/main/secret-redaction'

describe('redactSecretFields', () => {
  it('preserves intentional chat text while keeping credential fields and errors redacted',()=>{
    const content='Example code: sk-synthetic-not-an-api-key and Bearer example-token'
    expect(redactSecretFields({text:content,apiKey:'private',errorMessage:'Bearer error-token'},false)).toEqual({text:content,errorMessage:'Bearer [redacted]'})
    expect((redactSecretFields({text:content}) as {text:string}).text).not.toContain('example-token')
  })
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
