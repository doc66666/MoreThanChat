import { describe, expect, it } from 'vitest'
import {
  ContributionRegistry,
  PluginRuntime,
  composerActionsServiceId,
  type ComposerAction,
} from '@more-than-chat/plugin-runtime'
import { helloWorldManifest } from '../src/manifest.js'

describe('quick greeting plugin', () => {
  it('loads through the runtime, executes, and leaves no contribution after deactivation', async () => {
    const actions = new ContributionRegistry<ComposerAction>()
    const runtime = new PluginRuntime({
      target: 'pc-ui',
      services: { [composerActionsServiceId]: actions },
    })
    runtime.install({
      manifest: helloWorldManifest,
      trust: 'builtin',
      load: () => import('../src/index.js'),
    })

    await runtime.activate(helloWorldManifest.id)
    const action = actions.list()[0]?.contribution
    expect(action).toBeDefined()
    const result = await action?.run({
      draft: '',
      conversationId: 'conversation-test',
      conversationTitle: 'Test',
      now: 1,
    })
    expect(result).toEqual({
      draft: '你好，插件！ 👋',
      notice: '“快捷问候”插件已写入输入框',
    })

    await runtime.deactivate(helloWorldManifest.id)
    expect(actions.list()).toHaveLength(0)
  })
})
