import type { PluginManifestV1 } from '@more-than-chat/plugin-runtime'

const toolIdPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/
const declarativeKeys = ['kind', 'toolId', 'label', 'text'] as const
const composerKeys = ['kind', 'actionId', 'label', 'text'] as const

export interface DeclarativeTextTool {
  readonly id: string
  readonly label: string
  readonly text: string
}

export interface DeclarativeComposerAction {
  readonly id: string
  readonly label: string
  readonly text: string
}

export type DeclarativeInstall =
  | { readonly kind: 'text-tool'; readonly tool: DeclarativeTextTool }
  | { readonly kind: 'composer-action'; readonly action: DeclarativeComposerAction }

/** Parses a declarative host text tool. This is JSON.parse, never evaluation. */
export function parseDeclarativeTextTool(source: string): DeclarativeTextTool | null {
  const record = parseFixedObject(source, declarativeKeys)
  if (!record || record.kind !== 'host-text-tool') return null
  if (typeof record.toolId !== 'string' || record.toolId.length > 64 || !toolIdPattern.test(record.toolId)) return null
  const label = cleanLabel(record.label)
  const text = cleanText(record.text)
  if (!label || !text) return null
  return { id: record.toolId, label, text }
}

/** Parses a declarative composer action. This is JSON.parse, never evaluation. */
export function parseDeclarativeComposerAction(source: string): DeclarativeComposerAction | null {
  const record = parseFixedObject(source, composerKeys)
  if (!record || record.kind !== 'composer-text-action') return null
  if (typeof record.actionId !== 'string' || record.actionId.length > 64 || !toolIdPattern.test(record.actionId)) return null
  const label = cleanLabel(record.label)
  const text = cleanText(record.text)
  if (!label || !text) return null
  return { id: record.actionId, label, text }
}

/** Accepts only the two fixed declarative shapes. Source is never evaluated. */
export function parseDeclarativeInstall(source: string): DeclarativeInstall | null {
  const tool = parseDeclarativeTextTool(source)
  if (tool) return { kind: 'text-tool', tool }
  const action = parseDeclarativeComposerAction(source)
  if (action) return { kind: 'composer-action', action }
  return null
}

export function isStaticTextToolManifest(manifest: PluginManifestV1): boolean {
  const requires = manifest.services?.requires ?? []
  const provides = manifest.services?.provides ?? []
  return manifest.permissions.length === 0
    && manifest.targets.includes('pc-host')
    && requires.length === 1
    && requires[0] === 'host.tools'
    && provides.length === 0
}

export function isAcceptedStaticTextTool(manifest: PluginManifestV1, tool: DeclarativeTextTool): boolean {
  return isStaticTextToolManifest(manifest)
    && tool.id.length <= 64
    && toolIdPattern.test(tool.id)
    && tool.label.trim().length > 0
    && tool.label.length <= 80
    && tool.text.trim().length > 0
    && tool.text.length <= 4000
}

function parseFixedObject(source: string, keys: readonly string[]): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  }
  catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const actual = Object.keys(record)
  if (actual.length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(record, key))) return null
  return record
}

function cleanLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const label = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!label || label.length > 80) return null
  return label
}

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()
  if (!text || text.length > 4000) return null
  return text
}
