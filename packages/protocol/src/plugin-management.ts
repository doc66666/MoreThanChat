export type PluginManagementRequest =
  | { action: 'list'; target: 'all' | 'client' }
  | { action: 'delete-draft'; target: 'draft'; id: string; revision: number }
  | { action: 'uninstall'; target: 'host' | 'client'; id: string; version: string };
export interface ManagedPlugin {
  id: string; version: string; displayName: string; target: 'host' | 'client'; enabled: boolean; removable: boolean;
}
export interface PluginManagementResult { summary: string; plugins: ManagedPlugin[] }

export function parsePluginManagementRequest(value: unknown): PluginManagementRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('插件管理参数无效');
  const v = value as Record<string, unknown>;
  const keys = v.action === 'list' ? ['action','target'] : v.action === 'delete-draft' ? ['action','target','id','revision'] : ['action','target','id','version'];
  if (Object.keys(v).length !== keys.length || Object.keys(v).some(k => !keys.includes(k))) throw Error('插件管理参数无效');
  if (v.action === 'list' && (v.target === 'all' || v.target === 'client')) return v as PluginManagementRequest;
  if (typeof v.id !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,127}$/.test(v.id) || v.id.includes('..')) throw Error('插件 ID 无效');
  if (v.action === 'delete-draft' && v.target === 'draft' && Number.isSafeInteger(v.revision) && Number(v.revision) > 0) return v as PluginManagementRequest;
  if (v.action === 'uninstall' && (v.target === 'host' || v.target === 'client') && typeof v.version === 'string' && v.version.length > 0 && v.version.length <= 32) return v as PluginManagementRequest;
  throw Error('插件管理参数无效');
}
export function parsePluginManagementResult(value: unknown): PluginManagementResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('插件管理结果无效');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k=>k!=='summary'&&k!=='plugins') || typeof v.summary !== 'string' || v.summary.length>500 || !Array.isArray(v.plugins) || v.plugins.length>200) throw Error('插件管理结果无效');
  for (const p of v.plugins) {
    if (!p || typeof p !== 'object' || Object.keys(p).some(k=>!['id','version','displayName','target','enabled','removable'].includes(k)) || typeof p.id!=='string' || p.id.length>128 || typeof p.version!=='string' || p.version.length>32 || typeof p.displayName!=='string' || p.displayName.length>80 || !['host','client'].includes(p.target) || typeof p.enabled!=='boolean' || typeof p.removable!=='boolean') throw Error('插件管理列表无效');
  }
  return v as unknown as PluginManagementResult;
}
