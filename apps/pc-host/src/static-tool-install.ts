import type { PluginManifestV1 } from '@more-than-chat/plugin-runtime'
import type { HostPluginCatalog, PluginDraftInstallResult, PluginDraftIssue, PluginDraftSummary } from '@more-than-chat/protocol'
import { InstalledStaticToolStore, type StoredStaticTool } from './installed-static-tools'
import { PluginDraftService, type DraftInstallPlan } from './plugin-drafts'
import { HostPluginService, StaticToolInstallError } from './plugin-service'
import type { DeclarativeTextTool } from './static-text-tool'

type InstallOptions = {
  drafts: PluginDraftService
  plugins: HostPluginService
  store?: InstalledStaticToolStore
  draftId: string
  confirmed: boolean
}

type TextPlan = Extract<DraftInstallPlan, { kind: 'text-tool' }>
type ComposerPlan = Extract<DraftInstallPlan, { kind: 'composer-action' }>

/** Installs a confirmed declarative text tool or composer action. Draft source is never executed. */
export async function installConfirmedTextTool(options: InstallOptions): Promise<PluginDraftInstallResult> {
  const previous = await readUpdatable(options)
  const plan = previous
    ? await options.drafts.planInstall(options.draftId, options.confirmed, { ignoreInstalledId: true })
    : await options.drafts.planInstall(options.draftId, options.confirmed)
  if (!plan.installable) return refused(plan.draft, plan.summary, plan.issues, options.plugins.catalog())
  if (plan.kind === 'composer-action') return installComposer(options, plan, previous)
  if (!previous || !options.store) return installFirst(options, plan)
  return installUpdate(options, plan, previous, options.store)
}

async function readUpdatable(options: InstallOptions): Promise<StoredStaticTool | null> {
  if (!options.store || !options.plugins.isStaticInstall(options.draftId)) return null
  const record = await options.store.read(options.draftId)
  return record && record.manifest.id === options.draftId ? record : null
}

async function installComposer(
  options: InstallOptions,
  plan: ComposerPlan,
  previous: StoredStaticTool | null,
): Promise<PluginDraftInstallResult> {
  if (previous) {
    return refused(plan.draft, '没有安装：这个 id 已经安装，草稿不会替换它。', [
      installIssue('INSTALLED_ID', '插件已经安装。这份草稿不会替换它。'),
    ], options.plugins.catalog())
  }
  try {
    const catalog = await options.plugins.installStaticComposerAction(plan.manifest, plan.action)
    return {
      installed: true,
      draft: plan.draft,
      ok: true,
      summary: '已安装声明式输入框动作。现在可以在输入框使用，也可以停用。源码没有被执行。',
      issues: [],
      catalog,
    }
  }
  catch (error) {
    return installFailure(plan.draft, error, options.plugins.catalog(), '输入框动作')
  }
}

async function installFirst(options: InstallOptions, plan: TextPlan): Promise<PluginDraftInstallResult> {
  try {
    const store = options.store
    const catalog = store
      ? await options.plugins.installStaticTool(plan.manifest, plan.tool, async () => {
          await store.save({ v: 1, revision: 1, enabled: true, manifest: plan.manifest, tool: plan.tool })
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
    return installFailure(plan.draft, error, options.plugins.catalog(), '文本工具')
  }
}

async function installUpdate(
  options: InstallOptions,
  plan: TextPlan,
  previous: StoredStaticTool,
  store: InstalledStaticToolStore,
): Promise<PluginDraftInstallResult> {
  const nextRevision = previous.revision + 1
  if (!Number.isSafeInteger(nextRevision) || plan.manifest.id !== previous.manifest.id) {
    return refused(plan.draft, '没有更新：当前版本仍在使用。源码没有被执行。', [
      installIssue('NOT_INSTALLABLE', '声明式文本工具没有更新。'),
    ], options.plugins.catalog())
  }
  try {
    await store.preserveVersion(previous)
  }
  catch {
    return refused(plan.draft, '没有更新：上一版本未能封存，当前版本仍在使用。源码没有被执行。', [
      installIssue('NOT_INSTALLABLE', '上一版本没有封存。'),
    ], options.plugins.catalog())
  }
  try {
    await options.plugins.uninstall(previous.manifest.id)
    let catalog = await options.plugins.installStaticTool(plan.manifest, plan.tool, async () => {
      await store.save(nextRecord(previous, plan.manifest, plan.tool, nextRevision))
    })
    if (!previous.enabled) catalog = await options.plugins.setEnabled(previous.manifest.id, false)
    return {
      installed: true,
      draft: plan.draft,
      ok: true,
      summary: '已更新声明式文本工具。现在使用新版本，源码没有被执行。',
      issues: [],
      catalog,
    }
  }
  catch {
    return recoverPrevious(options, plan, previous, store)
  }
}

async function recoverPrevious(
  options: InstallOptions,
  plan: TextPlan,
  previous: StoredStaticTool,
  store: InstalledStaticToolStore,
): Promise<PluginDraftInstallResult> {
  try {
    await options.plugins.uninstall(previous.manifest.id)
    let catalog = await options.plugins.installStaticTool(previous.manifest, previous.tool, async () => {
      await store.saveCurrent(previous)
    })
    if (!previous.enabled) catalog = await options.plugins.setEnabled(previous.manifest.id, false)
    return refused(plan.draft, '更新没有完成，已恢复上一版本。源码没有被执行。', [
      installIssue('NOT_INSTALLABLE', '更新没有完成，已恢复上一版本。'),
    ], catalog)
  }
  catch {
    return refused(plan.draft, '更新没有完成，上一版本也未能恢复。源码没有被执行。', [
      installIssue('NOT_INSTALLABLE', '上一版本未能恢复。'),
    ], options.plugins.catalog())
  }
}

function installFailure(
  draft: PluginDraftSummary,
  error: unknown,
  catalog: HostPluginCatalog,
  label: '文本工具' | '输入框动作',
): PluginDraftInstallResult {
  if (error instanceof StaticToolInstallError && error.reason === 'already-installed') {
    return refused(draft, '没有安装：这个 id 已经安装，草稿不会替换它。', [
      installIssue('INSTALLED_ID', '插件已经安装。这份草稿不会替换它。'),
    ], catalog)
  }
  if (error instanceof StaticToolInstallError) {
    const persisted = error.reason === 'persist-failed'
    return refused(
      draft,
      persisted
        ? `没有安装：声明式${label}未能保存，已撤回。源码没有被执行。`
        : `没有安装：声明式${label}未能启用。源码没有被执行。`,
      [installIssue('NOT_INSTALLABLE', persisted ? `声明式${label}没有保存。` : `声明式${label}没有启用。`)],
      catalog,
    )
  }
  throw error
}

function nextRecord(
  previous: StoredStaticTool,
  manifest: PluginManifestV1,
  tool: DeclarativeTextTool,
  revision: number,
): StoredStaticTool {
  return { v: 1, revision, enabled: previous.enabled, manifest, tool }
}

function refused(
  draft: PluginDraftSummary,
  summary: string,
  issues: readonly PluginDraftIssue[],
  catalog: HostPluginCatalog,
): PluginDraftInstallResult {
  return { installed: false, draft, ok: false, summary, issues: issues.slice(0, 20), catalog }
}

function installIssue(code: PluginDraftIssue['code'], message: string): PluginDraftIssue {
  return { severity: 'error', code, message }
}
