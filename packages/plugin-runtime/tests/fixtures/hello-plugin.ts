import {
  ContributionRegistry,
  definePlugin,
  type PluginContext,
} from '../../src/index.js'
import { fixtureManifest } from './hello-manifest.js'

export interface TestAction {
  readonly id: string
  run(): string
}

export default definePlugin({
  manifest: fixtureManifest,
  activate(context: PluginContext) {
    const actions = context.getService<ContributionRegistry<TestAction>>('test.actions')
    context.effect(actions.register(context.manifest.id, {
      id: 'say-hello',
      run: () => '你好，插件！',
    }))
  },
})
