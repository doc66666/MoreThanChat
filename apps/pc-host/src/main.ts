import type { ParentPort } from 'electron'
import { HostPluginError, HostPluginService } from './plugin-service'
import {
  HOST_METHODS,
  HOST_PROTOCOL_VERSION,
  createHostErrorResponse,
  createHostEvent,
  createHostSuccessResponse,
  safeParseHostMessage,
  type HostMethod,
  type HostRequest,
  type HostRequestEnvelope,
  type ProtocolErrorPayload,
} from '@more-than-chat/protocol'

const HOST_NAME = 'MoreThanChat PC Host'
const HOST_VERSION = '0.1.0'
const generation = parseGeneration(process.env.MTC_HOST_GENERATION)
const plugins = new HostPluginService(generation)
const pluginsReady = plugins.start()
void pluginsReady.catch(reportFatalError)
const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort
let shuttingDown = false
let qaCrashScheduled = false
let fatalExitScheduled = false

if (!parentPort) throw new Error('PC Host must run as an Electron utility process.')

parentPort.on('message', event => {
  void handleIncoming(event.data)
})

async function handleIncoming(raw: unknown): Promise<void> {
  const parsed = safeParseHostMessage(raw)
  if (!parsed.success) {
    const request = recoverRequestIdentity(raw)
    if (request) parentPort.postMessage(createHostErrorResponse(request, parsed.error.toPayload()))
    return
  }
  if (parsed.data.kind !== 'request') return

  try {
    await handleRequest(parsed.data)
  }
  catch (error) {
    parentPort.postMessage(createHostErrorResponse(parsed.data, {
      code: error instanceof HostPluginError ? error.code : 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    }))
  }
}

async function handleRequest(request: HostRequest): Promise<void> {
  await pluginsReady
  if (shuttingDown && request.method !== 'host.shutdown') {
    parentPort.postMessage(createHostErrorResponse(request, {
      code: 'SHUTTING_DOWN',
      message: 'PC Host is shutting down.',
      retryable: true,
    }))
    return
  }

  switch (request.method) {
    case 'host.handshake': {
      if (!request.payload.supportedProtocolVersions.includes(HOST_PROTOCOL_VERSION)) {
        parentPort.postMessage(createHostErrorResponse(request, {
          code: 'UNSUPPORTED_PROTOCOL_VERSION',
          message: `PC Host only supports protocol v${HOST_PROTOCOL_VERSION}.`,
          retryable: false,
        }))
        return
      }
      const status = { state: 'ready', generation } as const
      parentPort.postMessage(createHostSuccessResponse(request, {
        selectedProtocolVersion: HOST_PROTOCOL_VERSION,
        hostName: HOST_NAME,
        hostVersion: HOST_VERSION,
        status,
      }))
      parentPort.postMessage(createHostEvent('host.statusChanged', status))
      scheduleQaCrash()
      return
    }
    case 'diagnostics.ping': {
      parentPort.postMessage(createHostSuccessResponse(request, {
        sentAtMs: request.payload.sentAtMs,
        receivedAtMs: Date.now(),
      }))
      return
    }
    case 'host.shutdown': {
      shuttingDown = true
      await plugins.stop()
      parentPort.postMessage(createHostSuccessResponse(request, { accepted: true }))
      setTimeout(() => process.exit(0), 20).unref()
      return
    }
    case 'plugins.list':
      parentPort.postMessage(createHostSuccessResponse(request, plugins.catalog()))
      return
    case 'plugins.setEnabled':
      parentPort.postMessage(createHostSuccessResponse(request, await plugins.setEnabled(request.payload.pluginId, request.payload.enabled)))
      return
    case 'tools.invoke':
      parentPort.postMessage(createHostSuccessResponse(request, await plugins.invoke(request.payload.pluginId, request.payload.toolId)))
      return
  }
}

function scheduleQaCrash(): void {
  if (qaCrashScheduled || generation !== 1 || process.env.MTC_HOST_QA_CRASH_ONCE !== '1') return
  qaCrashScheduled = true
  setTimeout(() => process.exit(86), 2_500).unref()
}

function recoverRequestIdentity(raw: unknown): Pick<HostRequestEnvelope<HostMethod>, 'requestId' | 'method'> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as { requestId?: unknown; method?: unknown }
  if (typeof value.requestId !== 'string' || !isHostMethod(value.method)) return undefined
  return { requestId: value.requestId, method: value.method }
}

function isHostMethod(value: unknown): value is HostMethod {
  return typeof value === 'string' && (HOST_METHODS as readonly string[]).includes(value)
}

function parseGeneration(value: string | undefined): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1
}

function reportFatalError(error: unknown): void {
  if (fatalExitScheduled) return
  fatalExitScheduled = true
  const payload: ProtocolErrorPayload = {
    code: 'INTERNAL_ERROR',
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  }
  try {
    parentPort.postMessage(createHostEvent('host.statusChanged', { state: 'failed', generation, error: payload }))
  }
  catch {
    // The parent may already be gone; exiting is still required.
  }
  setImmediate(() => process.exit(1))
}

process.on('uncaughtException', reportFatalError)
process.on('unhandledRejection', reportFatalError)
