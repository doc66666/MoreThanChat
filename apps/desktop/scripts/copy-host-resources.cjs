const { cp, mkdir, rm, stat } = require('node:fs/promises')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '../../..')
const stagedHost = path.join(repoRoot, '.artifacts', 'host-resources')

async function copyHostTree(source, destination) {
  await rm(destination, { recursive: true, force: true })
  await mkdir(path.dirname(destination), { recursive: true })
  await cp(source, destination, { recursive: true, dereference: true })
}

function resourcesDirectory(context) {
  if (context.packager != null && typeof context.packager.getResourcesDir === 'function') {
    return context.packager.getResourcesDir(context.appOutDir)
  }
  return path.join(context.appOutDir, 'resources')
}

async function copyHostResources(context) {
  try {
    const info = await stat(stagedHost)
    if (!info.isDirectory()) throw new Error(`Staged Host resources are not a directory: ${stagedHost}`)
  }
  catch (error) {
    if (error && error.code === 'ENOENT') throw new Error('Stage the Host resources before packaging: pnpm stage:host')
    throw error
  }
  const destination = path.join(resourcesDirectory(context), 'pc-host')
  await copyHostTree(stagedHost, destination)
}

module.exports = copyHostResources
module.exports.copyHostTree = copyHostTree
module.exports.resourcesDirectory = resourcesDirectory
