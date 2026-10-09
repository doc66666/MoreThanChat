import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const requiredModules = [
  '@more-than-chat/protocol',
  '@more-than-chat/plugin-runtime',
  '@more-than-chat/runtime-cordis',
  '@more-than-chat/plugin-time-tool',
  '@cordisjs/core',
  'cosmokit',
]

export async function stageHostResources(root, output) {
  const hostDir = path.join(root, 'apps', 'pc-host')
  const distDir = path.join(hostDir, 'dist')
  let distEntries
  try {
    distEntries = await readdir(distDir)
  }
  catch (error) {
    if (error && error.code === 'ENOENT') throw new Error('Build the PC Host before staging resources: pnpm build:host')
    throw error
  }
  if (!distEntries.includes('main.js')) throw new Error('apps/pc-host/dist/main.js is missing.')
  await rm(output, { recursive: true, force: true })
  await mkdir(output, { recursive: true })
  for (const name of distEntries) {
    if (!name.endsWith('.js') && !name.endsWith('.js.map')) continue
    await cp(path.join(distDir, name), path.join(output, name), { dereference: true })
  }
  const hostPackage = JSON.parse(await readFile(path.join(hostDir, 'package.json'), 'utf8'))
  const versions = {}
  await vendorDependencies(hostPackage.dependencies ?? {}, path.join(hostDir, 'package.json'), path.join(output, 'node_modules'), versions)
  await writeFile(path.join(output, 'package.json'), `${JSON.stringify({
    // Keep this distinct from @more-than-chat/pc-host. A second copy of that name makes pnpm purge node_modules.
    name: 'more-than-chat-host-resources',
    version: hostPackage.version,
    private: true,
    main: 'main.js',
    dependencies: versions,
  }, null, 2)}\n`)
}

export async function verifyHostResources(output) {
  const entry = path.join(output, 'main.js')
  const requireFromHost = createRequire(entry)
  for (const name of requiredModules) {
    const resolved = await realpath(requireFromHost.resolve(name))
    if (!isInside(output, resolved)) throw new Error(`${name} resolved outside the staged Host: ${resolved}`)
  }
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  const launched = spawnSync(process.execPath, [entry], { cwd: output, encoding: 'utf8', env })
  const outputText = `${launched.stdout ?? ''}\n${launched.stderr ?? ''}`
  if (!outputText.includes('PC Host must run as an Electron utility process.')) {
    throw new Error(`Staged Host did not load its dependencies.\n${outputText}`)
  }
  if (launched.status === 0) throw new Error('Staged Host exited successfully outside Electron.')
}

async function vendorDependencies(dependencies, parentPackageJson, nodeModules, versions) {
  for (const name of Object.keys(dependencies)) {
    if (Object.hasOwn(versions, name)) continue
    const packageJsonPath = findPackageJson(createRequire(parentPackageJson), name)
    const source = JSON.parse(await readFile(packageJsonPath, 'utf8'))
    versions[name] = source.version
    await copyRuntimePackage(path.dirname(packageJsonPath), path.join(nodeModules, ...name.split('/')), source)
    await vendorDependencies(source.dependencies ?? {}, packageJsonPath, nodeModules, versions)
  }
}

function findPackageJson(requireFromParent, name) {
  let directory = path.dirname(requireFromParent.resolve(name))
  while (true) {
    const candidate = path.join(directory, 'package.json')
    try {
      const source = JSON.parse(readFileSync(candidate, 'utf8'))
      if (source.name === name) return candidate
    }
    catch (error) {
      if (!error || error.code !== 'ENOENT') throw error
    }
    const parent = path.dirname(directory)
    if (parent === directory) throw new Error(`Could not find package.json for ${name}.`)
    directory = parent
  }
}

async function copyRuntimePackage(sourceDir, destDir, source) {
  await mkdir(destDir, { recursive: true })
  await writeFile(path.join(destDir, 'package.json'), `${JSON.stringify({
    name: source.name,
    version: source.version,
    private: source.private,
    type: source.type,
    main: source.main,
    module: source.module,
    exports: source.exports,
  }, null, 2)}\n`)
  const include = Array.isArray(source.files) ? source.files : ['dist', 'lib', 'schema']
  for (const relative of include) {
    if (relative === 'src' || relative.startsWith('src/') || relative.includes('*')) continue
    const from = path.join(sourceDir, relative)
    let info
    try {
      info = await lstat(from)
    }
    catch (error) {
      if (error && error.code === 'ENOENT') continue
      throw error
    }
    await cp(from, path.join(destDir, relative), { recursive: info.isDirectory(), dereference: true })
  }
}

function isInside(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const repoRoot = path.resolve(import.meta.dirname, '..')
  const destination = path.join(repoRoot, '.artifacts', 'host-resources')
  await stageHostResources(repoRoot, destination)
  await verifyHostResources(destination)
  console.log(`Host resource closure is self-contained: ${destination}`)
}
