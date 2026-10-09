import { chmod, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { validatePluginManifest, type PluginManifestV1 } from '@more-than-chat/plugin-runtime'
import type {
  PluginDraftCreateResult,
  PluginDraftInspection,
  PluginDraftIssue,
  PluginDraftIssueCode,
  PluginDraftReport,
  PluginDraftSummary,
} from '@more-than-chat/protocol'
import { isStaticTextToolManifest, parseDeclarativeTextTool, type DeclarativeTextTool } from './static-text-tool'

export class PluginDraftError extends Error {
  constructor(readonly code: 'DRAFT_NOT_FOUND', message: string) {
    super(message)
    this.name = 'PluginDraftError'
  }
}

export interface InstalledPluginRef {
  id: string
  version: string
  displayName: string
  status: PluginDraftInspection['installed'][number]['status']
}

const draftRootName = 'plugin-drafts'
const dangerousApis: readonly { name: string; pattern: RegExp }[] = [
  { name: 'eval', pattern: /\beval\s*\(/ },
  { name: 'Function', pattern: /\bFunction\s*\(/ },
  { name: 'require', pattern: /\brequire\s*\(/ },
  { name: 'process', pattern: /\bprocess\b/ },
  { name: 'child_process', pattern: /\bchild_process\b/ },
  { name: 'fs', pattern: /\b(?:node:)?fs\b/ },
  { name: 'fetch', pattern: /\bfetch\s*\(/ },
  { name: 'XMLHttpRequest', pattern: /\bXMLHttpRequest\b/ },
  { name: 'WebSocket', pattern: /\bWebSocket\b/ },
]

/** Stores immutable plugin drafts beside installed plugins and never loads them. */
export class PluginDraftService {
  readonly #root: string
  readonly #installedPlugins: () => readonly InstalledPluginRef[]
  #tail: Promise<unknown> = Promise.resolve()

  constructor(options: { dataDir: string; installedPlugins: () => readonly InstalledPluginRef[] }) {
    this.#root = path.resolve(options.dataDir, draftRootName)
    this.#installedPlugins = options.installedPlugins
  }

  inspect(): Promise<PluginDraftInspection> {
    return this.#enqueue(async () => ({
      installed: this.#installedPlugins().slice(0, 100).map(plugin => ({
        id: clamp(plugin.id, 128, 'plugin'),
        version: clamp(plugin.version, 32, '0.0.0'),
        displayName: clamp(plugin.displayName, 80, plugin.id || '插件'),
        status: plugin.status,
      })),
      drafts: await this.#listSummaries(),
    }))
  }

  create(input: { manifestJson: string; source: string }): Promise<PluginDraftCreateResult> {
    return this.#enqueue(async () => {
      const assessed = assessDraft(input.manifestJson, input.source, this.#installedPlugins())
      if (!assessed.manifest || assessed.blocked) {
        return {
          persisted: false,
          draft: null,
          ok: false,
          summary: assessed.blocked
            ? '草稿没有保存：内容里疑似有凭据。'
            : '草稿没有保存：manifest 无效。',
          issues: assessed.issues,
        }
      }
      const revision = await this.#nextRevision(assessed.manifest.id)
      const updatedAt = Date.now()
      const record = {
        v: 1 as const,
        revision,
        createdAt: updatedAt,
        manifest: assessed.manifest,
        source: input.source,
        ok: assessed.ok,
      }
      await this.#writeRevision(assessed.manifest.id, record)
      const draft = summaryOf(assessed.manifest, revision, updatedAt, assessed.ok)
      return { persisted: true, draft, ok: assessed.ok, summary: summaryText('create', assessed), issues: assessed.issues }
    })
  }

  validate(draftId: string): Promise<PluginDraftReport> {
    return this.#report(draftId, 'validate')
  }

  diagnose(draftId: string): Promise<PluginDraftReport> {
    return this.#report(draftId, 'diagnose')
  }

  /** Plans a declarative install. The returned tool text is data; the source is not executable code. */
  planInstall(draftId: string, confirmed: boolean, options?: { readonly ignoreInstalledId?: boolean }): Promise<DraftInstallPlan> {
    return this.#enqueue(async () => {
      const stored = await this.#readLatest(draftId)
      const assessed = assessDraft(JSON.stringify(stored.manifest), stored.source, this.#installedPlugins())
      if (!assessed.manifest) throw new PluginDraftError('DRAFT_NOT_FOUND', '没有找到这份插件草稿。')
      const draft = summaryOf(assessed.manifest, stored.revision, stored.createdAt, assessed.ok)
      const issues = installBlockers(assessed, stored.source, options?.ignoreInstalledId === true)
      if (issues.length > 0) {
        return { installable: false, draft, summary: refusalSummary(issues), issues: issues.slice(0, 20) }
      }
      if (!confirmed) {
        return {
          installable: false,
          draft,
          summary: '需要确认后才会安装。源码不会被执行。',
          issues: [finding('error', 'CONFIRMATION_REQUIRED', '安装声明式文本工具需要明确确认。')],
        }
      }
      const tool = parseDeclarativeTextTool(stored.source)
      if (!tool || !isStaticTextToolManifest(assessed.manifest)) {
        return {
          installable: false,
          draft,
          summary: '没有安装：这不是声明式文本工具，源码也没有执行。',
          issues: [finding('error', 'NOT_DECLARATIVE', '草稿不是声明式文本工具，源码没有执行。')],
        }
      }
      return { installable: true, manifest: assessed.manifest, tool, draft }
    })
  }

  async #report(draftId: string, kind: 'validate' | 'diagnose'): Promise<PluginDraftReport> {
    return this.#enqueue(async () => {
      const stored = await this.#readLatest(draftId)
      const manifestJson = JSON.stringify(stored.manifest)
      const assessed = assessDraft(manifestJson, stored.source, this.#installedPlugins())
      if (!assessed.manifest) throw new PluginDraftError('DRAFT_NOT_FOUND', '没有找到这份插件草稿。')
      const draft = summaryOf(assessed.manifest, stored.revision, stored.createdAt, assessed.ok)
      return { draft, ok: assessed.ok, summary: summaryText(kind, assessed), issues: assessed.issues }
    })
  }

  async #listSummaries(): Promise<PluginDraftSummary[]> {
    let names: string[]
    try {
      names = await readdir(this.#root)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const summaries: PluginDraftSummary[] = []
    for (const name of names) {
      if (!isDraftId(name)) continue
      try {
        const stored = await this.#readLatest(name)
        const assessed = assessDraft(JSON.stringify(stored.manifest), stored.source, this.#installedPlugins())
        if (!assessed.manifest) continue
        summaries.push(summaryOf(assessed.manifest, stored.revision, stored.createdAt, assessed.ok))
      }
      catch {
        // Skip an unreadable revision instead of returning its contents.
      }
    }
    return summaries.slice(0, 100)
  }

  async #nextRevision(id: string): Promise<number> {
    const directory = this.#draftDirectory(id)
    let highest = 0
    try {
      for (const name of await readdir(directory)) {
        const match = /^revision-(\d+)\.json$/.exec(name)
        const revision = match ? Number(match[1]) : 0
        if (Number.isSafeInteger(revision) && revision > highest) highest = revision
      }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return highest + 1
  }

  async #readLatest(id: string): Promise<StoredRevision> {
    if (!isDraftId(id)) throw new PluginDraftError('DRAFT_NOT_FOUND', '没有找到这份插件草稿。')
    const directory = this.#draftDirectory(id)
    let names: string[]
    try {
      names = await readdir(directory)
    }
    catch {
      throw new PluginDraftError('DRAFT_NOT_FOUND', '没有找到这份插件草稿。')
    }
    const revisions = names
      .map(name => /^revision-(\d+)\.json$/.exec(name))
      .flatMap(match => match?.[1] ? [Number(match[1])] : [])
      .filter(revision => Number.isSafeInteger(revision) && revision > 0)
      .sort((left, right) => right - left)
    for (const revision of revisions) {
      const file = path.join(directory, `revision-${revision}.json`)
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown
        const stored = parseStoredRevision(parsed)
        if (stored) return stored
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw new PluginDraftError('DRAFT_NOT_FOUND', '没有找到这份插件草稿。')
      }
    }
    throw new PluginDraftError('DRAFT_NOT_FOUND', '没有找到这份插件草稿。')
  }

  async #writeRevision(id: string, record: StoredRevision): Promise<void> {
    const directory = this.#draftDirectory(id)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    const file = path.join(directory, `revision-${record.revision}.json`)
    const temporary = `${file}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, file)
    await chmod(file, 0o600)
  }

  #draftDirectory(id: string): string {
    const directory = path.resolve(this.#root, id)
    if (directory !== path.join(this.#root, id)) throw new PluginDraftError('DRAFT_NOT_FOUND', '没有找到这份插件草稿。')
    return directory
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(operation, operation)
    this.#tail = run.then(() => undefined, () => undefined)
    return run
  }
}

export type DraftInstallPlan = {
  installable: false
  draft: PluginDraftSummary
  summary: string
  issues: PluginDraftIssue[]
} | {
  installable: true
  manifest: PluginManifestV1
  tool: DeclarativeTextTool
  draft: PluginDraftSummary
}

interface StoredRevision {
  v: 1
  revision: number
  createdAt: number
  manifest: PluginManifestV1
  source: string
  ok: boolean
}

interface Assessment {
  manifest: PluginManifestV1 | null
  issues: PluginDraftIssue[]
  ok: boolean
  blocked: boolean
}

function assessDraft(manifestJson: string, source: string, installed: readonly InstalledPluginRef[]): Assessment {
  const issues: PluginDraftIssue[] = []
  let manifest: PluginManifestV1 | null = null
  let manifestError: string | null = null
  try {
    const parsed: unknown = JSON.parse(manifestJson)
    validatePluginManifest(parsed)
    if (parsed.id.length > 128 || parsed.displayName.length > 80 || parsed.version.length > 32) {
      throw new Error('插件 manifest 的 id、名称或版本超出长度限制。')
    }
    manifest = parsed
  }
  catch (error) {
    manifestError = error instanceof Error ? error.message : 'manifest 无效。'
  }
  const secret = containsSecret(manifestJson) || containsSecret(source)
  if (secret) issues.push(finding('error', 'SECRET_MATERIAL', '草稿包含疑似凭据，已拒绝保存。'))
  else if (manifestError) issues.push(finding('error', 'MANIFEST_INVALID', manifestError))
  if (manifest && source.trim().length === 0) issues.push(finding('error', 'EMPTY_SOURCE', '草稿源码是空的。'))
  if (manifest) {
    for (const name of findDangerousApis(source)) {
      issues.push(finding('error', 'DANGEROUS_API', `草稿引用了未允许的 API：${name}。`))
    }
    if (installed.some(plugin => plugin.id === manifest?.id)) {
      issues.push(finding('warning', 'INSTALLED_ID', `插件 ${manifest.id} 已经安装。这份草稿不会替换它。`))
    }
  }
  return {
    manifest,
    issues: issues.slice(0, 20),
    ok: issues.every(item => item.severity !== 'error'),
    blocked: secret,
  }
}

function summaryOf(manifest: PluginManifestV1, revision: number, updatedAt: number, ok: boolean): PluginDraftSummary {
  return {
    id: manifest.id,
    revision,
    displayName: clamp(manifest.displayName, 80, manifest.id),
    version: clamp(manifest.version, 32, '0.0.0'),
    updatedAt,
    ok,
  }
}

function installBlockers(assessed: Assessment, source: string, ignoreInstalledId = false): PluginDraftIssue[] {
  const issues: PluginDraftIssue[] = []
  for (const issue of assessed.issues) {
    if (ignoreInstalledId && issue.code === 'INSTALLED_ID') continue
    if (issue.severity === 'error' || issue.code === 'INSTALLED_ID') {
      issues.push(issue.code === 'INSTALLED_ID' ? { ...issue, severity: 'error' } : issue)
    }
  }
  if (!parseDeclarativeTextTool(source)) {
    issues.push(finding('error', 'NOT_DECLARATIVE', '草稿不是声明式文本工具，源码没有执行。'))
  }
  if (assessed.manifest && !isStaticTextToolManifest(assessed.manifest)) {
    issues.push(finding('error', 'NOT_INSTALLABLE', '只接受无权限、且仅依赖 host.tools 的 pc-host 文本工具。'))
  }
  return issues
}

function refusalSummary(issues: readonly PluginDraftIssue[]): string {
  if (issues.some(issue => issue.code === 'SECRET_MATERIAL')) return '没有安装：草稿包含疑似凭据。源码没有执行。'
  if (issues.some(issue => issue.code === 'NOT_DECLARATIVE')) return '没有安装：这不是声明式文本工具，源码也没有执行。'
  if (issues.some(issue => issue.code === 'INSTALLED_ID')) return '没有安装：这个 id 已经安装，草稿不会替换它。'
  if (issues.some(issue => issue.code === 'DANGEROUS_API')) return '没有安装：草稿包含未允许的 API。源码没有执行。'
  if (issues.some(issue => issue.code === 'NOT_INSTALLABLE')) return '没有安装：manifest 不满足声明式文本工具的限制。源码没有执行。'
  return '没有安装。源码没有执行。'
}

function summaryText(kind: 'create' | 'validate' | 'diagnose', assessed: Assessment): string {
  const head = !assessed.ok
    ? '校验未通过。这份草稿没有安装。'
    : assessed.issues.some(item => item.code === 'INSTALLED_ID')
      ? '校验通过。同 id 的插件已安装，这份草稿不会替换它，源码也没有执行。'
      : '校验通过。这份草稿尚未安装。'
  if (kind !== 'diagnose') return head
  const details = assessed.issues.map(item => item.message).join(' ')
  return clamp(`${head}${details ? ` ${details}` : ''}`, 500, head)
}

function finding(severity: PluginDraftIssue['severity'], code: PluginDraftIssueCode, message: string): PluginDraftIssue {
  return { severity, code, message: clamp(redactSensitive(message), 240, '草稿检查失败。') }
}

function findDangerousApis(source: string): string[] {
  return dangerousApis.filter(api => api.pattern.test(source)).map(api => api.name)
}

function containsSecret(value: string): boolean {
  return /bearer\s+\S+/i.test(value)
    || /\bsk-[A-Za-z0-9_-]{8,}/.test(value)
    || /api[_-]?key\s*[:=]\s*['"][^'"]{4,}['"]/i.test(value)
}

function redactSensitive(value: string): string {
  return value
    .replace(/bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
}

function parseStoredRevision(value: unknown): StoredRevision | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Partial<StoredRevision>
  if (record.v !== 1 || typeof record.revision !== 'number' || typeof record.createdAt !== 'number' || typeof record.source !== 'string') return null
  try {
    validatePluginManifest(record.manifest)
  }
  catch {
    return null
  }
  return {
    v: 1,
    revision: record.revision,
    createdAt: record.createdAt,
    manifest: record.manifest,
    source: record.source,
    ok: record.ok === true,
  }
}

function isDraftId(value: string): boolean {
  return /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value) && value.length <= 128
}

function clamp(value: string, max: number, fallback: string): string {
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  const sliced = (text || fallback).slice(0, max).trim()
  return sliced || fallback.slice(0, max)
}
