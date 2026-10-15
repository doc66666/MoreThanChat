import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HostEventMessage } from '@more-than-chat/protocol'
import { AUTHOR_TOOL_DEFINITIONS, createAuthorToolExecutor } from '../src/author-tools'
import { DEFAULT_PLUGIN_AUTHOR_CONTRACT, PLUGIN_AUTHOR_CONTRACT } from '../src/author-contract'
import { ModelService } from '../src/model-service'
import { createMockProvider, createOpenAiCompatibleProvider, type ChatModelProvider } from '../src/openai-compatible'
import { PluginDraftService } from '../src/plugin-drafts'

const secret = 'sk-test-more-than-chat-secret'
const source = JSON.stringify({ kind: 'composer-transform-action', actionId: 'trim', label: '清理空白', operation: 'trim' })
const directories: string[] = []

afterEach(async () => {
  delete (globalThis as { __mtcAuthorToolRan?: boolean }).__mtcAuthorToolRan
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('plugin author tool loop', () => {
  it('defaults to executable authoring and only returns the old interpreter contract on request', async () => {
    const executor=createAuthorToolExecutor(new PluginDraftService({dataDir:await tempDir(),installedPlugins:()=>[]}))
    const inspect=(args:unknown)=>executor.execute({id:'inspect',name:'inspect_drafts',arguments:JSON.stringify(args)})
    expect(JSON.parse((await inspect({})).content).contract).toEqual(DEFAULT_PLUGIN_AUTHOR_CONTRACT)
    expect((await inspect({})).content).not.toContain('数组最多64项')
    expect(JSON.parse((await inspect({format:'legacy'})).content).contract.groupPlugin).toEqual(PLUGIN_AUTHOR_CONTRACT.groupPlugin)
    expect((await inspect({format:'unknown'})).notice.ok).toBe(false)
    expect(AUTHOR_TOOL_DEFINITIONS[1].function.description).toContain('JavaScript')
  })

  it('wraps a 225-cell executable source without double JSON encoding or executing it', async () => {
    const drafts=new PluginDraftService({dataDir:await tempDir(),installedPlugins:()=>[]})
    const executor=createAuthorToolExecutor(drafts)
    const code='globalThis.__mtcAuthorToolRan = true;\nexport default function activate(ctx,sdk) { const cells=Array(225).fill(null); const text="引号\\\"和换行\\n"; ctx.contribute(ctx.getService("ui.surfaces"), {id:"board",surface:"root",render:()=>sdk.React.createElement("div",null,text,...cells.map((_,i)=>sdk.React.createElement("button",{key:i},i)))}); }'
    const manifest=PLUGIN_AUTHOR_CONTRACT.executableClient.manifestExample
    const result=await executor.execute({id:'create',name:'create_draft',arguments:JSON.stringify({manifest,code})})
    expect(result.notice.ok).toBe(true)
    expect(result.notice.draft?.revision).toBe(1)
    const saved=await drafts.readForAuthor(manifest.id)
    expect(JSON.parse(saved.source)).toEqual({kind:'executable-client',code})
    expect((globalThis as {__mtcAuthorToolRan?:boolean}).__mtcAuthorToolRan).toBeUndefined()
  })

  it('returns syntax diagnostics and the saved revision so a failed draft can be repaired immediately', async () => {
    const drafts=new PluginDraftService({dataDir:await tempDir(),installedPlugins:()=>[]})
    const executor=createAuthorToolExecutor(drafts),manifest=PLUGIN_AUTHOR_CONTRACT.executableClient.manifestExample
    const create=(code:string,baseRevision=0)=>executor.execute({id:'create',name:'create_draft',arguments:JSON.stringify({manifest,code,baseRevision})})
    const broken=await create('export default function activate( {')
    expect(broken.notice.ok).toBe(false)
    expect(broken.notice.summary).toContain('Unexpected token')
    expect(JSON.parse(broken.content)).toMatchObject({persisted:true,repair:{baseRevision:1}})
    const fixed=await create('export default function activate(ctx,sdk) {}',1)
    expect(fixed.notice).toMatchObject({ok:true,draft:{revision:2}})
    const missing=await create('const x = 1;',2)
    expect(missing.notice.summary).toContain('默认导出')
  })

  it('rejects mixed old/new inputs without saving or replacing any draft',async()=>{
    const drafts=new PluginDraftService({dataDir:await tempDir(),installedPlugins:()=>[]})
    const result=await createAuthorToolExecutor(drafts).execute({id:'create',name:'create_draft',arguments:JSON.stringify({manifest:PLUGIN_AUTHOR_CONTRACT.executableClient.manifestExample,code:'export default function(){}',source:'{}'})})
    expect(result.notice.ok).toBe(false)
    expect((await drafts.inspect()).drafts).toHaveLength(0)
  })

  it('allows repair work beyond the old six-round cutoff',async()=>{
    const provider:ChatModelProvider={async stream(request,onDelta){
      const round=request.messages.filter(m=>m.role==='tool').length
      const call=(name:string,args:unknown)=>({toolCalls:[{id:'call-'+round,name,arguments:JSON.stringify(args)}]})
      if(round<6)return call('inspect_drafts',{})
      if(round===6)return call('create_draft',{manifest:PLUGIN_AUTHOR_CONTRACT.executableClient.manifestExample,code:'export default function activate() {}'})
      if(round===7)return call('validate_draft',{draftId:PLUGIN_AUTHOR_CONTRACT.executableClient.manifestExample.id})
      onDelta('草稿已保存并通过校验，等待用户安装');return {toolCalls:[]}
    }}
    const {service,events,drafts}=await createLoop(provider)
    service.start(startInput(),event=>events.push(event))
    await waitFor(()=>events.some(e=>e.event==='model.chat.completed'))
    expect((await drafts.inspect()).drafts[0]?.ok).toBe(true)
    service.close()
  })

  it('reserves a tools-disabled summary turn after twelve tool rounds',async()=>{
    let rounds=0,summaries=0
    const provider:ChatModelProvider={async stream(request,onDelta){
      if(request.toolsEnabled===false){summaries++;onDelta('本轮已结束，已保存的草稿可继续修订。');return {toolCalls:[]}}
      rounds++;return {toolCalls:[{id:'inspect-'+rounds,name:'inspect_drafts',arguments:'{}'}]}
    }}
    const {service,events}=await createLoop(provider)
    service.start(startInput(),event=>events.push(event))
    await waitFor(()=>events.some(e=>e.event==='model.chat.completed'))
    expect(rounds).toBe(12);expect(summaries).toBe(1)
    expect(events.some(e=>e.event==='model.chat.failed')).toBe(false)
    service.close()
  })

  it('rejects stale or missing bases and lets the author re-read and merge without losing user changes', async () => {
    const directory = await tempDir()
    const drafts = new PluginDraftService({ dataDir: directory, installedPlugins: () => [] })
    const executor = createAuthorToolExecutor(drafts)
    const save = (extra: Record<string, unknown> = {}) => executor.execute({ id: 'save', name: 'create_draft', arguments: JSON.stringify({ manifestJson: manifest('example.note'), source, ...extra }) })
    expect((await save()).notice.ok).toBe(true)
    const read = await drafts.readForAuthor('example.note')
    const userSource = JSON.stringify({ kind: 'composer-text-action', actionId: 'note', label: '用户的按钮', text: 'keep-user-change' })
    await drafts.create({ manifestJson: manifest('example.note'), source: userSource })
    for (const extra of [{}, { baseRevision: 0 }, { baseRevision: read.draft.revision }, { baseRevision: 99 }]) {
      const result = await save(extra)
      expect(result.notice).toMatchObject({ ok: false, pendingInstall: false, draft: null })
      expect(result.content).toContain('修订号冲突')
    }
    const latest = await drafts.readForAuthor('example.note')
    expect(latest.draft.revision).toBe(2)
    expect(latest.source).toBe(userSource)
    const merged = { ...JSON.parse(latest.source), label: 'AI 改名' }
    expect((await save({ baseRevision: latest.draft.revision, source: JSON.stringify(merged) })).notice.ok).toBe(true)
    const reopened = new PluginDraftService({ dataDir: directory, installedPlugins: () => [] })
    const final = await reopened.readForAuthor('example.note')
    expect(final.draft.revision).toBe(3)
    expect(JSON.parse(final.source)).toMatchObject({ label: 'AI 改名', text: 'keep-user-change' })
    expect(JSON.parse(await readFile(path.join(directory, 'plugin-drafts', 'example.note', 'revision-2.json'), 'utf8')).source).toBe(userSource)
  })

  it('serializes competing AI saves and admits only one matching base', async () => {
    const drafts = new PluginDraftService({ dataDir: await tempDir(), installedPlugins: () => [] })
    await drafts.create({ manifestJson: manifest('example.note'), source })
    const executor = createAuthorToolExecutor(drafts)
    const results = await Promise.all([1, 2].map(n => executor.execute({ id: `save-${n}`, name: 'create_draft', arguments: JSON.stringify({ manifestJson: manifest('example.note'), source, baseRevision: 1 }) })))
    expect(results.filter(result => result.notice.ok)).toHaveLength(1)
    expect(results.filter(result => result.content.includes('修订号冲突'))).toHaveLength(1)
    expect((await drafts.readForAuthor('example.note')).draft.revision).toBe(2)
  })

  it('recovers from a concurrent user edit within one model tool conversation', async () => {
    let store: PluginDraftService
    const provider: ChatModelProvider = {
      async stream(request, onDelta) {
        const results = request.messages.filter(message => message.role === 'tool')
        const call = (name: string, args: unknown) => ({ toolCalls: [{ id: `call-${results.length}`, name, arguments: JSON.stringify(args) }] })
        if (results.length === 0 || results.length === 2) {
          if (results.length === 2) expect(results[1]!.content).toContain('修订号冲突')
          return call('inspect_drafts', { draftId: 'example.note' })
        }
        if (results.length === 1 || results.length === 3) {
          const snapshot = JSON.parse(results.at(-1)!.content!)
          if (results.length === 1) await store.create({ manifestJson: snapshot.manifestJson,
            source: JSON.stringify({ ...JSON.parse(snapshot.source), text: 'concurrent-user-marker' }) })
          return call('create_draft', { manifestJson: snapshot.manifestJson,
            source: JSON.stringify({ ...JSON.parse(snapshot.source), label: 'AI 改名' }), baseRevision: snapshot.draft.revision })
        }
        if (results.length === 4) return call('validate_draft', { draftId: 'example.note' })
        onDelta('已合并用户修改，等待确认')
        return { toolCalls: [] }
      },
    }
    const { service, drafts, events } = await createLoop(provider)
    store = drafts
    await drafts.create({ manifestJson: manifest('example.note'), source: JSON.stringify({ kind: 'composer-text-action', actionId: 'note', label: '旧名称', text: '旧内容' }) })
    service.start(startInput(), event => events.push(event))
    await waitFor(() => events.some(event => event.event === 'model.chat.completed'))
    const final = await drafts.readForAuthor('example.note')
    expect(final.draft.revision).toBe(3)
    expect(JSON.parse(final.source)).toMatchObject({ label: 'AI 改名', text: 'concurrent-user-marker' })
    const saves = events.filter(event => event.event === 'model.authorTool' && event.payload.tool === 'create_draft' && event.payload.phase === 'finished')
    expect(saves).toHaveLength(2)
    expect(saves[0]).toMatchObject({ payload: { ok: false, pendingInstall: false, draft: null } })
    expect(saves[1]).toMatchObject({ payload: { ok: true, pendingInstall: true, draft: { revision: 3 } } })
    expect(JSON.stringify(events)).not.toContain('concurrent-user-marker')
    service.close()
  })

  it.each([null, -1, 1.5, '1', 9007199254740992])('refuses invalid create baseRevision %s without saving', async baseRevision => {
    const drafts = new PluginDraftService({ dataDir: await tempDir(), installedPlugins: () => [] })
    const result = await createAuthorToolExecutor(drafts).execute({ id: 'save', name: 'create_draft', arguments: JSON.stringify({ manifestJson: manifest('example.note'), source, baseRevision }) })
    expect(result.notice.ok).toBe(false)
    expect((await drafts.inspect()).drafts).toEqual([])
  })

  it('pages summaries and reads the latest complete draft after reopening its store', async () => {
    const directory = await tempDir()
    const options = { dataDir: directory, installedPlugins: () => [] }
    const drafts = new PluginDraftService(options)
    for (let n = 0; n < 7; n++) await drafts.create({ manifestJson: manifest(`example.item-${n}`), source })
    const largeSource = JSON.stringify({ kind: 'host-text-tool', toolId: 'note', label: '保留', text: '原规则'.repeat(6_000) })
    await drafts.create({ manifestJson: manifest('example.item-6'), source: largeSource })
    const executor = createAuthorToolExecutor(new PluginDraftService(options))
    const inspect = (args: unknown) => executor.execute({ id: 'read', name: 'inspect_drafts', arguments: JSON.stringify(args) })
    const first = JSON.parse((await inspect({})).content)
    expect(first.drafts).toHaveLength(4)
    expect(first.pagination.nextOffset).toBe(4)
    const second = JSON.parse((await inspect({ offset: first.pagination.nextOffset })).content)
    expect(second.drafts.map((item: { id: string }) => item.id)).toEqual(['example.item-4', 'example.item-5', 'example.item-6'])
    expect(second.pagination.nextOffset).toBeNull()
    const snapshot = await inspect({ draftId: 'example.item-6' })
    expect(snapshot.content.length).toBeGreaterThan(16_000)
    expect(JSON.parse(snapshot.content)).toMatchObject({ source: largeSource, draft: { revision: 2 }, untrustedData: true, installable: false })
    expect(snapshot.notice).toMatchObject({ ok: true, pendingInstall: false, draft: null })
    expect(JSON.stringify(snapshot.notice)).not.toContain('原规则')
    expect(JSON.stringify([first, second])).not.toContain('原规则')
  })

  it.each(['null', '[]', '{', '{"offset":-1}', '{"offset":1.5}', '{"offset":101}', '{"offset":null}',
    '{"path":"../secret"}', '{"draftId":"../secret"}', '{"draftId":"example.note","offset":0}'])('refuses invalid inspection arguments %s', async raw => {
    const drafts = new PluginDraftService({ dataDir: await tempDir(), installedPlugins: () => [] })
    const result = await createAuthorToolExecutor(drafts).execute({ id: 'bad', name: 'inspect_drafts', arguments: raw })
    expect(result.notice).toMatchObject({ ok: false, pendingInstall: false, draft: null })
  })

  it.each(['secret', 'json-secret', 'wrong-id', 'wrong-revision', 'invalid', 'oversize'])('does not disclose or fall back from a tampered latest draft: %s', async kind => {
    const directory = await tempDir()
    const drafts = new PluginDraftService({ dataDir: directory, installedPlugins: () => [] })
    await drafts.create({ manifestJson: manifest('example.note'), source })
    await drafts.create({ manifestJson: manifest('example.note'), source })
    const file = path.join(directory, 'plugin-drafts', 'example.note', 'revision-2.json')
    const record = JSON.parse(await readFile(file, 'utf8'))
    if (kind === 'secret') record.source = secret
    if (kind === 'json-secret') record.source = JSON.stringify({ apiKey: 'fake-credential-value' })
    if (kind === 'wrong-id') record.manifest.id = 'example.other'
    if (kind === 'wrong-revision') record.revision = 1
    if (kind === 'invalid') record.v = 999
    if (kind === 'oversize') record.source = 'x'.repeat(40_001)
    await writeFile(file, JSON.stringify(record))
    const result = await createAuthorToolExecutor(drafts).execute({ id: 'read', name: 'inspect_drafts', arguments: '{"draftId":"example.note"}' })
    expect(result.notice.ok).toBe(false)
    expect(result.content).not.toContain(secret)
    expect(result.content).not.toContain('fake-credential-value')
    expect(result.content).not.toContain(source)
  })

  it('refuses a draft directory junction outside the private store', async () => {
    const directory = await tempDir()
    const outside = await tempDir()
    const drafts = new PluginDraftService({ dataDir: directory, installedPlugins: () => [] })
    await drafts.create({ manifestJson: manifest('example.note'), source })
    await writeFile(path.join(outside, 'revision-1.json'), JSON.stringify({ v: 1, revision: 1, createdAt: 1, manifest: JSON.parse(manifest('example.link')), source }))
    await symlink(outside, path.join(directory, 'plugin-drafts', 'example.link'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(drafts.readForAuthor('example.link')).rejects.toThrow()
  })

  it('allows repair of invalid non-secret source without executing it', async () => {
    const drafts = new PluginDraftService({ dataDir: await tempDir(), installedPlugins: () => [] })
    const invalidSource = 'globalThis.__mtcAuthorToolRan = true; fetch("https://example.invalid")'
    await drafts.create({ manifestJson: manifest('example.note'), source: invalidSource })
    const result = await createAuthorToolExecutor(drafts).execute({ id: 'read', name: 'inspect_drafts', arguments: '{"draftId":"example.note"}' })
    expect(JSON.parse(result.content)).toMatchObject({ source: invalidSource, draft: { ok: false }, installable: false })
    expect(result.notice).toMatchObject({ ok: true, pendingInstall: false })
    expect((globalThis as { __mtcAuthorToolRan?: boolean }).__mtcAuthorToolRan).toBeUndefined()
  })

  it('rejects an oversized serialized snapshot instead of returning truncated JSON', async () => {
    const drafts = new PluginDraftService({ dataDir: await tempDir(), installedPlugins: () => [] })
    await drafts.create({ manifestJson: manifest('example.note'), source: '\u0000'.repeat(20_000) })
    const result = await createAuthorToolExecutor(drafts).execute({ id: 'read', name: 'inspect_drafts', arguments: '{"draftId":"example.note"}' })
    expect(result.notice.ok).toBe(false)
    expect(result.content).toContain('未返回部分源码')
  })

  it('revises an existing draft in a fresh conversation without leaking source into progress', async () => {
    const original = JSON.stringify({ kind: 'composer-text-action', actionId: 'keep-me', label: '原按钮', text: 'private-draft-marker' })
    const provider: ChatModelProvider = {
      async stream(request, onDelta) {
        const results = request.messages.filter(message => message.role === 'tool')
        if (!results.length) return { toolCalls: [{ id: 'read', name: 'inspect_drafts', arguments: '{"draftId":"example.note"}' }] }
        if (results.length === 1) {
          const snapshot = JSON.parse(results[0]!.content!)
          expect(snapshot.source).toBe(original)
          const program = JSON.parse(snapshot.source)
          program.label = '新按钮'
          return { toolCalls: [{ id: 'edit', name: 'create_draft', arguments: JSON.stringify({ manifestJson: snapshot.manifestJson, source: JSON.stringify(program), baseRevision: snapshot.draft.revision }) }] }
        }
        if (results.length === 2) return { toolCalls: [{ id: 'check', name: 'validate_draft', arguments: '{"draftId":"example.note"}' }] }
        onDelta('草稿修改完成，等待用户确认')
        return { toolCalls: [] }
      },
    }
    const { service, drafts, events } = await createLoop(provider)
    await drafts.create({ manifestJson: manifest('example.note'), source: original })
    service.start(startInput(), event => events.push(event))
    await waitFor(() => events.some(event => event.event === 'model.chat.completed'))
    const revised = await drafts.readForAuthor('example.note')
    expect(revised.draft.revision).toBe(2)
    expect(JSON.parse(revised.source)).toMatchObject({ actionId: 'keep-me', label: '新按钮', text: 'private-draft-marker' })
    expect(JSON.stringify(events)).not.toContain('private-draft-marker')
    expect(events.filter(event => event.event === 'model.authorTool' && event.payload.tool === 'inspect_drafts').every(event => event.event === 'model.authorTool' && !event.payload.pendingInstall)).toBe(true)
  })

  it('creates a draft from a model tool call without executing its source', async () => {
    const seen: string[] = []
    const provider: ChatModelProvider = {
      async stream(request, onDelta) {
        const round = request.messages.filter(message => message.role === 'tool').length
        if (round === 0) {
          return {
            toolCalls: [{
              id: 'call-create',
              name: 'create_draft',
              arguments: JSON.stringify({ manifestJson: manifest('example.note'), source }),
            }],
          }
        }
        if (round === 1) {
          return { toolCalls: [{ id: 'call-validate', name: 'validate_draft', arguments: JSON.stringify({ draftId: 'example.note' }) }] }
        }
        if (round === 2) {
          return { toolCalls: [{ id: 'call-diagnose', name: 'diagnose_draft', arguments: JSON.stringify({ draftId: 'example.note' }) }] }
        }
        seen.push(JSON.stringify(request.messages))
        onDelta('草稿已创建')
        return { toolCalls: [] }
      },
    }
    const { service, drafts, events } = await createLoop(provider)
    await service.setSettings({ providerMode: 'mock', apiKey: secret })
    service.start(startInput(), event => events.push(event))
    await waitFor(() => events.some(event => event.event === 'model.chat.completed'))

    expect(events.at(-1)).toMatchObject({ event: 'model.chat.completed', payload: { text: '草稿已创建' } })
    expect(JSON.stringify(events)).not.toContain(source)
    expect(JSON.stringify(events)).not.toContain(secret)
    expect(seen.join('\n')).toContain('尚未安装')
    expect(seen.join('\n')).not.toContain(source)
    expect(seen.join('\n')).not.toContain(secret)
    const toolEvents = events.filter(event => event.event === 'model.authorTool')
    expect(toolEvents.map(event => `${event.payload.phase}:${event.payload.tool}`)).toEqual([
      'started:create_draft',
      'finished:create_draft',
      'started:validate_draft',
      'finished:validate_draft',
      'started:diagnose_draft',
      'finished:diagnose_draft',
    ])
    for (const event of toolEvents) {
      if (event.payload.phase === 'finished') {
        expect(event.payload.pendingInstall).toBe(true)
        expect(event.payload.ok).toBe(true)
        expect(event.payload.draft).toMatchObject({ id: 'example.note' })
      }
      else {
        expect(event.payload.pendingInstall).toBe(false)
        expect(event.payload.draft).toBeNull()
        expect(event.payload.summary.startsWith('正在')).toBe(true)
      }
    }
    expect((globalThis as { __mtcAuthorToolRan?: boolean }).__mtcAuthorToolRan).toBeUndefined()
    const inspection = await drafts.inspect()
    expect(inspection.drafts.map(draft => draft.id)).toEqual(['example.note'])
    expect(JSON.stringify(inspection)).not.toContain(source)
  })

  it('refuses a model install request and leaves the draft uninstalled', async () => {
    const seen: string[] = []
    const provider: ChatModelProvider = {
      async stream(request, onDelta) {
        const round = request.messages.filter(message => message.role === 'tool').length
        if (round === 0) {
          return { toolCalls: [{ id: 'call-install', name: 'install_draft', arguments: JSON.stringify({ draftId: 'example.note' }) }] }
        }
        seen.push(JSON.stringify(request.messages))
        onDelta('没有安装')
        return { toolCalls: [] }
      },
    }
    const { service, drafts, events } = await createLoop(provider)
    service.start(startInput(), event => events.push(event))
    await waitFor(() => events.some(event => event.event === 'model.chat.completed'))
    expect(events.at(-1)).toMatchObject({ payload: { text: '没有安装' } })
    expect(seen.join('\n')).toContain('模型不能安装插件')
    expect(seen.join('\n')).not.toContain(source)
    const finished = events.filter(event => event.event === 'model.authorTool' && event.payload.phase === 'finished')
    expect(finished).toHaveLength(1)
    expect(finished[0]?.payload).toMatchObject({
      tool: 'install_draft',
      ok: false,
      pendingInstall: false,
      draft: null,
    })
    expect(finished[0]?.payload.summary).toContain('模型不能安装插件')
    expect((await drafts.inspect()).installed).toEqual([])
    expect((await drafts.inspect()).drafts).toEqual([])
  })

  it('sends author tools to an OpenAI-compatible model and returns a redacted inspect result', async () => {
    const directory = await tempDir()
    const drafts = new PluginDraftService({ dataDir: directory, installedPlugins: () => [] })
    await drafts.create({ manifestJson: manifest('example.note'), source })
    const bodies: Array<{ messages: unknown; tools?: Array<{ function?: { name?: string } }> }> = []
    let round = 0
    const fetchImpl: typeof fetch = async (_input, init) => {
      round += 1
      bodies.push(JSON.parse(String(init?.body)) as { messages: unknown; tools?: Array<{ function?: { name?: string } }> })
      const payload = round === 1
        ? { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-inspect', type: 'function', function: { name: 'inspect_drafts', arguments: '{}' } }] } }] }
        : { choices: [{ delta: { content: '草稿已检查' } }] }
      return sse(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n`)
    }
    const service = new ModelService({
      dataDir: directory,
      generation: 2,
      authorTools: createAuthorToolExecutor(drafts),
      providers: { 'openai-compatible': createOpenAiCompatibleProvider(fetchImpl) },
    })
    await service.load()
    await service.setSettings({ providerMode: 'openai-compatible', apiKey: secret, baseUrl: 'https://api.deepseek.com' })
    const events: HostEventMessage[] = []
    service.start(startInput(), event => events.push(event))
    await waitFor(() => events.some(event => event.event === 'model.chat.completed'))

    expect(events.at(-1)).toMatchObject({ payload: { text: '草稿已检查' } })
    expect(JSON.stringify(events)).not.toContain(source)
    expect(JSON.stringify(events)).not.toContain(secret)
    expect(bodies[0]?.tools?.map(tool => tool.function?.name)).toEqual(['inspect_drafts', 'create_draft', 'validate_draft', 'diagnose_draft'])
    const inspected = events.find(event => event.event === 'model.authorTool' && event.payload.phase === 'finished')
    expect(inspected?.payload).toMatchObject({ tool: 'inspect_drafts', ok: true, pendingInstall: false, draft: null })
    expect(inspected?.payload.summary).toContain('1')
    expect(JSON.stringify(bodies[1]?.messages)).toContain('example.note')
    expect(JSON.stringify(bodies[1]?.messages)).not.toContain(source)
    expect(JSON.stringify(bodies)).not.toContain(secret)
    expect((globalThis as { __mtcAuthorToolRan?: boolean }).__mtcAuthorToolRan).toBeUndefined()
  })

  it('stops after the tool-call limit without running draft source', async () => {
    const provider: ChatModelProvider = {
      async stream() {
        return { toolCalls: [{ id: 'call-inspect', name: 'inspect_drafts', arguments: '{}' }] }
      },
    }
    const { service, events } = await createLoop(provider)
    service.start(startInput(), event => events.push(event))
    await waitFor(() => events.some(event => event.event === 'model.chat.failed'))
    expect(events.some(event => event.event === 'model.chat.completed')).toBe(false)
    expect(JSON.stringify(events)).toContain('插件作者工具调用次数已达上限')
    expect((globalThis as { __mtcAuthorToolRan?: boolean }).__mtcAuthorToolRan).toBeUndefined()
  })

  it('reports a missing draft as a failure and does not mark it pending', async () => {
    const provider: ChatModelProvider = {
      async stream(request, onDelta) {
        const round = request.messages.filter(message => message.role === 'tool').length
        if (round === 0) {
          return { toolCalls: [{ id: 'call-missing', name: 'validate_draft', arguments: JSON.stringify({ draftId: 'missing.draft' }) }] }
        }
        onDelta('没有这份草稿')
        return { toolCalls: [] }
      },
    }
    const { service, events } = await createLoop(provider)
    service.start(startInput(), event => events.push(event))
    await waitFor(() => events.some(event => event.event === 'model.chat.completed'))
    const finished = events.find(event => event.event === 'model.authorTool' && event.payload.phase === 'finished')
    expect(finished?.payload).toMatchObject({
      tool: 'validate_draft',
      ok: false,
      pendingInstall: false,
      draft: null,
    })
    expect(finished?.payload.summary).toContain('没有找到')
    expect(JSON.stringify(events)).not.toContain(source)
    expect(JSON.stringify(events)).not.toContain(secret)
  })

  it('keeps the mock reply path when the model does not call a tool', async () => {
    const directory = await tempDir()
    let calls = 0
    const service = new ModelService({
      dataDir: directory,
      generation: 3,
      authorTools: {
        async execute() {
          calls += 1
          return {
            content: '不应调用',
            notice: { tool: 'unknown' as const, ok: false, summary: '不应调用', pendingInstall: false, draft: null },
          }
        },
      },
      providers: { mock: createMockProvider() },
    })
    await service.load()
    const events: HostEventMessage[] = []
    service.start(startInput(), event => events.push(event))
    await waitFor(() => events.some(event => event.event === 'model.chat.completed'))
    expect(calls).toBe(0)
    expect(events.at(-1)?.event).toBe('model.chat.completed')
  })
})

async function createLoop(provider: ChatModelProvider): Promise<{ service: ModelService; drafts: PluginDraftService; events: HostEventMessage[] }> {
  const directory = await tempDir()
  const drafts = new PluginDraftService({ dataDir: directory, installedPlugins: () => [] })
  const service = new ModelService({
    dataDir: directory,
    generation: 1,
    authorTools: createAuthorToolExecutor(drafts),
    providers: { mock: provider },
  })
  await service.load()
  const events: HostEventMessage[] = []
  return { service, drafts, events }
}

function startInput() {
  return {
    streamId: 'stream-author',
    conversationId: 'conversation-author',
    assistantMessageId: 'assistant-author',
    messages: [{ role: 'user' as const, content: '请处理插件草稿' }],
  }
}

function manifest(id: string): string {
  return JSON.stringify({
    manifestVersion: 1,
    id,
    version: '0.1.0',
    displayName: '草稿示例',
    description: '只保存在草稿目录，不会被安装。',
    targets: ['pc-host'],
    engine: { moreThanChat: '^0.1.0' },
    permissions: [],
    services: { requires: ['host.tools'] },
  })
}

function sse(text: string): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'mtc-author-'))
  await chmod(directory, 0o700)
  directories.push(directory)
  return directory
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 2_000) throw new Error('timed out waiting for the model loop')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
