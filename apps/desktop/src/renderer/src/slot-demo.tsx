import {
  definePlugin,
  uiSlotsServiceId,
  type ContributionRegistry,
  type UiSlotContribution,
  type PluginManifestV1,
} from '@more-than-chat/plugin-runtime'
export const slotDemoManifest = {
  manifestVersion: 1,
  id: 'example.workspace-card',
  version: '0.1.0',
  displayName: '工作区卡片',
  description: '在会话侧栏添加独立卡片，演示输入框之外的插件扩展。',
  targets: ['pc-ui'],
  engine: { moreThanChat: '^0.1.0' },
  permissions: [],
  services: { requires: [uiSlotsServiceId] },
} as const satisfies PluginManifestV1
export const slotDemoPlugin = definePlugin({
  manifest: slotDemoManifest,
  activate(context) {
    context.contribute(
      context.getService<ContributionRegistry<UiSlotContribution>>(
        uiSlotsServiceId,
      ),
      {
        id: 'workspace-card',
        slot: 'app.sidebar',
        render: () => (
          <section
            className="workspace-plugin-card"
            data-plugin-slot-owner="example.workspace-card"
          >
            <strong>工作区插件</strong>
            <p>这是独立的侧栏插件，可在插件面板启停。</p>
          </section>
        ),
      },
    )
  },
})
