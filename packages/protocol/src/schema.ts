const protocolVersion = { const: 1 } as const;
const nonEmptyString = { type: "string", minLength: 1, pattern: ".*\\S.*" } as const;
const requestId = { ...nonEmptyString, maxLength: 256 } as const;
const pluginMethods = ['plugins.list', 'plugins.setEnabled', 'tools.invoke'] as const;
const generation = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;
const pluginCatalog = {
  type: 'object', additionalProperties: false, required: ['generation', 'plugins'],
  properties: {
    generation,
    plugins: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'displayName', 'description', 'version', 'status', 'error', 'tools'],
        properties: {
          id: nonEmptyString, displayName: nonEmptyString, description: nonEmptyString, version: nonEmptyString,
          status: { enum: ['inactive', 'activating', 'active', 'deactivating', 'failed'] },
          error: { type: ['string', 'null'] },
          tools: { type: 'array', items: {
            type: 'object', additionalProperties: false, required: ['id', 'label'],
            properties: { id: nonEmptyString, label: nonEmptyString },
          } },
        },
      },
    },
  },
} as const;
function request(method: string, payload: unknown) {
  return { type: 'object', additionalProperties: false, required: ['protocolVersion', 'kind', 'requestId', 'method', 'payload'],
    properties: { protocolVersion, kind: { const: 'request' }, requestId, method: { const: method }, payload } };
}
function response(method: string, payload: unknown) {
  return { type: 'object', additionalProperties: false, required: ['protocolVersion', 'kind', 'requestId', 'method', 'ok', 'payload'],
    properties: { protocolVersion, kind: { const: 'response' }, requestId, method: { const: method }, ok: { const: true }, payload } };
}

export const HOST_PROTOCOL_V1_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://more-than-chat.dev/schema/host-protocol-v1.schema.json",
  title: "MoreThanChat Host Protocol v1",
  description: "Platform-neutral IPC protocol shared by desktop and future Android hosts.",
  oneOf: [
    { $ref: "#/$defs/handshakeRequest" },
    { $ref: "#/$defs/pingRequest" },
    { $ref: "#/$defs/shutdownRequest" },
    { $ref: "#/$defs/handshakeSuccessResponse" },
    { $ref: "#/$defs/pingSuccessResponse" },
    { $ref: "#/$defs/shutdownSuccessResponse" },
    { $ref: "#/$defs/errorResponse" },
    { $ref: "#/$defs/statusChangedEvent" },
    { $ref: '#/$defs/pluginListRequest' },
    { $ref: '#/$defs/pluginSetEnabledRequest' },
    { $ref: '#/$defs/toolInvokeRequest' },
    { $ref: '#/$defs/pluginListResponse' },
    { $ref: '#/$defs/pluginSetEnabledResponse' },
    { $ref: '#/$defs/toolInvokeResponse' },
  ],
  $defs: {
    protocolError: {
      type: "object",
      additionalProperties: false,
      required: ["code", "message", "retryable"],
      properties: {
        code: {
          enum: [
            "INVALID_MESSAGE",
            "UNSUPPORTED_PROTOCOL_VERSION",
            "UNKNOWN_KIND",
            "UNKNOWN_METHOD",
            "UNKNOWN_EVENT",
            "INVALID_PAYLOAD",
            "RESPONSE_MISMATCH",
            "INTERNAL_ERROR",
            "REQUEST_TIMEOUT",
            "HOST_UNAVAILABLE",
            "HOST_START_FAILED",
            "HOST_CRASHED",
            "SHUTTING_DOWN",
            'PLUGIN_NOT_FOUND',
            'TOOL_UNAVAILABLE',
          ],
        },
        message: nonEmptyString,
        retryable: { type: "boolean" },
        details: true,
      },
    },
    hostStatus: {
      type: "object",
      additionalProperties: false,
      required: ["state", "generation"],
      properties: {
        state: { enum: ["starting", "ready", "restarting", "failed", "stopped"] },
        generation: { type: "integer", minimum: 0 },
        error: { $ref: "#/$defs/protocolError" },
      },
    },
    handshakeRequest: {
      type: "object",
      additionalProperties: false,
      required: ["protocolVersion", "kind", "requestId", "method", "payload"],
      properties: {
        protocolVersion,
        kind: { const: "request" },
        requestId,
        method: { const: "host.handshake" },
        payload: {
          type: "object",
          additionalProperties: false,
          required: ["clientName", "clientVersion", "supportedProtocolVersions"],
          properties: {
            clientName: nonEmptyString,
            clientVersion: nonEmptyString,
            supportedProtocolVersions: {
              type: "array",
              minItems: 1,
              uniqueItems: true,
              contains: { const: 1 },
              items: { type: "integer", minimum: 1 },
            },
          },
        },
      },
    },
    pingRequest: {
      type: "object",
      additionalProperties: false,
      required: ["protocolVersion", "kind", "requestId", "method", "payload"],
      properties: {
        protocolVersion,
        kind: { const: "request" },
        requestId,
        method: { const: "diagnostics.ping" },
        payload: {
          type: "object",
          additionalProperties: false,
          required: ["sentAtMs"],
          properties: { sentAtMs: { type: "number" } },
        },
      },
    },
    shutdownRequest: {
      type: "object",
      additionalProperties: false,
      required: ["protocolVersion", "kind", "requestId", "method", "payload"],
      properties: {
        protocolVersion,
        kind: { const: "request" },
        requestId,
        method: { const: "host.shutdown" },
        payload: {
          type: "object",
          additionalProperties: false,
          properties: { reason: nonEmptyString },
        },
      },
    },
    handshakeSuccessResponse: {
      type: "object",
      additionalProperties: false,
      required: ["protocolVersion", "kind", "requestId", "method", "ok", "payload"],
      properties: {
        protocolVersion,
        kind: { const: "response" },
        requestId,
        method: { const: "host.handshake" },
        ok: { const: true },
        payload: {
          type: "object",
          additionalProperties: false,
          required: ["selectedProtocolVersion", "hostName", "hostVersion", "status"],
          properties: {
            selectedProtocolVersion: protocolVersion,
            hostName: nonEmptyString,
            hostVersion: nonEmptyString,
            status: { $ref: "#/$defs/hostStatus" },
          },
        },
      },
    },
    pingSuccessResponse: {
      type: "object",
      additionalProperties: false,
      required: ["protocolVersion", "kind", "requestId", "method", "ok", "payload"],
      properties: {
        protocolVersion,
        kind: { const: "response" },
        requestId,
        method: { const: "diagnostics.ping" },
        ok: { const: true },
        payload: {
          type: "object",
          additionalProperties: false,
          required: ["sentAtMs", "receivedAtMs"],
          properties: {
            sentAtMs: { type: "number" },
            receivedAtMs: { type: "number" },
          },
        },
      },
    },
    shutdownSuccessResponse: {
      type: "object",
      additionalProperties: false,
      required: ["protocolVersion", "kind", "requestId", "method", "ok", "payload"],
      properties: {
        protocolVersion,
        kind: { const: "response" },
        requestId,
        method: { const: "host.shutdown" },
        ok: { const: true },
        payload: {
          type: "object",
          additionalProperties: false,
          required: ["accepted"],
          properties: { accepted: { const: true } },
        },
      },
    },
    errorResponse: {
      type: "object",
      additionalProperties: false,
      required: ["protocolVersion", "kind", "requestId", "method", "ok", "error"],
      properties: {
        protocolVersion,
        kind: { const: "response" },
        requestId,
        method: { enum: ["host.handshake", "diagnostics.ping", "host.shutdown", ...pluginMethods] },
        ok: { const: false },
        error: { $ref: "#/$defs/protocolError" },
      },
    },
    statusChangedEvent: {
      type: "object",
      additionalProperties: false,
      required: ["protocolVersion", "kind", "event", "payload"],
      properties: {
        protocolVersion,
        kind: { const: "event" },
        event: { const: "host.statusChanged" },
        payload: { $ref: "#/$defs/hostStatus" },
      },
    },
    pluginListRequest: request('plugins.list', { type: 'object', additionalProperties: false }),
    pluginSetEnabledRequest: request('plugins.setEnabled', { type: 'object', additionalProperties: false,
      required: ['pluginId', 'enabled'], properties: { pluginId: nonEmptyString, enabled: { type: 'boolean' } } }),
    toolInvokeRequest: request('tools.invoke', { type: 'object', additionalProperties: false,
      required: ['pluginId', 'toolId'], properties: { pluginId: nonEmptyString, toolId: nonEmptyString } }),
    pluginListResponse: response('plugins.list', pluginCatalog),
    pluginSetEnabledResponse: response('plugins.setEnabled', pluginCatalog),
    toolInvokeResponse: response('tools.invoke', { type: 'object', additionalProperties: false,
      required: ['generation', 'text'], properties: { generation, text: nonEmptyString } }),
  },
} as const;
