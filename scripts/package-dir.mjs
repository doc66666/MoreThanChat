import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync, statSync } from 'node:fs'
import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { requiredHostModules } from './stage-host-resources.mjs'

const unpackedNames = ['linux-unpacked', 'win-unpacked', 'mac', 'mac-arm64', 'mac-universal']

export async function verifyPackagedHost(releaseDir) {
  const unpackedDirs = await findUnpackedDirs(releaseDir)
  if (unpackedDirs.length === 0) {
    throw new Error(`No unpacked Electron directory in ${releaseDir}. Run electron-builder --dir on this operating system.`)
  }
  for (const unpacked of unpackedDirs) await verifyUnpackedDir(unpacked)
  return unpackedDirs
}

export function desktopReleaseDir(repoRoot) {
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'apps', 'desktop', 'package.json'), 'utf8'))
  const output = manifest.build?.directories?.output
  if (typeof output !== 'string' || output.trim() === '') throw new Error('desktop build.directories.output is missing.')
  return path.resolve(repoRoot, 'apps', 'desktop', output)
}

export function runElectronBuilder(repoRoot) {
  const desktopDir = path.join(repoRoot, 'apps', 'desktop')
  const cli = path.join(desktopDir, 'node_modules', 'electron-builder', 'cli.js')
  const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
  if (!env.npm_config_user_agent?.includes('pnpm')) env.npm_config_user_agent = 'pnpm/11.21.0'
  delete env.CSC_LINK
  delete env.CSC_KEY_PASSWORD
  delete env.WIN_CSC_LINK
  delete env.WIN_CSC_KEY_PASSWORD
  const launched = spawnSync(process.execPath, [cli, '--dir', '--publish', 'never'], {
    cwd: desktopDir,
    env,
    stdio: 'inherit',
  })
  if (launched.error) throw launched.error
  if (launched.status !== 0) {
    throw new Error(`electron-builder exited with status ${launched.status ?? 'missing'}.`)
  }
}

async function findUnpackedDirs(releaseDir) {
  let names
  try {
    names = await readdir(releaseDir)
  }
  catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
  const found = []
  for (const name of unpackedNames) {
    if (!names.includes(name)) continue
    const dir = path.join(releaseDir, name)
    const info = await stat(dir)
    if (info.isDirectory()) found.push(dir)
  }
  return found
}

async function verifyUnpackedDir(unpacked) {
  const resources = path.join(unpacked, 'resources')
  const asar = path.join(resources, 'app.asar')
  const hostDir = path.join(resources, 'pc-host')
  const entry = path.join(hostDir, 'main.js')
  await assertFile(asar, 'Packaged desktop archive')
  await assertFile(entry, 'Packaged Host entry')
  if (entry.includes(`${path.sep}app.asar${path.sep}`)) throw new Error(`Host entry is inside app.asar: ${entry}`)
  const entryReal = await realpath(entry)
  if (!isInside(hostDir, entryReal)) throw new Error(`Host entry resolved outside resources/pc-host: ${entryReal}`)
  await assertNoEscapingSymlinks(hostDir)
  const requireFromHost = createRequire(entry)
  for (const name of requiredHostModules) {
    const resolved = await realpath(requireFromHost.resolve(name))
    if (!isInside(hostDir, resolved)) throw new Error(`${name} resolved outside the packaged Host: ${resolved}`)
  }
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  const launched = spawnSync(process.execPath, [entry], { cwd: hostDir, encoding: 'utf8', env })
  const outputText = `${launched.stdout ?? ''}\n${launched.stderr ?? ''}`
  if (!outputText.includes('PC Host must run as an Electron utility process.')) {
    throw new Error(`Packaged Host did not load its dependencies.\n${outputText}`)
  }
  if (launched.status === 0) throw new Error('Packaged Host exited successfully outside Electron.')
}

async function assertFile(file, label) {
  let info
  try {
    info = await stat(file)
  }
  catch (error) {
    if (error && error.code === 'ENOENT') throw new Error(`${label} is missing: ${file}`)
    throw error
  }
  if (!info.isFile()) throw new Error(`${label} is not a file: ${file}`)
}

async function assertNoEscapingSymlinks(root) {
  const pending = [root]
  while (pending.length > 0) {
    const current = pending.pop()
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      const info = await lstat(full)
      if (info.isSymbolicLink()) {
        const target = await realpath(full)
        if (!isInside(root, target)) throw new Error(`Symlink escapes the packaged Host: ${full} -> ${target}`)
      }
      else if (info.isDirectory()) pending.push(full)
    }
  }
}

function isInside(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function assertStagedHost(repoRoot) {
  const entry = path.join(repoRoot, '.artifacts', 'host-resources', 'main.js')
  try {
    const info = statSync(entry)
    if (!info.isFile()) throw new Error(`Staged Host entry is not a file: ${entry}`)
  }
  catch (error) {
    if (error && error.code === 'ENOENT') throw new Error('Stage the Host resources before packaging: pnpm stage:host')
    throw error
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.includes('--if-ci') && process.env.CI !== 'true') {
    console.log('Skipping electron-builder directory output outside CI. Run pnpm package:dir to build it.')
  }
  else {
    const repoRoot = path.resolve(import.meta.dirname, '..')
    assertStagedHost(repoRoot)
    runElectronBuilder(repoRoot)
    const releaseDir = desktopReleaseDir(repoRoot)
    const unpackedDirs = await verifyPackagedHost(releaseDir)
    for (const dir of unpackedDirs) {
      console.log(`Unpacked directory keeps the Host outside app.asar: ${dir}`)
    }
    console.log('This layout check runs on the current operating system. It is not Windows installer acceptance.')
  }
}
