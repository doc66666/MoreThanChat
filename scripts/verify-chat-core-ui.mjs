import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import assert from 'node:assert/strict'
import { CdpClient, evaluate, waitForExpression, waitForTarget, reservePort, waitForExit, delay } from './verify-plugin-ui.mjs'

const root = path.resolve(import.meta.dirname, '..'), desktop = path.join(root, 'apps', 'desktop')
const executable = process.env.MTC_TEST_PACKAGED_EXE || createRequire(path.join(desktop, 'package.json'))('electron')
const packaged = Boolean(process.env.MTC_TEST_PACKAGED_EXE), profile = await mkdtemp(path.join(tmpdir(), 'mtc-chat-core-'))
const conversationId = 'legacy-assistant', credential = 'qa-chat-core-token'
const migrated = { version: 1, profile: { id: 'qa-user', displayName: '验收用户', avatar: 'M' }, activeConversationId: conversationId,
  conversations: [{ id: conversationId, title: 'More AI', subtitle: '迁移验收', avatar: 'AI', accent: '#21855e', kind: 'assistant', unread: 0, pinned: true, updatedAt: 1700000000000, transportId: 'builtin.local-demo' }],
  messages: { [conversationId]: [{ id: 'legacy-note', clientMessageId: 'legacy-note', conversationId, senderId: 'system', senderName: 'system', senderAvatar: 'S', role: 'system', type: 'system', text: '原有会话已保留', createdAt: 1700000000000, status: 'sent' }] } }
await writeFile(path.join(profile, 'chat-state.json'), JSON.stringify(migrated))
let session
const attempts = new Map(), transcripts = []
const markdown = '## Markdown 验收\n\n**加粗文字** 和 `inline code`。\n\n- 第一项\n- 第二项\n\n```js\nconst answer = 42;\n```\n\n| 功能 | 状态 |\n| --- | --- |\n| 存储 | 完成 |\n\n[安全链接](https://example.com) [危险链接](javascript:alert(1))\n\n![远程图片](https://example.com/tracker.png)\n\n<script>window.__markdownInjected=true</script>'
const server = createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk
  const data = JSON.parse(body), prompt = data.messages.findLast(message => message.role === 'user').content
  transcripts.push(data.messages)
  attempts.set(prompt, (attempts.get(prompt) ?? 0) + 1)
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  if (prompt === 'RETRY-QUESTION' && attempts.get(prompt) === 1) {
    response.end('data: {"choices":[{"delta":{"content":"未完成的半截回复"}}]}\n\n')
    return
  }
  if (prompt === 'CANCEL-QUESTION') {
    response.write('data: {"choices":[{"delta":{"content":"取消前的部分文本"}}]}\n\n')
    const timer = setTimeout(() => response.end('data: {"choices":[{"delta":{"content":"不应到达"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'), 10000)
    response.on('close', () => clearTimeout(timer))
    return
  }
  const content = prompt === 'RETRY-QUESTION' ? markdown : '最后一条回复，关闭窗口后仍应保留。'
  response.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
async function launch() {
  const port = await reservePort()
  const child = spawn(executable, [`--remote-debugging-port=${port}`, '.'], { cwd: desktop, env: { ...process.env, MTC_QA_MODE: '1', MTC_QA_USER_DATA_DIR: profile }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.resume(); child.stderr.resume()
  const client = await CdpClient.connect((await waitForTarget(port)).webSocketDebuggerUrl)
  await waitForExpression(client, `document.querySelector('.host-status')?.dataset.hostState==='ready' && Boolean(document.querySelector('.composer textarea'))`)
  return { child, client }
}
async function close() {
  const value = session; session = undefined
  if (!value) return
  try { await Promise.race([value.client.send('Browser.close'), delay(500)]) } catch {}
  await waitForExit(value.child, 4000)
  value.client.close()
  if (value.child.exitCode === null) { value.child.kill(); throw new Error('Application did not flush and exit') }
}
async function send(text) {
  await evaluate(session.client, `(() => {const node=document.querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(node,${JSON.stringify(text)});node.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  await waitForExpression(session.client, `!document.querySelector('.send-button')?.disabled`)
  await evaluate(session.client, `document.querySelector('.send-button')?.click()`)
}
function persisted() {
  const db = new DatabaseSync(path.join(profile, 'chat.sqlite'), { readOnly: true })
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    return db.prepare('SELECT payload FROM messages ORDER BY position').all().map(row => JSON.parse(row.payload))
  } finally { db.close() }
}
try {
  session = await launch()
  const duplicate = spawn(executable, ['.'], { cwd: desktop, env: { ...process.env, MTC_QA_MODE: '1', MTC_QA_USER_DATA_DIR: profile }, windowsHide: true, stdio: 'ignore' })
  await waitForExit(duplicate, 4000)
  if (duplicate.exitCode === null) { duplicate.kill(); throw new Error('Duplicate instance kept the database open') }
  assert.equal(duplicate.exitCode, 0)
  assert((await evaluate(session.client, `document.body.innerText`)).includes('原有会话已保留'))
  await assert.rejects(readFile(path.join(profile, 'chat-state.json')), { code: 'ENOENT' })
  assert.deepEqual(JSON.parse(await readFile(path.join(profile, 'chat-state.json.migrated'), 'utf8')), migrated)
  await evaluate(session.client, `document.querySelector('button[title="设置"]')?.click()`)
  await waitForExpression(session.client, `Boolean(document.querySelector('.settings-drawer'))`)
  for (const [field, value] of Object.entries({ provider: 'openai-compatible', 'base-url': `http://127.0.0.1:${server.address().port}`, model: 'qa-chat-core', key: credential })) {
    await evaluate(session.client, `(() => { const node=document.querySelector('[data-model-field="${field}"]'); const prototype=node.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event(node.tagName==='SELECT'?'change':'input',{bubbles:true})); })()`)
  }
  await waitForExpression(session.client, `!document.querySelector('.settings-drawer .primary-button')?.disabled`)
  await evaluate(session.client, `document.querySelector('.settings-drawer .primary-button')?.click()`)
  await waitForExpression(session.client, `document.querySelector('.settings-drawer')?.dataset.hasApiKey==='true' && document.querySelector('[data-model-field="key"]')?.value===''`)
  await evaluate(session.client, `document.querySelector('.settings-drawer .drawer-header button')?.click()`)
  await send('RETRY-QUESTION')
  await waitForExpression(session.client, `Boolean(document.querySelector('.status-failed .message-retry'))`)
  assert((await evaluate(session.client, `document.querySelector('.status-failed').innerText`)).includes('未完成的半截回复'))
  await evaluate(session.client, `(() => { const button=document.querySelector('.message-retry'); button.click(); button.click(); })()`)
  await waitForExpression(session.client, `Boolean(document.querySelector('.message-usage[data-token-total="15"]'))`)
  assert.equal(transcripts[1].filter(message => message.content === 'RETRY-QUESTION').length, 1)
  assert(!transcripts[1].some(message => message.content.includes('未完成的半截回复')))
  assert.equal(attempts.get('RETRY-QUESTION'), 2, 'Double click started duplicate retries')
  const rendering = await evaluate(session.client, `({head:document.querySelector('.message-markdown h2')?.textContent,bold:document.querySelector('.message-markdown strong')?.textContent,code:document.querySelector('.message-code code')?.textContent,table:document.querySelectorAll('.message-table td').length,images:document.querySelectorAll('.message-markdown img').length,scripts:document.querySelectorAll('.message-markdown script').length,unsafe:[...document.querySelectorAll('.message-markdown a')].some(n=>!n.href.startsWith('http')),injected:Boolean(window.__markdownInjected)})`)
  assert.equal(rendering.head, 'Markdown 验收'); assert.equal(rendering.bold, '加粗文字'); assert(rendering.code.includes('const answer = 42'))
  assert.equal(rendering.table, 2); assert.equal(rendering.images, 0); assert.equal(rendering.scripts, 0); assert.equal(rendering.unsafe, false); assert.equal(rendering.injected, false)
  await send('CANCEL-QUESTION')
  await waitForExpression(session.client, `Boolean(document.querySelector('.send-button.stop')) && document.body.innerText.includes('取消前的部分文本')`)
  await evaluate(session.client, `document.querySelector('.send-button.stop').click()`)
  await waitForExpression(session.client, `Boolean(document.querySelector('.status-cancelled'))`)
  const capture = await session.client.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await mkdir(path.join(root, '.artifacts'), { recursive: true })
  await writeFile(path.join(root, '.artifacts', packaged ? 'chat-core-packaged-e2e.png' : 'chat-core-e2e.png'), Buffer.from(capture.data, 'base64'))
  await send('CLOSE-QUESTION')
  await waitForExpression(session.client, `document.body.innerText.includes('最后一条回复，关闭窗口后仍应保留。') && !document.querySelector('.send-button.stop')`)
  await close()
  const messages = persisted()
  assert.equal(messages.filter(message => message.role === 'self' && message.text === 'RETRY-QUESTION').length, 1)
  assert(messages.some(message => message.status === 'failed' && message.supersededById && message.errorMessage))
  assert(messages.some(message => message.status === 'sent' && message.retryOfId && message.usage?.totalTokens === 15))
  assert(messages.some(message => message.status === 'cancelled' && message.text === '取消前的部分文本'))
  assert(messages.some(message => message.status === 'sent' && message.text === '最后一条回复，关闭窗口后仍应保留。'))
  assert(!JSON.stringify(messages).includes(credential))
  assert(!transcripts.at(-1).some(message => message.content.includes('取消前的部分文本')))
  session = await launch()
  await waitForExpression(session.client, `document.body.innerText.includes('最后一条回复，关闭窗口后仍应保留。') && Boolean(document.querySelector('.message-usage[data-token-total="15"]'))`)
  await evaluate(session.client, `window.moreThanChat.setModelSettings({clearApiKey:true})`)
  console.log(JSON.stringify({ passed: true, packaged, sqlite: true, legacyMigrated: true, integrityCheck: true, singleInstance: true, markdown: true, retryWithoutDuplicate: true, doubleClickDeduplicated: true, cancellation: true, tokens: true, closeFlushed: true, restored: true, requests: transcripts.length }))
} catch (error) {
  console.error(String(error.message))
  process.exitCode = 1
} finally {
  if (session) { try { await evaluate(session.client, `window.moreThanChat.setModelSettings({clearApiKey:true})`) } catch {}; await close().catch(() => undefined) }
  await new Promise(resolve => server.close(resolve))
}
