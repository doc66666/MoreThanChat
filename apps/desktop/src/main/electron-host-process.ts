import { utilityProcess, type UtilityProcess } from 'electron'
import type { HostProcess, HostProcessFactory } from './host-supervisor'

export interface ElectronHostProcessOptions {
  readonly entryPath: string
  readonly cwd: string
  readonly environment?: Readonly<Record<string, string | undefined>>
}

export function createElectronHostProcessFactory(options: ElectronHostProcessOptions): HostProcessFactory {
  const environment = createHostEnvironment(options.environment)
  return generation => wrapUtilityProcess(utilityProcess.fork(options.entryPath, [], {
    cwd: options.cwd,
    env: { ...environment, MTC_HOST_GENERATION: String(generation) },
    serviceName: 'MoreThanChat PC Host',
    stdio: ['ignore', 'pipe', 'pipe'],
  }))
}

function wrapUtilityProcess(child: UtilityProcess): HostProcess {
  child.stdout?.on('data', chunk => console.info(`[pc-host] ${String(chunk).trimEnd()}`))
  child.stderr?.on('data', chunk => console.error(`[pc-host] ${String(chunk).trimEnd()}`))
  return {
    get pid() {
      return child.pid
    },
    send: message => child.postMessage(message),
    terminate: () => child.kill(),
    onSpawn(listener) {
      child.on('spawn', listener)
      return () => child.off('spawn', listener)
    },
    onMessage(listener) {
      child.on('message', listener)
      return () => child.off('message', listener)
    },
    onExit(listener) {
      child.on('exit', listener)
      return () => child.off('exit', listener)
    },
    onFatal(listener) {
      const handler = (_type: 'FatalError', location: string, report: string) => {
        // Do not forward Node's diagnostic report: it can contain environment
        // variables and process internals. Keep the renderer-facing status terse.
        void report
        listener(`Fatal utility-process error at ${sanitizeDiagnosticLocation(location)}.`)
      }
      child.on('error', handler)
      return () => child.off('error', handler)
    },
  }
}

const inheritedHostEnvironmentKeys = new Set([
  'LANG',
  'LC_ALL',
  'NODE_ENV',
  'PATH',
  'Path',
  'SystemRoot',
  'TEMP',
  'TMP',
  'TZ',
  'WINDIR',
])

function createHostEnvironment(overrides: Readonly<Record<string, string | undefined>> | undefined): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && inheritedHostEnvironmentKeys.has(key)) environment[key] = value
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value !== undefined) environment[key] = value
    else delete environment[key]
  }
  return environment
}

function sanitizeDiagnosticLocation(value: string): string {
  const sanitized = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return sanitized.length > 120 ? `${sanitized.slice(0, 117)}...` : sanitized || 'unknown location'
}
