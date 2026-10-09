import type { ParentPort } from 'electron'
import os from 'node:os'
import path from 'node:path'
import { HostPluginError, HostPluginService } from './plugin-service'
import { ModelService } from './model-service'
import { ModelServiceError, sanitizeProviderText } from './model-error'
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
const model = new ModelService({
  dataDir: process.env.MTC_HOST_DATA_DIR || path.join(os.homedir(), '.more-than-chat', 'host-private'),
  generation,
})
const pluginsReady = plugins.start()
const modelReady = model.load()
void pluginsReady.catch(reportFatalError)
void modelReady.catch(reportFatalError)
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
    parentPort.postMessage(createHostErrorResponse(parsed.data, protocolError(error)))
  }
}

async function handleRequest(request: HostRequest): Promise<void> {
  await pluginsReady
  await modelReady
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
      model.close()
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
      if (!request.payload.enabled) scheduleQaCrash()
      return
    case 'tools.invoke':
      parentPort.postMessage(createHostSuccessResponse(request, await plugins.invoke(request.payload.pluginId, request.payload.toolId)))
      return
    case 'model.getSettings':
      parentPort.postMessage(createHostSuccessResponse(request, model.getSettings()))
      return
    case 'model.setSettings':
      parentPort.postMessage(createHostSuccessResponse(request, await model.setSettings(request.payload)))
      return
    case 'model.chat.start':
      parentPort.postMessage(createHostSuccessResponse(request, model.start(request.payload, emitModelEvent)))
      return
    case 'model.chat.cancel':
      parentPort.postMessage(createHostSuccessResponse(request, model.cancel(request.payload.streamId)))
      return
    default:
      parentPort.postMessage(createHostErrorResponse(request, {
        code: 'UNKNOWN_METHOD',
        message: 'PC Host does not implement this method.',
        retryable: false,
      }))
  }
}

function emitModelEvent(event: unknown): void {
  try {
    parentPort.postMessage(event)
  }
  catch {
    // The parent may already be gone while a stream is finishing.
  }
}

function scheduleQaCrash(): void {
  if (qaCrashScheduled || generation !== 1 || process.env.MTC_HOST_QA_CRASH_ONCE !== '1') return
  qaCrashScheduled = true
  setTimeout(() => process.exit(86), 350).unref()
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

function protocolError(error: unknown): ProtocolErrorPayload {
  if (error instanceof ModelServiceError) {
    return { code: error.code, message: sanitizeProviderText(error.message, ''), retryable: error.retryable }
  }
  if (error instanceof HostPluginError) return { code: error.code, message: error.message, retryable: false }
  const message = error instanceof Error ? error.message : 'PC Host failed to handle the request.'
  return { code: 'INTERNAL_ERROR', message: sanitizeProviderText(message, ''), retryable: false }
}

function reportFatalError(error: unknown): void {
  if (fatalExitScheduled) return
  fatalExitScheduled = true
  const payload: ProtocolErrorPayload = {
    code: 'INTERNAL_ERROR',
    message: sanitizeProviderText(error instanceof Error ? error.message : 'PC Host failed.', ''),
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
