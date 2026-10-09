import path from 'node:path'

export interface HostEntry {
  readonly entryPath: string
  readonly cwd: string
}

/**
 * Dev starts the workspace bundle. A packaged app starts the extraResources copy,
 * which stays outside app.asar so the utility process can load it.
 */
export function resolveHostEntry(input: {
  readonly packaged: boolean
  readonly resourcesPath: string
  readonly moduleDir: string
}): HostEntry {
  const entryPath = input.packaged
    ? packagedEntry(input.resourcesPath)
    : path.resolve(input.moduleDir, '../../pc-host/dist/main.js')
  return { entryPath, cwd: path.dirname(entryPath) }
}

function packagedEntry(resourcesPath: string): string {
  if (!resourcesPath.trim()) throw new Error('Packaged Host resources path is missing.')
  return path.resolve(resourcesPath, 'pc-host', 'main.js')
}
