import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

// Executes the documented example's real ESM entry, not a replacement test module.
// This is a Node contract/render check, not native permission or browser interaction acceptance.
const root = path.resolve(import.meta.dirname, '..')
const require = createRequire(path.join(root, 'apps/desktop/package.json'))
const React = require('react'), {renderToStaticMarkup} = require('react-dom/server')
const {parseExecutableClientPackage, UiSurfaceRegistry} = require('@more-than-chat/plugin-runtime')
const {CordisPluginRuntime} = require('@more-than-chat/runtime-cordis')
const pack = parseExecutableClientPackage(JSON.parse(await readFile(path.join(root, 'examples/client-desktop.mtcplugin'), 'utf8')))
const module = await import('data:text/javascript;base64,' + Buffer.from(pack.program.code).toString('base64'))
const registry = new UiSurfaceRegistry(), runtime = new CordisPluginRuntime({target: 'pc-ui', services: {'ui.surfaces': registry}})
runtime.install({manifest: pack.manifest, trust: 'trusted', load: async () => ({manifest: pack.manifest, activate: ctx => module.default(ctx, {version: 1, React, app: {recoverClientInterface() {throw new Error('Native action should not run during rendering')}}})})})
for (let cycle = 0; cycle < 3; cycle++) {
  await runtime.activate(pack.manifest.id)
  const input = {context: {conversations: [{id: 'test-room', title: '测试会话'}]}, defaultView: React.createElement('div', null, 'DEFAULT_CHAT'), renderSurface: (_name, _context, fallback) => fallback}
  const html = renderToStaticMarkup(registry.resolve('root').contribution.render(input))
  assert.ok(html.includes('data-custom-desktop="true"'))
  assert.ok(html.includes('我的插件工作台') && html.includes('交互计数：0') && html.includes('测试会话'))
  assert.ok(!html.includes('DEFAULT_CHAT'), 'Root truly replaced, not appended to the default desktop')
  await runtime.deactivate(pack.manifest.id)
  assert.equal(registry.list().length, 0)
  assert.equal(runtime.getDiagnostics().registeredScopes, 0)
}
await runtime.close()
console.log('Documented executable ESM module: full-root render and three Cordis lifecycle cycles passed. Native/browser acceptance remains separate.')
