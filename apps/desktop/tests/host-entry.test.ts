import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveHostEntry } from '../src/main/host-entry'

describe('Host bundle entry', () => {
  it('uses the workspace dist while developing and extraResources after packaging', () => {
    const root = path.resolve('/tmp', 'mtc-layout')
    const moduleDir = path.join(root, 'apps', 'desktop', 'dist-main')
    const developing = resolveHostEntry({
      packaged: false,
      resourcesPath: path.join(root, 'electron', 'resources'),
      moduleDir,
    })
    expect(developing.entryPath).toBe(path.join(root, 'apps', 'pc-host', 'dist', 'main.js'))
    expect(developing.cwd).toBe(path.dirname(developing.entryPath))
    expect(developing.entryPath.includes(`${path.sep}app.asar${path.sep}`)).toBe(false)

    const resourcesPath = path.join(root, 'resources')
    const packaged = resolveHostEntry({
      packaged: true,
      resourcesPath,
      moduleDir: path.join(resourcesPath, 'app.asar', 'dist-main'),
    })
    expect(packaged.entryPath).toBe(path.join(resourcesPath, 'pc-host', 'main.js'))
    expect(packaged.cwd).toBe(path.join(resourcesPath, 'pc-host'))
    expect(packaged.entryPath.includes(`${path.sep}app.asar${path.sep}`)).toBe(false)
    expect(() => resolveHostEntry({ packaged: true, resourcesPath: ' ', moduleDir })).toThrow(/resources path/)
  })

  it('points the desktop package extraResources copy at the staged Host closure', () => {
    const desktopDir = path.resolve(import.meta.dirname, '..')
    const manifest = JSON.parse(readFileSync(path.join(desktopDir, 'package.json'), 'utf8')) as {
      build?: { extraResources?: Array<{ from?: string; to?: string }> }
    }
    const copy = manifest.build?.extraResources?.[0]
    expect(copy?.to).toBe('pc-host')
    expect(path.resolve(desktopDir, copy?.from ?? '')).toBe(path.resolve(desktopDir, '../../.artifacts/host-resources'))
  })
})
