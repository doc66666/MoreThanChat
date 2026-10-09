import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveHostEntry } from '../src/main/host-entry'

const { copyHostTree } = createRequire(import.meta.url)('../scripts/copy-host-resources.cjs') as {
  copyHostTree: (source: string, destination: string) => Promise<void>
}

describe('Host bundle entry', () => {
  it('uses the workspace dist while developing and resources/pc-host after packaging', () => {
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

  it('configures electron-builder to emit an unpacked directory and copy the staged Host', () => {
    const desktopDir = path.resolve(import.meta.dirname, '..')
    const manifest = JSON.parse(readFileSync(path.join(desktopDir, 'package.json'), 'utf8')) as {
      packageManager?: string
      build?: {
        appId?: string
        asar?: boolean
        npmRebuild?: boolean
        afterPack?: string
        directories?: { output?: string }
        linux?: { target?: string }
        win?: { target?: string; signAndEditExecutable?: boolean }
      }
    }
    const build = manifest.build
    expect(manifest.packageManager).toBe('pnpm@11.21.0')
    expect(build?.afterPack).toBe('./scripts/copy-host-resources.cjs')
    expect(build?.appId).toBe('dev.morethanchat.desktop')
    expect(build?.asar).toBe(true)
    expect(build?.npmRebuild).toBe(false)
    expect(path.resolve(desktopDir, build?.directories?.output ?? '')).toBe(path.resolve(desktopDir, '../../.artifacts/desktop-release'))
    expect(build?.linux?.target).toBe('dir')
    expect(build?.win?.target).toBe('dir')
    expect(build?.win?.signAndEditExecutable).toBe(false)
    const hook = readFileSync(path.join(desktopDir, 'scripts', 'copy-host-resources.cjs'), 'utf8')
    expect(hook.includes("'.artifacts', 'host-resources'")).toBe(true)
    expect(hook.includes("'pc-host'")).toBe(true)
  })

  it('copies a Host tree and replaces symlinks with file contents', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mtc-host-copy-'))
    try {
      const source = path.join(root, 'source')
      const outside = path.join(root, 'outside.txt')
      await mkdir(path.join(source, 'node_modules', 'pkg'), { recursive: true })
      await writeFile(outside, 'copied-text')
      await writeFile(path.join(source, 'main.js'), 'entry')
      await symlink(outside, path.join(source, 'node_modules', 'pkg', 'link.txt'))
      const destination = path.join(root, 'resources', 'pc-host')
      await copyHostTree(source, destination)
      expect(await readFile(path.join(destination, 'main.js'), 'utf8')).toBe('entry')
      expect(await readFile(path.join(destination, 'node_modules', 'pkg', 'link.txt'), 'utf8')).toBe('copied-text')
      expect((await lstat(path.join(destination, 'node_modules', 'pkg', 'link.txt'))).isSymbolicLink()).toBe(false)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
