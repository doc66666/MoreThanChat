import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { createSeedState } from '../packages/chat-core/src/index.ts'
const root = path.resolve(import.meta.dirname, '..'),
  desktop = path.join(root, 'apps', 'desktop'),
  require = createRequire(path.join(desktop, 'package.json'))
const { ChatStore } = require(path.join(desktop, 'dist-main', 'chat-store.js'))
const executable = process.env.MTC_TEST_PACKAGED_EXE || require('electron')
for (const label of ['A', 'B']) {
  const directory = path.join(
      root,
      '.artifacts',
      'manual-central',
      'client-' + label.toLowerCase(),
    ),
    store = await ChatStore.open(directory)
  if (!store.load()) {
    const state = createSeedState()
    state.profile = {
      id: 'local-user',
      displayName: '测试用户 ' + label,
      avatar: label,
    }
    store.save(state)
  }
  store.close()
  const child = spawn(executable, ['.'], {
    cwd: desktop,
    env: { ...process.env, MTC_QA_MODE: '1', MTC_QA_USER_DATA_DIR: directory },
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  })
  child.unref()
  console.log('Client ' + label + ': ' + directory)
}
console.log(
  'In each client: Settings → Center server → http://localhost:8787 → Ping and authenticate.',
)
console.log(
  'Copy global IDs and submit/accept a friend request yourself. Existing test data was preserved.',
)
