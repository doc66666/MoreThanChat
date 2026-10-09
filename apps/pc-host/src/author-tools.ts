import type {
  AuthorToolDraftRef,
  AuthorToolPublicName,
  PluginDraftCreateResult,
  PluginDraftInspection,
  PluginDraftIssue,
  PluginDraftReport,
  PluginDraftSummary,
} from '@more-than-chat/protocol'
import { PluginDraftError, type PluginDraftService } from './plugin-drafts'

export const AUTHOR_TOOL_NAMES = ['inspect_drafts', 'create_draft', 'validate_draft', 'diagnose_draft'] as const

export type AuthorToolName = (typeof AUTHOR_TOOL_NAMES)[number]

export interface AuthorToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: string
}

/** Chat-visible progress. Source and credentials stay out of every field. */
export interface AuthorToolNotice {
  readonly tool: AuthorToolPublicName
  readonly ok: boolean
  readonly summary: string
  readonly pendingInstall: boolean
  readonly draft: AuthorToolDraftRef | null
}

export interface AuthorToolExecution {
  readonly content: string
  readonly notice: AuthorToolNotice
}

export interface AuthorToolExecutor {
  execute(call: AuthorToolCall): Promise<AuthorToolExecution>
}

const PROGRESS: Record<AuthorToolPublicName, string> = {
  inspect_drafts: '正在检查插件草稿…',
  create_draft: '正在创建插件草稿…',
  validate_draft: '正在校验插件草稿…',
  diagnose_draft: '正在诊断插件草稿…',
  install_draft: '正在拒绝安装请求…',
  unknown: '正在处理作者工具…',
}

const MAX_ARGUMENTS = 20_000
const MAX_RESULT = 4_000

export const AUTHOR_TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'inspect_drafts',
      description: '列出已安装插件和草稿摘要。结果不包含源码或密钥。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_draft',
      description: '保存一份插件草稿。不会安装，也不会执行源码。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['manifestJson', 'source'],
        properties: {
          manifestJson: { type: 'string' },
          source: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'validate_draft',
      description: '校验一份已保存的草稿。不会安装，也不会执行源码。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['draftId'],
        properties: { draftId: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'diagnose_draft',
      description: '诊断一份已保存的草稿。不会安装，也不会执行源码。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['draftId'],
        properties: { draftId: { type: 'string' } },
      },
    },
  },
] as const

export function authorToolStarted(name: string): AuthorToolNotice {
  const tool = publicTool(name)
  return { tool, ok: true, summary: PROGRESS[tool], pendingInstall: false, draft: null }
}

export function createAuthorToolExecutor(drafts: PluginDraftService): AuthorToolExecutor {
  return {
    async execute(call) {
      if (call.arguments.length > MAX_ARGUMENTS) return refusal(publicTool(call.name), '工具参数过长，已拒绝。源码没有执行。')
      if (call.name === 'install_draft' || call.name === 'pluginDrafts.install') {
        return refusal('install_draft', '安装需要用户在界面确认。模型不能安装插件，源码也不会执行。')
      }
      if (!isAuthorTool(call.name)) return refusal('unknown', '没有这个作者工具。模型不能安装插件，源码也不会执行。')
      const source = sourceArgument(call)
      try {
        const result = await dispatch(drafts, call.name, call.arguments)
        return {
          content: cap(redactToolResult(JSON.stringify(result), source)),
          notice: noticeFrom(call.name, result, source),
        }
      }
      catch (error) {
        if (error instanceof PluginDraftError) return refusal(call.name, '没有找到这份插件草稿。')
        return refusal(call.name, '作者工具没有完成。源码没有执行。')
      }
    },
  }
}

function refusal(name: string, summary: string): AuthorToolExecution {
  const text = clampSummary(summary)
  return {
    content: text,
    notice: { tool: publicTool(name), ok: false, summary: text, pendingInstall: false, draft: null },
  }
}

function noticeFrom(
  tool: AuthorToolName,
  result: PluginDraftInspection | PluginDraftCreateResult | PluginDraftReport | { persisted: false; draft: null; ok: false; summary: string; issues: readonly PluginDraftIssue[] },
  source: string,
): AuthorToolNotice {
  if (tool === 'inspect_drafts' && 'drafts' in result && 'installed' in result) {
    return { tool, ok: true, summary: `已检查 ${result.drafts.length} 份草稿。`, pendingInstall: false, draft: null }
  }
  if (!('summary' in result)) {
    return refusal(tool, '作者工具没有完成。源码没有执行。').notice
  }
  const draft = 'draft' in result ? draftRef(result.draft) : null
  const issues = 'issues' in result ? result.issues : []
  const pendingInstall = draft !== null && result.ok && draft.ok && !blocksPending(issues) && !('persisted' in result && result.persisted === false)
  return {
    tool,
    ok: result.ok,
    summary: clampSummary(redactToolResult(result.summary, source)),
    pendingInstall,
    draft,
  }
}

function blocksPending(issues: readonly PluginDraftIssue[]): boolean {
  return issues.some(issue => issue.code === 'INSTALLED_ID' || issue.severity === 'error')
}

function draftRef(draft: PluginDraftSummary | null): AuthorToolDraftRef | null {
  if (!draft) return null
  const id = draft.id.trim().slice(0, 128)
  const displayName = draft.displayName.trim().slice(0, 80)
  if (!id || !displayName || !Number.isSafeInteger(draft.revision) || draft.revision < 0) return null
  return { id, displayName, revision: draft.revision, ok: draft.ok }
}

function publicTool(name: string): AuthorToolPublicName {
  if (name === 'install_draft' || name === 'pluginDrafts.install') return 'install_draft'
  if (isAuthorTool(name)) return name
  return 'unknown'
}

function clampSummary(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return '作者工具没有完成。源码没有执行。'
  return trimmed.length > 240 ? `${trimmed.slice(0, 239)}…` : trimmed
}

function isAuthorTool(name: string): name is AuthorToolName {
  return (AUTHOR_TOOL_NAMES as readonly string[]).includes(name)
}

async function dispatch(drafts: PluginDraftService, name: AuthorToolName, raw: string): Promise<PluginDraftInspection | PluginDraftCreateResult | PluginDraftReport | { persisted: false; draft: null; ok: false; summary: string; issues: [] }> {
  if (name === 'inspect_drafts') return drafts.inspect()
  if (name === 'validate_draft') return drafts.validate(readDraftId(raw))
  if (name === 'diagnose_draft') return drafts.diagnose(readDraftId(raw))
  const args = parseObject(raw)
  const manifestJson = typeof args.manifestJson === 'string' ? args.manifestJson : ''
  const source = typeof args.source === 'string' ? args.source : ''
  if (!manifestJson.trim()) {
    return { persisted: false, draft: null, ok: false, summary: '工具参数无效。源码没有执行。', issues: [] }
  }
  return drafts.create({ manifestJson, source })
}

function readDraftId(raw: string): string {
  const draftId = parseObject(raw).draftId
  if (typeof draftId !== 'string' || draftId.trim().length === 0 || draftId.length > 128) {
    throw new PluginDraftError('DRAFT_NOT_FOUND', '没有找到这份插件草稿。')
  }
  return draftId.trim()
}

function parseObject(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  }
  catch {
    return {}
  }
}

function sourceArgument(call: AuthorToolCall): string {
  if (call.name !== 'create_draft') return ''
  const source = parseObject(call.arguments).source
  return typeof source === 'string' ? source : ''
}

function redactToolResult(text: string, source: string): string {
  let redacted = text
  if (source.length >= 12) redacted = redacted.split(source).join('[redacted]')
  return redacted
    .replace(/bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
}

function cap(text: string): string {
  return text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT - 1)}…` : text
}
