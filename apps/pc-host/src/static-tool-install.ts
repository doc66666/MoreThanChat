import type { PluginDraftInstallResult, PluginDraftIssue } from '@more-than-chat/protocol'
import type { InstalledStaticToolStore } from './installed-static-tools'
import { PluginDraftService } from './plugin-drafts'
import { HostPluginService, StaticToolInstallError } from './plugin-service'

/** Installs a confirmed declarative text tool. Draft source is never loaded or executed. */
export async function installConfirmedTextTool(options: {
  drafts: PluginDraftService
  plugins: HostPluginService
  store?: InstalledStaticToolStore
  draftId: string
  confirmed: boolean
}): Promise<PluginDraftInstallResult> {
  const plan = await options.drafts.planInstall(options.draftId, options.confirmed)
  if (!plan.installable) {
    return {
      installed: false,
      draft: plan.draft,
      ok: false,
      summary: plan.summary,
      issues: plan.issues,
      catalog: options.plugins.catalog(),
    }
  }
  try {
    const store = options.store
    const catalog = store
      ? await options.plugins.installStaticTool(plan.manifest, plan.tool, async () => {
          await store.save({ v: 1, enabled: true, manifest: plan.manifest, tool: plan.tool })
        })
      : await options.plugins.installStaticTool(plan.manifest, plan.tool)
    return {
      installed: true,
      draft: plan.draft,
      ok: true,
      summary: '已安装声明式文本工具。现在可以在输入框使用，也可以停用。源码没有被执行。',
      issues: [],
      catalog,
    }
  }
  catch (error) {
    const catalog = options.plugins.catalog()
    if (error instanceof StaticToolInstallError && error.reason === 'already-installed') {
      return {
        installed: false,
        draft: plan.draft,
        ok: false,
        summary: '没有安装：这个 id 已经安装，草稿不会替换它。',
        issues: [installIssue('INSTALLED_ID', '插件已经安装。这份草稿不会替换它。')],
        catalog,
      }
    }
    if (error instanceof StaticToolInstallError) {
      const persisted = error.reason === 'persist-failed'
      return {
        installed: false,
        draft: plan.draft,
        ok: false,
        summary: persisted
          ? '没有安装：声明式文本工具未能保存，已撤回。源码没有被执行。'
          : '没有安装：声明式文本工具未能启用。源码没有被执行。',
        issues: [installIssue('NOT_INSTALLABLE', persisted ? '声明式文本工具没有保存。' : '声明式文本工具没有启用。')],
        catalog,
      }
    }
    throw error
  }
}

function installIssue(code: PluginDraftIssue['code'], message: string): PluginDraftIssue {
  return { severity: 'error', code, message }
}
