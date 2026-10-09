const protocolVersion = { const: 1 } as const;
const nonEmptyString = { type: "string", minLength: 1, pattern: ".*\\S.*" } as const;
const requestId = { ...nonEmptyString, maxLength: 256 } as const;
const pluginMethods = ['plugins.list', 'plugins.setEnabled', 'tools.invoke'] as const;
const modelMethods = ['model.getSettings', 'model.setSettings', 'model.chat.start', 'model.chat.cancel'] as const;
const boundedId = { ...nonEmptyString, maxLength: 256 } as const;
const modelSettings = {
  type: 'object', additionalProperties: false, required: ['baseUrl', 'model', 'providerMode', 'hasApiKey'],
  properties: {
    baseUrl: { ...nonEmptyString, maxLength: 2048 },
    model: { ...nonEmptyString, maxLength: 256 },
    providerMode: { enum: ['mock', 'openai-compatible'] },
    hasApiKey: { type: 'boolean' },
  },
} as const;
const modelMessages = {
  type: 'array', minItems: 1, maxItems: 200, items: {
    type: 'object', additionalProperties: false, required: ['role', 'content'],
    properties: {
      role: { enum: ['system', 'user', 'assistant'] },
      content: { type: 'string', maxLength: 100000 },
    },
  },
} as const;
const generation = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;
const streamIdentityProperties = {
  streamId: boundedId,
  conversationId: boundedId,
  assistantMessageId: boundedId,
} as const;
const streamRefProperties = {
  ...streamIdentityProperties,
  generation,
} as const;
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
    { $ref: '#/$defs/modelGetSettingsRequest' },
    { $ref: '#/$defs/modelSetSettingsRequest' },
    { $ref: '#/$defs/modelChatStartRequest' },
    { $ref: '#/$defs/modelChatCancelRequest' },
    { $ref: '#/$defs/modelGetSettingsResponse' },
    { $ref: '#/$defs/modelSetSettingsResponse' },
    { $ref: '#/$defs/modelChatStartResponse' },
    { $ref: '#/$defs/modelChatCancelResponse' },
    { $ref: '#/$defs/modelChatDeltaEvent' },
    { $ref: '#/$defs/modelChatCompletedEvent' },
    { $ref: '#/$defs/modelChatFailedEvent' },
    { $ref: '#/$defs/modelChatCancelledEvent' },
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
            'MODEL_NOT_CONFIGURED',
            'MODEL_REQUEST_FAILED',
            'MODEL_STREAM_NOT_FOUND',
            'CREDENTIAL_UNAVAILABLE',
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
        method: { enum: ["host.handshake", "diagnostics.ping", "host.shutdown", ...pluginMethods, ...modelMethods] },
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
    modelGetSettingsRequest: request('model.getSettings', { type: 'object', additionalProperties: false }),
    modelSetSettingsRequest: request('model.setSettings', {
      type: 'object', additionalProperties: false,
      properties: {
        baseUrl: { ...nonEmptyString, maxLength: 2048 },
        model: { ...nonEmptyString, maxLength: 256 },
        providerMode: { enum: ['mock', 'openai-compatible'] },
        apiKey: { ...nonEmptyString, maxLength: 4096 },
        clearApiKey: { type: 'boolean' },
      },
    }),
    modelChatStartRequest: request('model.chat.start', {
      type: 'object', additionalProperties: false,
      required: ['streamId', 'conversationId', 'assistantMessageId', 'messages'],
      properties: { ...streamIdentityProperties, messages: modelMessages },
    }),
    modelChatCancelRequest: request('model.chat.cancel', {
      type: 'object', additionalProperties: false,
      required: ['streamId'],
      properties: { streamId: boundedId },
    }),
    modelGetSettingsResponse: response('model.getSettings', modelSettings),
    modelSetSettingsResponse: response('model.setSettings', modelSettings),
    modelChatStartResponse: response('model.chat.start', {
      type: 'object', additionalProperties: false,
      required: ['streamId', 'conversationId', 'assistantMessageId', 'generation'],
      properties: streamRefProperties,
    }),
    modelChatCancelResponse: response('model.chat.cancel', {
      type: 'object', additionalProperties: false,
      required: ['streamId', 'cancelled'],
      properties: { streamId: boundedId, cancelled: { const: true } },
    }),
    modelChatDeltaEvent: {
      type: 'object', additionalProperties: false,
      required: ['protocolVersion', 'kind', 'event', 'payload'],
      properties: {
        protocolVersion, kind: { const: 'event' }, event: { const: 'model.chat.delta' },
        payload: {
          type: 'object', additionalProperties: false,
          required: ['streamId', 'conversationId', 'assistantMessageId', 'generation', 'textDelta'],
          properties: { ...streamRefProperties, textDelta: { type: 'string', maxLength: 100000 } },
        },
      },
    },
    modelChatCompletedEvent: {
      type: 'object', additionalProperties: false,
      required: ['protocolVersion', 'kind', 'event', 'payload'],
      properties: {
        protocolVersion, kind: { const: 'event' }, event: { const: 'model.chat.completed' },
        payload: {
          type: 'object', additionalProperties: false,
          required: ['streamId', 'conversationId', 'assistantMessageId', 'generation', 'text'],
          properties: { ...streamRefProperties, text: { type: 'string', maxLength: 500000 } },
        },
      },
    },
    modelChatFailedEvent: {
      type: 'object', additionalProperties: false,
      required: ['protocolVersion', 'kind', 'event', 'payload'],
      properties: {
        protocolVersion, kind: { const: 'event' }, event: { const: 'model.chat.failed' },
        payload: {
          type: 'object', additionalProperties: false,
          required: ['streamId', 'conversationId', 'assistantMessageId', 'generation', 'partialText', 'error'],
          properties: {
            ...streamRefProperties,
            partialText: { type: 'string', maxLength: 500000 },
            error: { $ref: '#/$defs/protocolError' },
          },
        },
      },
    },
    modelChatCancelledEvent: {
      type: 'object', additionalProperties: false,
      required: ['protocolVersion', 'kind', 'event', 'payload'],
      properties: {
        protocolVersion, kind: { const: 'event' }, event: { const: 'model.chat.cancelled' },
        payload: {
          type: 'object', additionalProperties: false,
          required: ['streamId', 'conversationId', 'assistantMessageId', 'generation', 'partialText'],
          properties: { ...streamRefProperties, partialText: { type: 'string', maxLength: 500000 } },
        },
      },
    },
  },
} as const;
