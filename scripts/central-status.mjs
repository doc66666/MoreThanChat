import path from 'node:path'
import { runStatusCli } from '../apps/central-server/src/operator-client.mjs'
try {
  console.log(JSON.stringify(await runStatusCli(process.argv.slice(2), {
    defaultTokenFile: path.resolve(import.meta.dirname, '..', '.artifacts', 'central-dev', 'admin-token'),
  }), null, 2))
} catch {
  console.error('Status query failed. Check HTTPS/loopback address, administrator token file and server availability.')
  process.exitCode = 1
}
