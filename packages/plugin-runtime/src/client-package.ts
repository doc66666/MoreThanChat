import { validatePluginManifest, type PluginManifestV1 } from './index'

/** Executable and fully trusted, deliberately distinct from the declarative DSL. */
export interface ExecutableClientProgram { kind: 'executable-client'; code: string }
export interface ExecutableClientPackage { manifest: PluginManifestV1; program: ExecutableClientProgram }
export interface InstalledClientPackage extends ExecutableClientPackage { digest: string; enabled?: boolean }

export function parseExecutableClientPackage(value: unknown): ExecutableClientPackage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效的界面插件包')
  const v = value as Record<string, unknown>
  if (Object.keys(v).some(key => !['manifest', 'program'].includes(key))) throw new Error('插件包包含未知字段')
  validatePluginManifest(v.manifest)
  const m = v.manifest
  if (m.id.length > 128 || /^(builtin|core)[.-]/.test(m.id) || m.displayName.length > 80 || m.description.length > 1000 || m.version.length > 32) throw new Error('插件标识或描述无效／保留')
  if (m.targets.length !== 1 || m.targets[0] !== 'pc-ui' || m.engine.moreThanChat !== '^0.1.0') throw new Error('界面插件目前需要 pc-ui 和 ^0.1.0 引擎')
  if (m.permissions.length !== 1 || m.permissions[0] !== 'client.trusted') throw new Error('可执行界面插件必须明确声明 client.trusted 完整客户端信任权限')
  if (m.services?.provides?.length) throw new Error('当前版本不支持动态提供核心服务')
  if (m.services?.requires.some(id => !['ui.surfaces', 'ui.slots', 'ui.composer-actions', 'chat.network', 'chat.transports'].includes(id))) throw new Error('插件需要未提供的服务')
  const p = v.program as Partial<ExecutableClientProgram> | null
  if (!p || typeof p !== 'object' || Object.keys(p).some(key => !['kind', 'code'].includes(key)) || p.kind !== 'executable-client' || typeof p.code !== 'string' || !p.code.trim() || p.code.length > 100_000) throw new Error('需要 executable-client 和不超过 100000 字符的自包含 ES module code')
  return JSON.parse(JSON.stringify({manifest: m, program: p})) as ExecutableClientPackage
}
