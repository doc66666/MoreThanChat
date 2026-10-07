import {
  ContributionRegistry,
  composerActionsServiceId,
  definePlugin,
  type ComposerAction,
} from '@more-than-chat/plugin-runtime'
import { helloWorldManifest } from './manifest.js'

export default definePlugin({
  manifest: helloWorldManifest,
  activate(context) {
    const actions = context.getService<ContributionRegistry<ComposerAction>>(composerActionsServiceId)
    context.contribute(actions, {
      id: 'insert-greeting',
      label: '问候',
      description: '插入“你好，插件！”作为一条待发送消息',
      run: ({ draft }) => {
        const greeting = '你好，插件！ 👋'
        return {
          draft: draft.trim() ? `${draft}\n${greeting}` : greeting,
          notice: '“快捷问候”插件已写入输入框',
        }
      },
    })
  },
  healthCheck(context) {
    context.getService(composerActionsServiceId)
  },
})
