// No BrowserWindow, CDP or desktop input. The real settings are read only; all
// identities, conversations, relay data and model settings live in a temp dir.
// Usage: node scripts/verify-live-chat-access.cjs --settings-from <profile>
// Enter an API key at the hidden stdin prompt. Keys are never saved.
// Requires pnpm build:host && pnpm --filter @more-than-chat/desktop build:main.
const path = require('node:path')
const fs = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const { randomUUID } = require('node:crypto')
const assert = require('node:assert/strict')
const repo = path.resolve(__dirname, '..')
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
const desktopRequire = createRequire(path.join(repo, 'apps/desktop/package.json'))

async function until(check, description, timeout = 10000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 30)) }
  throw Error('Timed out: ' + description)
}

async function run() {
  const profile = arg('--settings-from')
  assert(profile && path.isAbsolute(profile), '--settings-from requires an absolute profile path')
  const settings = JSON.parse(await fs.readFile(path.join(profile, 'host-private/model-settings.json'), 'utf8'))
  assert.equal(settings.providerMode, 'openai-compatible')
  assert.equal(new URL(settings.baseUrl).origin, 'https://api.deepseek.com', 'This cost-bounded check targets the configured DeepSeek endpoint only')
  const { readSecret } = await import('./live-test-input.mjs')
  const key = await readSecret()
  const root = await fs.mkdtemp(path.join(tmpdir(), 'mtc-live-chat-'))
  const clients = [], stores = []
  let service, relay, requests = 0
  try {
    const { createCentralServer } = await import(pathToFileURL(path.join(repo, 'apps/central-server/src/server.mjs')))
    const { ModelService } = require('../apps/pc-host/dist/model-service.js')
    const { PluginDraftService } = require('../apps/pc-host/dist/plugin-drafts.js')
    const { createAuthorToolExecutor } = require('../apps/pc-host/dist/author-tools.js')
    const { MemoryModelCredentials } = require('../apps/pc-host/dist/credential-client.js')
    const { ChatStore } = require('../apps/desktop/dist-main/chat-store.js')
    const { AttachmentStore } = require('../apps/desktop/dist-main/attachments.js')
    const { ClientIdentity } = require('../apps/desktop/dist-main/identity-store.js')
    const { CentralClient } = require('../apps/desktop/dist-main/central-client.js')
    const { createChatAccess } = require('../apps/desktop/dist-main/chat-access.js')
    const { createSeedState } = desktopRequire('@more-than-chat/chat-core')
    relay = createCentralServer({ directory: path.join(root, 'relay'), mode: 'public', adminToken: randomUUID() })
    const url = 'http://127.0.0.1:' + (await relay.listen(0)).port
    async function member(name) {
      const dir = path.join(root, name), store = await ChatStore.open(dir), files = new AttachmentStore(path.join(dir, 'files'))
      stores.push(store); store.save(createSeedState())
      const cipher = { available: () => true, encrypt: v => Buffer.from(v), decrypt: v => v.toString() }
      const client = new CentralClient(await ClientIdentity.load(dir, cipher), store, files, dir)
      clients.push(client); await client.connect(url, name)
      return { client, store, files }
    }
    const a = await member('本机验收'), b = await member('测试好友小林'), c = await member('测试群友小陈')
    for (const other of [b, c]) {
      await a.client.action('friends/request', { userId: other.client.identity.userId })
      await other.client.action('friends/accept', { userId: a.client.identity.userId })
    }
    const group = (await a.client.action('groups', { name: '无窗口验收群', memberIds: [b.client.identity.userId, c.client.identity.userId] })).directory.groups[0]
    const conversation = (member, target) => member.store.conversationList().find(entry => entry.targetId === target)
    await until(() => conversation(b, group.id) && conversation(c, group.id), 'group membership')
    const directId = String(conversation(a, b.client.identity.userId).id), groupId = String(conversation(a, group.id).id)
    for (const [kind, target] of [['direct', a.client.identity.userId], ['group', group.id]]) {
      const file = await b.files.put(Buffer.from(kind === 'direct' ? '附件校验词：青苔。' : '附件校验词：星河。'), '验收记录.txt', 'text/plain')
      await b.client.send({ conversationId: String(conversation(b, target).id), clientMessageId: 'fixture-' + kind,
        text: kind === 'direct' ? '下午三点见。请看附件。' : '周六十点集合。请看附件。', attachmentId: file.id, attachmentRef: file })
    }
    await until(() => a.store.messageByClient(relay.serverId, b.client.identity.userId, 'fixture-direct') && a.store.messageByClient(relay.serverId, b.client.identity.userId, 'fixture-group'), 'fixtures delivered')
    const unread = [a.store.conversation(directId).unread, a.store.conversation(groupId).unread]
    const drafts = new PluginDraftService({ dataDir: path.join(root, 'host'), installedPlugins: () => [] })
    const access = createChatAccess(a.store, a.files, input => a.client.send(input))
    const operations = []
    service = new ModelService({ dataDir: path.join(root, 'host'), generation: 1, credentials: new MemoryModelCredentials(),
      authorTools: createAuthorToolExecutor(drafts, undefined, async request => { operations.push(request); return access(request) }),
      fetchImpl: async (url, init) => {
        assert(++requests <= 14, 'Live check request budget exhausted')
        const body = JSON.parse(init.body)
        assert(body.tools.some(tool => tool.function.name === 'send_chat_message'))
        body.max_tokens = 1536
        console.log(JSON.stringify({ request: requests, model: settings.model, tools: body.tools.map(tool => tool.function.name) }))
        return fetch(url, { ...init, body: JSON.stringify(body), signal: AbortSignal.any([init.signal, AbortSignal.timeout(60000)]) })
      },
    })
    await service.load()
    await service.setSettings({ providerMode: settings.providerMode, baseUrl: settings.baseUrl, model: settings.model, apiKey: key })
    const reports = []
    for (const [kind, target, recipient, expected, word] of [
      ['direct', directId, '好友“测试好友小林”', '1', '青苔'],
      ['group', groupId, '群聊“无窗口验收群”', '2', '星河'],
    ]) {
      const before = operations.length, events = []
      service.start({ streamId: randomUUID(), conversationId: 'isolated-assistant', assistantMessageId: randomUUID(), messages: [
        { role: 'user', content: '你可以看聊天记录和发消息吗？' },
        { role: 'assistant', content: '我没有发送消息的工具。工具清单只有读草稿、创建、校验、诊断、列插件、删草稿和卸载。没有 list_conversations，没有 send_chat_message，也没有任何读取联系人或会话的接口。可执行插件只能操作当前打开的输入框。代用户联系别人本身越界。请你自己发送。' },
        { role: 'user', content: `读取${recipient}最近的聊天记录和其中的文本附件，告诉我记录内容及附件校验词。然后给该会话发一条内容严格为“${expected}”的纯文本消息，不附带文件，不发给其他会话。` },
      ] }, event => {
        events.push(event)
        if (event.event === 'model.authorTool') console.log(JSON.stringify({ case: kind, tool: event.payload.tool, phase: event.payload.phase, ok: event.payload.ok }))
      })
      await until(() => events.some(event => ['model.chat.completed', 'model.chat.failed', 'model.chat.cancelled'].includes(event.event)), 'real model ' + kind, 180000)
      const terminal = events.at(-1)
      assert.equal(terminal.event, 'model.chat.completed', terminal.payload.error?.message)
      const used = operations.slice(before), sends = used.filter(request => request.action === 'send')
      assert(used.some(request => request.action === 'list'), 'Model did not list actual conversations')
      assert(used.some(request => request.action === 'history' && request.conversationId === target), 'Model did not read the requested history')
      assert(used.some(request => request.action === 'attachment' && request.conversationId === target), 'Model did not read the requested attachment')
      assert.equal(sends.length, 1, 'Must send exactly once')
      assert.equal(sends[0].conversationId, target); assert.equal(sends[0].text, expected); assert.equal(sends[0].attachmentMessageId, undefined)
      assert(terminal.payload.text.includes(word), 'Reply did not contain the actual attachment content')
      const sentId = sends[0].clientMessageId
      await until(() => b.store.messageByClient(relay.serverId, a.client.identity.userId, sentId), 'recipient delivery')
      assert.equal(b.store.messageByClient(relay.serverId, a.client.identity.userId, sentId).text, expected)
      if (kind === 'group') await until(() => c.store.messageByClient(relay.serverId, a.client.identity.userId, sentId), 'second group recipient')
      else assert.equal(c.store.messageByClient(relay.serverId, a.client.identity.userId, sentId), undefined)
      assert.equal(relay.db.prepare('SELECT COUNT(*) AS n FROM message_routes WHERE sender=? AND client_id=?').get(a.client.identity.userId, sentId).n, 1)
      assert.deepEqual([a.store.conversation(directId).unread, a.store.conversation(groupId).unread], unread)
      assert.deepEqual(a.store.pendingReads(relay.serverId), [])
      reports.push({ case: kind, passed: true, operations: used.map(request => request.action), reply: terminal.payload.text, usage: terminal.payload.usage, receivedBy: kind === 'group' ? 2 : 1 })
    }
    assert.deepEqual((await drafts.inspect()).drafts, [])
    console.log(JSON.stringify({ passed: true, model: settings.model, requests, realProfileReadOnly: true, noWindowsCreated: true, reports }, null, 2))
  } finally {
    service?.close()
    for (const client of clients) await client.disconnect(false)
    await relay?.close()
    for (const store of stores) store.close()
    assert(path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('mtc-live-chat-'))
    await fs.rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 })
  }
}

run().catch(error => { console.error(String(error.message).replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')); process.exitCode = 1 })
