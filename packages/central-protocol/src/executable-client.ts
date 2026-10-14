/** Portable wire format. Code is transported, never evaluated by the server. */
export interface SharedClientPackage {
  manifest: {
    manifestVersion: 1; id: string; version: string; displayName: string; description: string;
    targets: readonly ['pc-ui']; engine: {moreThanChat: string}; permissions: readonly string[];
    services?: {requires: readonly string[]; provides?: readonly string[]};
  }
  program: {kind: 'executable-client'; code: string}
}
export function parseSharedClientPackage(value: unknown): SharedClientPackage {
  const v = value as SharedClientPackage | null, m = v?.manifest, p = v?.program
  if (!v || typeof v !== 'object' || Object.keys(v).some(k => !['manifest','program'].includes(k)) ||
    !m || m.manifestVersion !== 1 || typeof m.id !== 'string' || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(m.id) || m.id.length > 128 || /^(builtin|core)[.-]/.test(m.id) ||
    typeof m.version !== 'string' || m.version.length > 32 || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(m.version) ||
    typeof m.displayName !== 'string' || !m.displayName.trim() || m.displayName.length > 80 ||
    typeof m.description !== 'string' || !m.description.trim() || m.description.length > 1000 ||
    !Array.isArray(m.targets) || m.targets.length !== 1 || m.targets[0] !== 'pc-ui' || m.engine?.moreThanChat !== '^0.1.0' ||
    !Array.isArray(m.permissions) || m.permissions.length !== 1 || m.permissions[0] !== 'client.trusted' ||
    (m.services && (!Array.isArray(m.services.requires) || m.services.requires.some(id => !['ui.surfaces','ui.slots','ui.composer-actions','chat.network','chat.transports'].includes(id)) || (m.services.provides !== undefined && (!Array.isArray(m.services.provides) || m.services.provides.length > 0)))) ||
    !p || p.kind !== 'executable-client' || Object.keys(p).some(k => !['kind','code'].includes(k)) || typeof p.code !== 'string' || !p.code.trim() || p.code.length > 100000)
    throw new Error('Invalid executable client package')
  return JSON.parse(JSON.stringify(v)) as SharedClientPackage
}
