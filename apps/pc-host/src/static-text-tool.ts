import type { PluginManifestV1 } from '@more-than-chat/plugin-runtime'

const toolIdPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/
const declarativeKeys = ['kind', 'toolId', 'label', 'text'] as const

export interface DeclarativeTextTool {
  readonly id: string
  readonly label: string
  readonly text: string
}

/** Parses the only installable draft shape. This is JSON.parse, never evaluation. */
export function parseDeclarativeTextTool(source: string): DeclarativeTextTool | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  }
  catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== declarativeKeys.length || declarativeKeys.some(key => !Object.prototype.hasOwnProperty.call(record, key))) return null
  if (record.kind !== 'host-text-tool') return null
  if (typeof record.toolId !== 'string' || record.toolId.length > 64 || !toolIdPattern.test(record.toolId)) return null
  if (typeof record.label !== 'string') return null
  const label = record.label.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!label || label.length > 80) return null
  if (typeof record.text !== 'string') return null
  const text = record.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()
  if (!text || text.length > 4000) return null
  return { id: record.toolId, label, text }
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
