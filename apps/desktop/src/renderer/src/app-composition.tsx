import { createElement, type ReactNode, type ComponentProps } from 'react'
import type {
  PluginContext,
  PluginSource,
  UiSurfaceInput,
  UiSurfaceRegistry,
} from '@more-than-chat/plugin-runtime'
import { useWorkspaceController, type WorkspaceViewContext } from './workspace-controller'
import { workspaceViews } from './workspace-views'
import { LoadingScreen, MessageBubble } from './workspace-components'
import {MessageBodyView,MarkdownMessageView,PlainMessageView,AttachmentMessageView,type MessageViewContext,type MessageSurfaceRenderer} from './message-content'
import { UiSurface } from './UiSurface'
import { pluginRuntime, uiSurfaceRegistry } from './plugin-host'
import { startAppearance } from './theme'
import baseStyles from './styles.css?inline'
import themeStyles from './design-system.css?inline'

export function builtinSource(
  id: string,
  displayName: string,
  requires: string[],
  provides: string[],
  activate: (context: PluginContext) => void | Promise<void>,
): PluginSource {
  const manifest = {
    manifestVersion: 1,
    id,
    version: '0.1.0',
    displayName,
    description: '默认应用组合 · 可替换和热更新',
    targets: ['pc-ui'],
    permissions: ['client.trusted'],
    engine: { moreThanChat: '^0.1.0' },
    services: { requires, provides },
  } as const
  return { manifest, trust: 'builtin', load: async () => ({ manifest, activate }) }
}

// A provider may decorate the native bridge or replace a subset of capabilities.
const partitions = {
  'chat.api':
    /^(accessChat|loadState|saveState|onCentralChat|sendCentralMessage|setReadingConversation|retryChatMessage|setConversationOptions|onOpenConversation|getPendingNavigation|navigationApplied)$/,
  'contacts.api':
    /^(getServerState|connectServer|disconnectServer|onServerState|serverAction|updateUserProfile|copyUserId)$/,
  'history.api': /^(getChat|searchChat|copyChat|retractChat|forwardChat|getFirstUnread|.*History)/,
  'model.api': /^(.*Model|.*Generation|.*Credential)/,
  'plugins.api': /^(.*Plugin|.*Draft)/,
} as const
const labels: Record<string, string> = {
  workspace: '工作区布局',
  'workspace.chrome': '窗口状态栏',
  'workspace.navigation': '主导航',
  'workspace.conversations': '会话列表',
  'workspace.chat': '聊天布局',
  'workspace.chat.header': '聊天标题',
  'workspace.chat.notices': '阅读与连接提示',
  'workspace.chat.timeline': '消息时间线',
  'workspace.chat.latest': '最新消息导航',
  'workspace.chat.composer': '消息输入区',
  'workspace.details': '会话详情',
  'workspace.plugins': '插件管理',
  'workspace.new-chat': '新建会话',
  'workspace.settings': '设置',
  'workspace.forward': '转发消息',
  'workspace.retract': '撤回消息',
  'workspace.search': '聊天搜索',
  'workspace.server': '服务器与身份',
  'workspace.contacts': '通讯录',
  'workspace.profile': '用户主页',
  'workspace.toast': '轻提示',
}
function DefaultApplication({ useController }: { useController: typeof useWorkspaceController }) {
  const state = useController()
  if (state.kind === 'loading')
    return (
      <UiSurface
        registry={uiSurfaceRegistry}
        name="application.loading"
        context={state}
        composition={pluginRuntime}
      />
    )
  return (
    <UiSurface
      registry={uiSurfaceRegistry}
      name="root"
      context={{
        ...state.slotContext,
        messages: state.visibleMessages,
        conversations: state.readyState.conversations,
        selectConversation: state.selectConversation,
        workspace: state,
      }}
      composition={pluginRuntime}
    />
  )
}
function messageSources():PluginSource[]{
  const views:{name:string;label:string;render:(input:UiSurfaceInput)=>unknown}[]=[
    {name:'message',label:'默认消息气泡',render:({context,renderSurface})=>createElement(MessageBubble,{...context as ComponentProps<typeof MessageBubble>,renderSurface:renderSurface as MessageSurfaceRenderer})},
    {name:'message.body',label:'消息正文格式分派',render:({context,renderSurface})=>createElement(MessageBodyView,{context:context as MessageViewContext,renderSurface:renderSurface as MessageSurfaceRenderer})},
    {name:'message.body.markdown',label:'Markdown 消息渲染',render:({context})=>createElement(MarkdownMessageView,{context:context as MessageViewContext})},
    {name:'message.body.plain',label:'纯文本消息渲染',render:({context})=>createElement(PlainMessageView,{context:context as MessageViewContext})},
    {name:'message.attachment',label:'图片、语音与文件消息渲染',render:({context})=>createElement(AttachmentMessageView,{context:context as MessageViewContext})},
  ]
  return views.map(view=>builtinSource('builtin.ui.'+view.name,view.label,['ui.surfaces'],[],ctx=>{
    ctx.contribute(ctx.getService<UiSurfaceRegistry>('ui.surfaces'),{id:'default',surface:view.name,priority:10000,render:view.render})
  }))
}
export const appSources: PluginSource[] = [
  ...messageSources(),
  builtinSource('builtin.ui.theme', '默认外观', [], [], (context) => {
    const style = document.createElement('style')
    style.dataset.pluginStyle = context.manifest.id
    style.textContent = baseStyles + '\n' + themeStyles
    document.head.append(style)
    context.effect(() => style.remove())
    context.effect(startAppearance())
  }),
  ...Object.entries(partitions).map(([service, pattern]) =>
    builtinSource('builtin.' + service, service, [], [service], (context) => {
      context.provideService(
        service,
        Object.fromEntries(
          Object.entries(window.moreThanChat).filter(([key]) => pattern.test(key)),
        ),
      )
    }),
  ),
  builtinSource(
    'builtin.desktop-api',
    '客户端服务组合',
    Object.keys(partitions),
    ['desktop.api'],
    (context) => {
      const native = window.moreThanChat,
        providers = Object.assign(
          {},
          ...Object.keys(partitions).map((key) => context.getService(key)),
        )
      context.provideService(
        'desktop.api',
        new Proxy(providers, {
          get(target, key) {
            return key in target ? Reflect.get(target, key) : Reflect.get(native, key)
          },
        }),
      )
    },
  ),
  builtinSource(
    'builtin.workspace-controller',
    '聊天状态与操作',
    ['desktop.api'],
    ['workspace.controller'],
    (context) => {
      context.provideService('workspace.controller', useWorkspaceController)
    },
  ),
  builtinSource(
    'builtin.application',
    '默认聊天应用',
    ['ui.surfaces', 'workspace.controller'],
    [],
    (context) => {
      const useController =
        context.getService<typeof useWorkspaceController>('workspace.controller')
      context.contribute(context.getService<UiSurfaceRegistry>('ui.surfaces'), {
        id: 'default',
        surface: 'application',
        priority: 10000,
        render: () => (
          <DefaultApplication
            key={controllerIdentity(useController)}
            useController={useController}
          />
        ),
      })
    },
  ),
  builtinSource('builtin.ui.loading', '启动提示', ['ui.surfaces'], [], (context) => {
    context.contribute(context.getService<UiSurfaceRegistry>('ui.surfaces'), {
      id: 'default',
      surface: 'application.loading',
      priority: 10000,
      render: ({ context }: UiSurfaceInput) => (
        <LoadingScreen error={(context as { error: boolean }).error} />
      ),
    })
  }),
  builtinSource('builtin.ui.root', '默认根视图', ['ui.surfaces'], [], (context) => {
    context.contribute(context.getService<UiSurfaceRegistry>('ui.surfaces'), {
      id: 'default',
      surface: 'root',
      priority: 10000,
      render: ({ context, renderSurface }: UiSurfaceInput) =>
        renderSurface('workspace', (context as { workspace: WorkspaceViewContext }).workspace),
    })
  }),
  ...workspaceViews.map(({ surface, component }) =>
    builtinSource(
      'builtin.ui.' + surface,
      labels[surface] ?? surface,
      ['ui.surfaces', 'desktop.api'],
      [],
      (context) => {
        context.contribute(context.getService<UiSurfaceRegistry>('ui.surfaces'), {
          id: 'default',
          surface,
          priority: 10000,
          render: ({ context, renderSurface }: UiSurfaceInput) =>
            createElement(component, {
              context: context as WorkspaceViewContext,
              renderSurface: renderSurface as (
                name: string,
                context?: unknown,
                fallback?: unknown,
              ) => ReactNode,
            }),
        })
      },
    ),
  ),
]
const controllerIds = new WeakMap<Function, number>()
let nextControllerId = 0
function controllerIdentity(controller: Function) {
  if (!controllerIds.has(controller)) controllerIds.set(controller, ++nextControllerId)
  return controllerIds.get(controller)
}

const preferenceKey = 'application.plugins.v1'
let preferenceTail: Promise<void> = Promise.resolve()
function changePreferences(work: () => Promise<void>): Promise<void> {
  const task = preferenceTail.then(work, work)
  preferenceTail = task.catch(() => undefined)
  return task
}
export function disabledBuiltins(): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(preferenceKey) ?? '[]')
    return new Set(Array.isArray(value) ? value.filter((id) => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}
export async function setBuiltinEnabled(id: string, enabled: boolean) {
  return changePreferences(async () => {
    const disabled = disabledBuiltins()
    const wasDisabled = disabled.has(id)
    if (enabled) disabled.delete(id)
    else disabled.add(id)
    if (enabled) {
      await pluginRuntime.activate(id)
      try { localStorage.setItem(preferenceKey, JSON.stringify([...disabled])) }
      catch (error) { if (wasDisabled) await pluginRuntime.deactivate(id); throw error }
    } else {
      localStorage.setItem(preferenceKey, JSON.stringify([...disabled]))
      await pluginRuntime.deactivate(id)
    }
  })
}
export async function restoreDefaultComposition() {
  return changePreferences(async () => {
    await window.moreThanChat.restoreAppPlugins?.()
    localStorage.removeItem(preferenceKey)
    await pluginRuntime.start(
      pluginRuntime
        .list()
        .filter((p) => p.trust === 'builtin')
        .map((p) => p.manifest.id),
    )
  })
}
