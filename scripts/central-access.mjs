import path from 'node:path'
import { runAccessCli } from '../apps/central-server/src/operator-client.mjs'
try {
  console.log(JSON.stringify(await runAccessCli(process.argv.slice(2), {
    defaultTokenFile: path.resolve(import.meta.dirname, '..', '.artifacts', 'central-dev', 'admin-token'),
  })))
} catch {
  console.error('Access update failed. Check arguments, HTTPS/loopback address, administrator token file and server availability.')
  process.exitCode = 1
}
