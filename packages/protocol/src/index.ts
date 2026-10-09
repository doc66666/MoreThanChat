export const HOST_PROTOCOL_VERSION = 1 as const;

export const HOST_METHODS = [
  "host.handshake",
  "diagnostics.ping",
  "host.shutdown",
  "plugins.list",
  "plugins.setEnabled",
  "tools.invoke",
  "model.getSettings",
  "model.setSettings",
  "model.chat.start",
  "model.chat.cancel",
  "pluginDrafts.inspect",
  "pluginDrafts.create",
  "pluginDrafts.validate",
  "pluginDrafts.diagnose",
  "pluginDrafts.install",
] as const;

export type HostMethod = (typeof HOST_METHODS)[number];

export const HOST_EVENTS = [
  "host.statusChanged",
  "model.chat.delta",
  "model.chat.completed",
  "model.chat.failed",
  "model.chat.cancelled",
] as const;

export type HostEvent = (typeof HOST_EVENTS)[number];

export const HOST_STATUS_STATES = [
  "starting",
  "ready",
  "restarting",
  "failed",
  "stopped",
] as const;

export type HostStatusState = (typeof HOST_STATUS_STATES)[number];

export const PROTOCOL_ERROR_CODES = [
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
  "PLUGIN_NOT_FOUND",
  "TOOL_UNAVAILABLE",
  "MODEL_NOT_CONFIGURED",
  "MODEL_REQUEST_FAILED",
  "MODEL_STREAM_NOT_FOUND",
  "CREDENTIAL_UNAVAILABLE",
  "DRAFT_NOT_FOUND",
] as const;

export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ProtocolErrorPayload {
  code: ProtocolErrorCode;
  message: string;
  retryable: boolean;
  details?: JsonValue;
}

export interface HostStatusSnapshot {
  state: HostStatusState;
  generation: number;
  error?: ProtocolErrorPayload;
}

export const HOST_PLUGIN_STATES = ['inactive', 'activating', 'active', 'deactivating', 'failed'] as const;
export interface HostPluginSnapshot {
  id: string;
  displayName: string;
  description: string;
  version: string;
  status: typeof HOST_PLUGIN_STATES[number];
  error: string | null;
  tools: { id: string; label: string }[];
  composerActions: { id: string; label: string }[];
}

export interface HostPluginCatalog {
  generation: number;
  plugins: HostPluginSnapshot[];
}

export const MODEL_PROVIDER_MODES = ["mock", "openai-compatible"] as const;
export type ModelProviderMode = (typeof MODEL_PROVIDER_MODES)[number];

export interface ModelChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Safe settings snapshot: never includes the raw API key. */
export interface ModelSettingsSnapshot {
  baseUrl: string;
  model: string;
  providerMode: ModelProviderMode;
  hasApiKey: boolean;
}

export interface ModelChatStreamRef {
  streamId: string;
  conversationId: string;
  assistantMessageId: string;
  generation: number;
}

export const PLUGIN_DRAFT_ISSUE_CODES = [
  "MANIFEST_INVALID",
  "SECRET_MATERIAL",
  "DANGEROUS_API",
  "EMPTY_SOURCE",
  "INSTALLED_ID",
  "NOT_DECLARATIVE",
  "NOT_INSTALLABLE",
  "CONFIRMATION_REQUIRED",
] as const;

export type PluginDraftIssueCode = (typeof PLUGIN_DRAFT_ISSUE_CODES)[number];

/** A draft finding. Messages are bounded and must not repeat source text or credentials. */
export interface PluginDraftIssue {
  severity: "error" | "warning";
  code: PluginDraftIssueCode;
  message: string;
}

export interface PluginDraftSummary {
  id: string;
  revision: number;
  displayName: string;
  version: string;
  updatedAt: number;
  ok: boolean;
}

export interface PluginDraftReport {
  draft: PluginDraftSummary;
  ok: boolean;
  summary: string;
  issues: PluginDraftIssue[];
}

export interface PluginDraftCreateResult {
  persisted: boolean;
  draft: PluginDraftSummary | null;
  ok: boolean;
  summary: string;
  issues: PluginDraftIssue[];
}

export interface PluginDraftInstalledRef {
  id: string;
  version: string;
  displayName: string;
  status: (typeof HOST_PLUGIN_STATES)[number];
}

export interface PluginDraftInspection {
  installed: PluginDraftInstalledRef[];
  drafts: PluginDraftSummary[];
}

/** Result of a confirmed declarative install. Tool text stays out of this payload. */
export interface PluginDraftInstallResult {
  installed: boolean;
  draft: PluginDraftSummary;
  ok: boolean;
  summary: string;
  issues: PluginDraftIssue[];
  catalog: HostPluginCatalog;
}

export interface HostRequestPayloadMap {
  "host.handshake": {
    clientName: string;
    clientVersion: string;
    supportedProtocolVersions: number[];
  };
  "diagnostics.ping": {
    sentAtMs: number;
  };
  "host.shutdown": {
    reason?: string;
  };
  "plugins.list": Record<string, never>;
  "plugins.setEnabled": { pluginId: string; enabled: boolean };
  "tools.invoke": { pluginId: string; toolId: string };
  "model.getSettings": Record<string, never>;
  "model.setSettings": {
    baseUrl?: string;
    model?: string;
    providerMode?: ModelProviderMode;
    apiKey?: string;
    clearApiKey?: boolean;
  };
  "model.chat.start": {
    streamId: string;
    conversationId: string;
    assistantMessageId: string;
    messages: ModelChatMessage[];
  };
  "model.chat.cancel": { streamId: string };
  "pluginDrafts.inspect": Record<string, never>;
  "pluginDrafts.create": { manifestJson: string; source: string };
  "pluginDrafts.validate": { draftId: string };
  "pluginDrafts.diagnose": { draftId: string };
  "pluginDrafts.install": { draftId: string; confirmed: boolean };
}

export interface HostResponsePayloadMap {
  "host.handshake": {
    selectedProtocolVersion: typeof HOST_PROTOCOL_VERSION;
    hostName: string;
    hostVersion: string;
    status: HostStatusSnapshot;
  };
  "diagnostics.ping": {
    sentAtMs: number;
    receivedAtMs: number;
  };
  "host.shutdown": {
    accepted: true;
  };
  "plugins.list": HostPluginCatalog;
  "plugins.setEnabled": HostPluginCatalog;
  "tools.invoke": { generation: number; text: string };
  "model.getSettings": ModelSettingsSnapshot;
  "model.setSettings": ModelSettingsSnapshot;
  "model.chat.start": ModelChatStreamRef;
  "model.chat.cancel": { streamId: string; cancelled: true };
  "pluginDrafts.inspect": PluginDraftInspection;
  "pluginDrafts.create": PluginDraftCreateResult;
  "pluginDrafts.validate": PluginDraftReport;
  "pluginDrafts.diagnose": PluginDraftReport;
  "pluginDrafts.install": PluginDraftInstallResult;
}

export interface HostEventPayloadMap {
  "host.statusChanged": HostStatusSnapshot;
  "model.chat.delta": ModelChatStreamRef & { textDelta: string };
  "model.chat.completed": ModelChatStreamRef & { text: string };
  "model.chat.failed": ModelChatStreamRef & { partialText: string; error: ProtocolErrorPayload };
  "model.chat.cancelled": ModelChatStreamRef & { partialText: string };
}

export interface HostRequestEnvelope<M extends HostMethod = HostMethod> {
  protocolVersion: typeof HOST_PROTOCOL_VERSION;
  kind: "request";
  requestId: string;
  method: M;
  payload: HostRequestPayloadMap[M];
}

export interface HostSuccessResponseEnvelope<M extends HostMethod = HostMethod> {
  protocolVersion: typeof HOST_PROTOCOL_VERSION;
  kind: "response";
  requestId: string;
  method: M;
  ok: true;
  payload: HostResponsePayloadMap[M];
}

export interface HostErrorResponseEnvelope<M extends HostMethod = HostMethod> {
  protocolVersion: typeof HOST_PROTOCOL_VERSION;
  kind: "response";
  requestId: string;
  method: M;
  ok: false;
  error: ProtocolErrorPayload;
}

export type HostResponseEnvelope<M extends HostMethod = HostMethod> =
  | HostSuccessResponseEnvelope<M>
  | HostErrorResponseEnvelope<M>;

export interface HostEventEnvelope<E extends HostEvent = HostEvent> {
  protocolVersion: typeof HOST_PROTOCOL_VERSION;
  kind: "event";
  event: E;
  payload: HostEventPayloadMap[E];
}

export type HostRequest = {
  [M in HostMethod]: HostRequestEnvelope<M>;
}[HostMethod];

export type HostResponse = {
  [M in HostMethod]: HostResponseEnvelope<M>;
}[HostMethod];

export type HostEventMessage = {
  [E in HostEvent]: HostEventEnvelope<E>;
}[HostEvent];

export type HostMessage = HostRequest | HostResponse | HostEventMessage;

export type ProtocolParseResult =
  | { success: true; data: HostMessage }
  | { success: false; error: ProtocolValidationError };

export class ProtocolValidationError extends Error {
  readonly code: ProtocolErrorCode;
  readonly path: string;

  constructor(code: ProtocolErrorCode, message: string, path = "$") {
    super(message);
    this.name = "ProtocolValidationError";
    this.code = code;
    this.path = path;
  }

  toPayload(): ProtocolErrorPayload {
    return {
      code: this.code,
      message: this.message,
      retryable: false,
      details: { path: this.path },
    };
  }
}

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && values.includes(value as T);

const asObject = (
  value: unknown,
  path: string,
  code: ProtocolErrorCode = "INVALID_MESSAGE",
): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolValidationError(code, `${path} must be an object`, path);
  }

  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new ProtocolValidationError(code, `${path} cannot contain symbol keys`, path);
  }

  return value as Record<string, unknown>;
};

const assertKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
  code: ProtocolErrorCode,
): void => {
  for (const key of required) {
    if (!hasOwn(value, key)) {
      throw new ProtocolValidationError(code, `${path}.${key} is required`, `${path}.${key}`);
    }
  }

  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ProtocolValidationError(
        code,
        `${path}.${key} is not allowed`,
        `${path}.${key}`,
      );
    }
  }
};

const parseNonEmptyString = (
  value: unknown,
  path: string,
  code: ProtocolErrorCode,
): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProtocolValidationError(code, `${path} must be a non-empty string`, path);
  }
  return value;
};

const parseBoundedId = (value: unknown, path: string): string => {
  const parsed = parseNonEmptyString(value, path, "INVALID_PAYLOAD");
  if (parsed.length > 256) {
    throw new ProtocolValidationError("INVALID_PAYLOAD", `${path} must not exceed 256 characters`, path);
  }
  return parsed;
};

const parseRequestId = (value: unknown): string => {
  const requestId = parseNonEmptyString(value, "$.requestId", "INVALID_MESSAGE");
  if (requestId.length > 256) {
    throw new ProtocolValidationError(
      "INVALID_MESSAGE",
      "$.requestId must not exceed 256 characters",
      "$.requestId",
    );
  }
  return requestId;
};

const parseFiniteNumber = (
  value: unknown,
  path: string,
  code: ProtocolErrorCode,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProtocolValidationError(code, `${path} must be a finite number`, path);
  }
  return value;
};

const parseGeneration = (value: unknown, path: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ProtocolValidationError(
      "INVALID_PAYLOAD",
      `${path} must be a non-negative safe integer`,
      path,
    );
  }
  return value;
};

const isJsonValue = (value: unknown, seen = new Set<object>()): value is JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object") {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  const prototype = Object.getPrototypeOf(value) as unknown;
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, seen))
    : (prototype === Object.prototype || prototype === null) &&
      Object.getOwnPropertySymbols(value).length === 0 &&
      Object.values(value).every((item) => isJsonValue(item, seen));
  seen.delete(value);
  return valid;
};

const parseProtocolError = (value: unknown, path: string): ProtocolErrorPayload => {
  const object = asObject(value, path, "INVALID_PAYLOAD");
  assertKeys(object, ["code", "message", "retryable"], ["details"], path, "INVALID_PAYLOAD");

  if (!isOneOf(PROTOCOL_ERROR_CODES, object.code)) {
    throw new ProtocolValidationError(
      "INVALID_PAYLOAD",
      `${path}.code is not a known protocol error code`,
      `${path}.code`,
    );
  }
  const message = parseNonEmptyString(object.message, `${path}.message`, "INVALID_PAYLOAD");
  if (typeof object.retryable !== "boolean") {
    throw new ProtocolValidationError(
      "INVALID_PAYLOAD",
      `${path}.retryable must be a boolean`,
      `${path}.retryable`,
    );
  }

  const result: ProtocolErrorPayload = {
    code: object.code,
    message,
    retryable: object.retryable,
  };
  if (hasOwn(object, "details")) {
    if (!isJsonValue(object.details)) {
      throw new ProtocolValidationError(
        "INVALID_PAYLOAD",
        `${path}.details must be a JSON value`,
        `${path}.details`,
      );
    }
    result.details = object.details;
  }
  return result;
};

export const parseHostStatusSnapshot = (value: unknown): HostStatusSnapshot => {
  const path = "$.payload";
  const object = asObject(value, path, "INVALID_PAYLOAD");
  assertKeys(object, ["state", "generation"], ["error"], path, "INVALID_PAYLOAD");
  if (!isOneOf(HOST_STATUS_STATES, object.state)) {
    throw new ProtocolValidationError(
      "INVALID_PAYLOAD",
      `${path}.state is not a known host state`,
      `${path}.state`,
    );
  }
  const result: HostStatusSnapshot = {
    state: object.state,
    generation: parseGeneration(object.generation, `${path}.generation`),
  };
  if (hasOwn(object, "error")) {
    result.error = parseProtocolError(object.error, `${path}.error`);
  }
  return result;
};

export const parseHostPluginCatalog = (value: unknown): HostPluginCatalog => {
  const object = asObject(value, '$.payload', 'INVALID_PAYLOAD');
  assertKeys(object, ['generation', 'plugins'], [], '$.payload', 'INVALID_PAYLOAD');
  if (!Array.isArray(object.plugins)) throw new ProtocolValidationError('INVALID_PAYLOAD', 'plugins must be an array');
  const plugins = object.plugins.map((value, index): HostPluginSnapshot => {
    const path = `$.payload.plugins[${index}]`;
    const plugin = asObject(value, path, 'INVALID_PAYLOAD');
    assertKeys(plugin, ['id', 'displayName', 'description', 'version', 'status', 'error', 'tools', 'composerActions'], [], path, 'INVALID_PAYLOAD');
    if (!isOneOf(HOST_PLUGIN_STATES, plugin.status) || (plugin.error !== null && typeof plugin.error !== 'string') || !Array.isArray(plugin.tools) || !Array.isArray(plugin.composerActions)) {
      throw new ProtocolValidationError('INVALID_PAYLOAD', 'Invalid plugin state, error, tools, or composer actions', path);
    }
    return {
      id: parseNonEmptyString(plugin.id, `${path}.id`, 'INVALID_PAYLOAD'),
      displayName: parseNonEmptyString(plugin.displayName, `${path}.displayName`, 'INVALID_PAYLOAD'),
      description: parseNonEmptyString(plugin.description, `${path}.description`, 'INVALID_PAYLOAD'),
      version: parseNonEmptyString(plugin.version, `${path}.version`, 'INVALID_PAYLOAD'),
      status: plugin.status,
      error: plugin.error as string | null,
      tools: plugin.tools.map((value, toolIndex) => parseContribution(value, `${path}.tools[${toolIndex}]`)),
      composerActions: plugin.composerActions.map((value, actionIndex) => parseContribution(value, `${path}.composerActions[${actionIndex}]`)),
    };
  });
  return { generation: parseGeneration(object.generation, '$.payload.generation'), plugins };
};

function parseContribution(value: unknown, path: string): { id: string; label: string } {
  const contribution = asObject(value, path, 'INVALID_PAYLOAD');
  assertKeys(contribution, ['id', 'label'], [], path, 'INVALID_PAYLOAD');
  return {
    id: parseNonEmptyString(contribution.id, `${path}.id`, 'INVALID_PAYLOAD'),
    label: parseNonEmptyString(contribution.label, `${path}.label`, 'INVALID_PAYLOAD'),
  };
}


export const parseModelSettingsSnapshot = (value: unknown, path = "$.payload"): ModelSettingsSnapshot => {
  const object = asObject(value, path, "INVALID_PAYLOAD");
  assertKeys(object, ["baseUrl", "model", "providerMode", "hasApiKey"], [], path, "INVALID_PAYLOAD");
  if (!isOneOf(MODEL_PROVIDER_MODES, object.providerMode)) {
    throw new ProtocolValidationError(
      "INVALID_PAYLOAD",
      `${path}.providerMode is not a known model provider mode`,
      `${path}.providerMode`,
    );
  }
  if (typeof object.hasApiKey !== "boolean") {
    throw new ProtocolValidationError(
      "INVALID_PAYLOAD",
      `${path}.hasApiKey must be a boolean`,
      `${path}.hasApiKey`,
    );
  }
  return {
    baseUrl: parseNonEmptyString(object.baseUrl, `${path}.baseUrl`, "INVALID_PAYLOAD"),
    model: parseNonEmptyString(object.model, `${path}.model`, "INVALID_PAYLOAD"),
    providerMode: object.providerMode,
    hasApiKey: object.hasApiKey,
  };
};

const parseModelChatMessages = (value: unknown, path: string): ModelChatMessage[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ProtocolValidationError("INVALID_PAYLOAD", `${path} must be a non-empty array`, path);
  }
  if (value.length > 200) {
    throw new ProtocolValidationError("INVALID_PAYLOAD", `${path} must not exceed 200 messages`, path);
  }
  const roles = ["system", "user", "assistant"] as const;
  return value.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const object = asObject(item, itemPath, "INVALID_PAYLOAD");
    assertKeys(object, ["role", "content"], [], itemPath, "INVALID_PAYLOAD");
    if (!isOneOf(roles, object.role)) {
      throw new ProtocolValidationError("INVALID_PAYLOAD", `${itemPath}.role is invalid`, `${itemPath}.role`);
    }
    if (typeof object.content !== "string" || object.content.length > 100_000) {
      throw new ProtocolValidationError(
        "INVALID_PAYLOAD",
        `${itemPath}.content must be a string up to 100000 characters`,
        `${itemPath}.content`,
      );
    }
    return { role: object.role, content: object.content };
  });
};

const parseModelSetSettingsRequest = (value: unknown): HostRequestPayloadMap["model.setSettings"] => {
  const path = "$.payload";
  const object = asObject(value, path, "INVALID_PAYLOAD");
  assertKeys(object, [], ["baseUrl", "model", "providerMode", "apiKey", "clearApiKey"], path, "INVALID_PAYLOAD");
  const result: HostRequestPayloadMap["model.setSettings"] = {};
  if (hasOwn(object, "baseUrl")) {
    result.baseUrl = parseNonEmptyString(object.baseUrl, `${path}.baseUrl`, "INVALID_PAYLOAD");
    if (result.baseUrl.length > 2048) {
      throw new ProtocolValidationError("INVALID_PAYLOAD", "baseUrl is too long", `${path}.baseUrl`);
    }
  }
  if (hasOwn(object, "model")) {
    result.model = parseNonEmptyString(object.model, `${path}.model`, "INVALID_PAYLOAD");
    if (result.model.length > 256) {
      throw new ProtocolValidationError("INVALID_PAYLOAD", "model is too long", `${path}.model`);
    }
  }
  if (hasOwn(object, "providerMode")) {
    if (!isOneOf(MODEL_PROVIDER_MODES, object.providerMode)) {
      throw new ProtocolValidationError("INVALID_PAYLOAD", "providerMode is invalid", `${path}.providerMode`);
    }
    result.providerMode = object.providerMode;
  }
  if (hasOwn(object, "apiKey")) {
    if (typeof object.apiKey !== "string" || object.apiKey.trim().length === 0 || object.apiKey.length > 4096) {
      throw new ProtocolValidationError(
        "INVALID_PAYLOAD",
        `${path}.apiKey must be a non-empty string up to 4096 characters`,
        `${path}.apiKey`,
      );
    }
    result.apiKey = object.apiKey;
  }
  if (hasOwn(object, "clearApiKey")) {
    if (typeof object.clearApiKey !== "boolean") {
      throw new ProtocolValidationError("INVALID_PAYLOAD", "clearApiKey must be a boolean", `${path}.clearApiKey`);
    }
    result.clearApiKey = object.clearApiKey;
  }
  return result;
};

const parseModelChatStartRequest = (value: unknown): HostRequestPayloadMap["model.chat.start"] => {
  const path = "$.payload";
  const object = asObject(value, path, "INVALID_PAYLOAD");
  assertKeys(
    object,
    ["streamId", "conversationId", "assistantMessageId", "messages"],
    [],
    path,
    "INVALID_PAYLOAD",
  );
  return {
    streamId: parseBoundedId(object.streamId, `${path}.streamId`),
    conversationId: parseBoundedId(object.conversationId, `${path}.conversationId`),
    assistantMessageId: parseBoundedId(object.assistantMessageId, `${path}.assistantMessageId`),
    messages: parseModelChatMessages(object.messages, `${path}.messages`),
  };
};

const parseModelChatCancelRequest = (value: unknown): HostRequestPayloadMap["model.chat.cancel"] => {
  const path = "$.payload";
  const object = asObject(value, path, "INVALID_PAYLOAD");
  assertKeys(object, ["streamId"], [], path, "INVALID_PAYLOAD");
  return { streamId: parseBoundedId(object.streamId, `${path}.streamId`) };
};

const parseModelChatStreamRef = (value: unknown, path: string): ModelChatStreamRef => {
  const object = asObject(value, path, "INVALID_PAYLOAD");
  return {
    streamId: parseBoundedId(object.streamId, `${path}.streamId`),
    conversationId: parseBoundedId(object.conversationId, `${path}.conversationId`),
    assistantMessageId: parseBoundedId(object.assistantMessageId, `${path}.assistantMessageId`),
    generation: parseGeneration(object.generation, `${path}.generation`),
  };
};

export const parseModelChatDeltaEvent = (value: unknown): HostEventPayloadMap["model.chat.delta"] => {
  const path = "$.payload";
  const object = asObject(value, path, "INVALID_PAYLOAD");
  assertKeys(
    object,
    ["streamId", "conversationId", "assistantMessageId", "generation", "textDelta"],
    [],
    path,
    "INVALID_PAYLOAD",
  );
  if (typeof object.textDelta !== "string" || object.textDelta.length > 100_000) {
    throw new ProtocolValidationError("INVALID_PAYLOAD", "textDelta must be a string", `${path}.textDelta`);
  }
  return { ...parseModelChatStreamRef(object, path), textDelta: object.textDelta };
};

export const parseModelChatCompletedEvent = (value: unknown): HostEventPayloadMap["model.chat.completed"] => {
  const path = "$.payload";
  const object = asObject(value, path, "INVALID_PAYLOAD");
  assertKeys(
    object,
    ["streamId", "conversationId", "assistantMessageId", "generation", "text"],
    [],
    path,
    "INVALID_PAYLOAD",
  );
  if (typeof object.text !== "string" || object.text.length > 500_000) {
    throw new ProtocolValidationError("INVALID_PAYLOAD", "text must be a string", `${path}.text`);
  }
  return { ...parseModelChatStreamRef(object, path), text: object.text };
};

export const parseModelChatFailedEvent = (value: unknown): HostEventPayloadMap["model.chat.failed"] => {
  const path = "$.payload";
  const object = asObject(value, path, "INVALID_PAYLOAD");
  assertKeys(
    object,
    ["streamId", "conversationId", "assistantMessageId", "generation", "partialText", "error"],
    [],
    path,
    "INVALID_PAYLOAD",
  );
  if (typeof object.partialText !== "string" || object.partialText.length > 500_000) {
    throw new ProtocolValidationError("INVALID_PAYLOAD", "partialText must be a string", `${path}.partialText`);
  }
  return {
    ...parseModelChatStreamRef(object, path),
    partialText: object.partialText,
    error: parseProtocolError(object.error, `${path}.error`),
  };
};

export const parseModelChatCancelledEvent = (value: unknown): HostEventPayloadMap["model.chat.cancelled"] => {
  const path = "$.payload";
  const object = asObject(value, path, "INVALID_PAYLOAD");
  assertKeys(
    object,
    ["streamId", "conversationId", "assistantMessageId", "generation", "partialText"],
    [],
    path,
    "INVALID_PAYLOAD",
  );
  if (typeof object.partialText !== "string" || object.partialText.length > 500_000) {
    throw new ProtocolValidationError("INVALID_PAYLOAD", "partialText must be a string", `${path}.partialText`);
  }
  return { ...parseModelChatStreamRef(object, path), partialText: object.partialText };
};


const parsePluginRequest = (method: 'plugins.list' | 'plugins.setEnabled' | 'tools.invoke', value: unknown) => {
  const object = asObject(value, '$.payload', 'INVALID_PAYLOAD');
  const keys = method === 'plugins.list' ? [] : method === 'plugins.setEnabled' ? ['pluginId', 'enabled'] : ['pluginId', 'toolId'];
  assertKeys(object, keys, [], '$.payload', 'INVALID_PAYLOAD');
  if (method === 'plugins.list') return {};
  const pluginId = parseNonEmptyString(object.pluginId, '$.payload.pluginId', 'INVALID_PAYLOAD');
  if (method === 'tools.invoke') return { pluginId, toolId: parseNonEmptyString(object.toolId, '$.payload.toolId', 'INVALID_PAYLOAD') };
  if (typeof object.enabled !== 'boolean') throw new ProtocolValidationError('INVALID_PAYLOAD', 'enabled must be a boolean');
  return { pluginId, enabled: object.enabled };
};

const parseHandshakeRequest = (
  value: unknown,
): HostRequestPayloadMap["host.handshake"] => {
  const path = "$.payload";
  const object = asObject(value, path, "INVALID_PAYLOAD");
  assertKeys(
    object,
    ["clientName", "clientVersion", "supportedProtocolVersions"],
    [],
    path,
    "INVALID_PAYLOAD",
  );
  if (!Array.isArray(object.supportedProtocolVersions)) {
    throw new ProtocolValidationError(
      "INVALID_PAYLOAD",
      `${path}.supportedProtocolVersions must be an array`,
      `${path}.supportedProtocolVersions`,
    );
  }
  const versions = object.supportedProtocolVersions;
  if (
    versions.length === 0 ||
    versions.some((version) => !Number.isSafeInteger(version) || version < 1) ||
    new Set(versions).size !== versions.length
  ) {
    throw new ProtocolValidationError(
      "INVALID_PAYLOAD",
      `${path}.supportedProtocolVersions must contain unique positive integers`,
      `${path}.supportedProtocolVersions`,
    );
  }
  if (!versions.includes(HOST_PROTOCOL_VERSION)) {
    throw new ProtocolValidationError(
      "UNSUPPORTED_PROTOCOL_VERSION",
      `${path}.supportedProtocolVersions must include ${HOST_PROTOCOL_VERSION}`,
      `${path}.supportedProtocolVersions`,
    );
  }
  return {
    clientName: parseNonEmptyString(object.clientName, `${path}.clientName`, "INVALID_PAYLOAD"),
    clientVersion: parseNonEmptyString(
      object.clientVersion,
      `${path}.clientVersion`,
      "INVALID_PAYLOAD",
    ),
    supportedProtocolVersions: [...versions] as number[],
  };
};

const parsePingRequest = (value: unknown): HostRequestPayloadMap["diagnostics.ping"] => {
  const path = "$.payload";
  const object = asObject(value, path, "INVALID_PAYLOAD");
  assertKeys(object, ["sentAtMs"], [], path, "INVALID_PAYLOAD");
  return {
    sentAtMs: parseFiniteNumber(object.sentAtMs, `${path}.sentAtMs`, "INVALID_PAYLOAD"),
  };
};

const parseShutdownRequest = (value: unknown): HostRequestPayloadMap["host.shutdown"] => {
  const path = "$.payload";
  const object = asObject(value, path, "INVALID_PAYLOAD");
  assertKeys(object, [], ["reason"], path, "INVALID_PAYLOAD");
  if (!hasOwn(object, "reason")) {
    return {};
  }
  return {
    reason: parseNonEmptyString(object.reason, `${path}.reason`, "INVALID_PAYLOAD"),
  };
};

const parseBoundedText = (value: unknown, path: string, maxLength: number, allowEmpty = false): string => {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0) || value.length > maxLength) {
    throw new ProtocolValidationError("INVALID_PAYLOAD", `${path} must be a string within ${maxLength} characters`, path);
  }
  return value;
};

const parseDraftIssue = (value: unknown, path: string): PluginDraftIssue => {
  const object = asObject(value, path, "INVALID_PAYLOAD");
  assertKeys(object, ["severity", "code", "message"], [], path, "INVALID_PAYLOAD");
  if (object.severity !== "error" && object.severity !== "warning") {
    throw new ProtocolValidationError("INVALID_PAYLOAD", `${path}.severity is invalid`, `${path}.severity`);
  }
  if (!isOneOf(PLUGIN_DRAFT_ISSUE_CODES, object.code)) {
    throw new ProtocolValidationError("INVALID_PAYLOAD", `${path}.code is invalid`, `${path}.code`);
  }
  return {
    severity: object.severity,
    code: object.code,
    message: parseBoundedText(object.message, `${path}.message`, 240),
  };
};

const parseDraftIssues = (value: unknown, path: string): PluginDraftIssue[] => {
  if (!Array.isArray(value) || value.length > 20) {
    throw new ProtocolValidationError("INVALID_PAYLOAD", `${path} must be an array of at most 20 issues`, path);
  }
  return value.map((issue, index) => parseDraftIssue(issue, `${path}[${index}]`));
};

const parseDraftSummary = (value: unknown, path: string): PluginDraftSummary => {
  const object = asObject(value, path, "INVALID_PAYLOAD");
  assertKeys(object, ["id", "revision", "displayName", "version", "updatedAt", "ok"], [], path, "INVALID_PAYLOAD");
  if (typeof object.revision !== "number" || !Number.isSafeInteger(object.revision) || object.revision < 1) {
    throw new ProtocolValidationError("INVALID_PAYLOAD", `${path}.revision must be a positive integer`, `${path}.revision`);
  }
  if (typeof object.updatedAt !== "number" || !Number.isSafeInteger(object.updatedAt) || object.updatedAt < 0) {
    throw new ProtocolValidationError("INVALID_PAYLOAD", `${path}.updatedAt must be a non-negative integer`, `${path}.updatedAt`);
  }
  if (typeof object.ok !== "boolean") {
    throw new ProtocolValidationError("INVALID_PAYLOAD", `${path}.ok must be a boolean`, `${path}.ok`);
  }
  return {
    id: parseBoundedText(object.id, `${path}.id`, 128),
    revision: object.revision,
    displayName: parseBoundedText(object.displayName, `${path}.displayName`, 80),
    version: parseBoundedText(object.version, `${path}.version`, 32),
    updatedAt: object.updatedAt,
    ok: object.ok,
  };
};

const parseDraftDiagnosis = (object: Record<string, unknown>, path: string): Pick<PluginDraftReport, "ok" | "summary" | "issues"> => {
  if (typeof object.ok !== "boolean") {
    throw new ProtocolValidationError("INVALID_PAYLOAD", `${path}.ok must be a boolean`, `${path}.ok`);
  }
  return {
    ok: object.ok,
    summary: parseBoundedText(object.summary, `${path}.summary`, 500),
    issues: parseDraftIssues(object.issues, `${path}.issues`),
  };
};

const parsePluginDraftInspection = (value: unknown): PluginDraftInspection => {
  const path = "$.payload";
  const object = asObject(value, path, "INVALID_PAYLOAD");
  assertKeys(object, ["installed", "drafts"], [], path, "INVALID_PAYLOAD");
  if (!Array.isArray(object.installed) || object.installed.length > 100 || !Array.isArray(object.drafts) || object.drafts.length > 100) {
    throw new ProtocolValidationError("INVALID_PAYLOAD", `${path} lists are too large`, path);
  }
  return {
    installed: object.installed.map((item, index) => {
      const entryPath = `${path}.installed[${index}]`;
      const entry = asObject(item, entryPath, "INVALID_PAYLOAD");
      assertKeys(entry, ["id", "version", "displayName", "status"], [], entryPath, "INVALID_PAYLOAD");
      if (!isOneOf(HOST_PLUGIN_STATES, entry.status)) {
        throw new ProtocolValidationError("INVALID_PAYLOAD", `${entryPath}.status is invalid`, `${entryPath}.status`);
      }
      return {
        id: parseBoundedText(entry.id, `${entryPath}.id`, 128),
        version: parseBoundedText(entry.version, `${entryPath}.version`, 32),
        displayName: parseBoundedText(entry.displayName, `${entryPath}.displayName`, 80),
        status: entry.status,
      };
    }),
    drafts: object.drafts.map((item, index) => parseDraftSummary(item, `${path}.drafts[${index}]`)),
  };
};

const parsePluginDraftCreateResult = (value: unknown): PluginDraftCreateResult => {
  const path = "$.payload";
  const object = asObject(value, path, "INVALID_PAYLOAD");
  assertKeys(object, ["persisted", "draft", "ok", "summary", "issues"], [], path, "INVALID_PAYLOAD");
  if (typeof object.persisted !== "boolean") {
    throw new ProtocolValidationError("INVALID_PAYLOAD", `${path}.persisted must be a boolean`, `${path}.persisted`);
  }
  return {
    persisted: object.persisted,
    draft: object.draft === null ? null : parseDraftSummary(object.draft, `${path}.draft`),
    ...parseDraftDiagnosis(object, path),
  };
};

const parsePluginDraftReport = (value: unknown): PluginDraftReport => {
  const path = "$.payload";
  const object = asObject(value, path, "INVALID_PAYLOAD");
  assertKeys(object, ["draft", "ok", "summary", "issues"], [], path, "INVALID_PAYLOAD");
  return { draft: parseDraftSummary(object.draft, `${path}.draft`), ...parseDraftDiagnosis(object, path) };
};

const parsePluginDraftInstallResult = (value: unknown): PluginDraftInstallResult => {
  const path = "$.payload";
  const object = asObject(value, path, "INVALID_PAYLOAD");
  assertKeys(object, ["installed", "draft", "ok", "summary", "issues", "catalog"], [], path, "INVALID_PAYLOAD");
  if (typeof object.installed !== "boolean") {
    throw new ProtocolValidationError("INVALID_PAYLOAD", `${path}.installed must be a boolean`, `${path}.installed`);
  }
  return {
    installed: object.installed,
    draft: parseDraftSummary(object.draft, `${path}.draft`),
    ...parseDraftDiagnosis(object, path),
    catalog: parseHostPluginCatalog(object.catalog),
  };
};

const parseRequestPayload = <M extends HostMethod>(
  method: M,
  value: unknown,
): HostRequestPayloadMap[M] => {
  switch (method) {
    case "host.handshake":
      return parseHandshakeRequest(value) as HostRequestPayloadMap[M];
    case "diagnostics.ping":
      return parsePingRequest(value) as HostRequestPayloadMap[M];
    case "host.shutdown":
      return parseShutdownRequest(value) as HostRequestPayloadMap[M];
    case "plugins.list":
    case "plugins.setEnabled":
    case "tools.invoke":
      return parsePluginRequest(method, value) as HostRequestPayloadMap[M];
    case "model.getSettings": {
      const object = asObject(value, "$.payload", "INVALID_PAYLOAD");
      assertKeys(object, [], [], "$.payload", "INVALID_PAYLOAD");
      return {} as HostRequestPayloadMap[M];
    }
    case "model.setSettings":
      return parseModelSetSettingsRequest(value) as HostRequestPayloadMap[M];
    case "model.chat.start":
      return parseModelChatStartRequest(value) as HostRequestPayloadMap[M];
    case "model.chat.cancel":
      return parseModelChatCancelRequest(value) as HostRequestPayloadMap[M];
    case "pluginDrafts.inspect": {
      const object = asObject(value, "$.payload", "INVALID_PAYLOAD");
      assertKeys(object, [], [], "$.payload", "INVALID_PAYLOAD");
      return {} as HostRequestPayloadMap[M];
    }
    case "pluginDrafts.create": {
      const object = asObject(value, "$.payload", "INVALID_PAYLOAD");
      assertKeys(object, ["manifestJson", "source"], [], "$.payload", "INVALID_PAYLOAD");
      return {
        manifestJson: parseBoundedText(object.manifestJson, "$.payload.manifestJson", 20_000),
        source: parseBoundedText(object.source, "$.payload.source", 100_000, true),
      } as HostRequestPayloadMap[M];
    }
    case "pluginDrafts.validate":
    case "pluginDrafts.diagnose": {
      const object = asObject(value, "$.payload", "INVALID_PAYLOAD");
      assertKeys(object, ["draftId"], [], "$.payload", "INVALID_PAYLOAD");
      return { draftId: parseBoundedText(object.draftId, "$.payload.draftId", 128) } as HostRequestPayloadMap[M];
    }
    case "pluginDrafts.install": {
      const object = asObject(value, "$.payload", "INVALID_PAYLOAD");
      assertKeys(object, ["draftId", "confirmed"], [], "$.payload", "INVALID_PAYLOAD");
      if (typeof object.confirmed !== "boolean") {
        throw new ProtocolValidationError("INVALID_PAYLOAD", "$.payload.confirmed must be a boolean", "$.payload.confirmed");
      }
      return {
        draftId: parseBoundedText(object.draftId, "$.payload.draftId", 128),
        confirmed: object.confirmed,
      } as HostRequestPayloadMap[M];
    }
  }
};

const parseHandshakeResponse = (
  value: unknown,
): HostResponsePayloadMap["host.handshake"] => {
  const path = "$.payload";
  const object = asObject(value, path, "INVALID_PAYLOAD");
  assertKeys(
    object,
    ["selectedProtocolVersion", "hostName", "hostVersion", "status"],
    [],
    path,
    "INVALID_PAYLOAD",
  );
  if (object.selectedProtocolVersion !== HOST_PROTOCOL_VERSION) {
    throw new ProtocolValidationError(
      "UNSUPPORTED_PROTOCOL_VERSION",
      `${path}.selectedProtocolVersion must be ${HOST_PROTOCOL_VERSION}`,
      `${path}.selectedProtocolVersion`,
    );
  }
  return {
    selectedProtocolVersion: HOST_PROTOCOL_VERSION,
    hostName: parseNonEmptyString(object.hostName, `${path}.hostName`, "INVALID_PAYLOAD"),
    hostVersion: parseNonEmptyString(object.hostVersion, `${path}.hostVersion`, "INVALID_PAYLOAD"),
    status: parseHostStatusSnapshot(object.status),
  };
};

const parsePingResponse = (
  value: unknown,
): HostResponsePayloadMap["diagnostics.ping"] => {
  const path = "$.payload";
  const object = asObject(value, path, "INVALID_PAYLOAD");
  assertKeys(object, ["sentAtMs", "receivedAtMs"], [], path, "INVALID_PAYLOAD");
  return {
    sentAtMs: parseFiniteNumber(object.sentAtMs, `${path}.sentAtMs`, "INVALID_PAYLOAD"),
    receivedAtMs: parseFiniteNumber(
      object.receivedAtMs,
      `${path}.receivedAtMs`,
      "INVALID_PAYLOAD",
    ),
  };
};

const parseShutdownResponse = (
  value: unknown,
): HostResponsePayloadMap["host.shutdown"] => {
  const path = "$.payload";
  const object = asObject(value, path, "INVALID_PAYLOAD");
  assertKeys(object, ["accepted"], [], path, "INVALID_PAYLOAD");
  if (object.accepted !== true) {
    throw new ProtocolValidationError(
      "INVALID_PAYLOAD",
      `${path}.accepted must be true`,
      `${path}.accepted`,
    );
  }
  return { accepted: true };
};

const parseResponsePayload = <M extends HostMethod>(
  method: M,
  value: unknown,
): HostResponsePayloadMap[M] => {
  switch (method) {
    case "host.handshake":
      return parseHandshakeResponse(value) as HostResponsePayloadMap[M];
    case "diagnostics.ping":
      return parsePingResponse(value) as HostResponsePayloadMap[M];
    case "host.shutdown":
      return parseShutdownResponse(value) as HostResponsePayloadMap[M];
    case "plugins.list":
    case "plugins.setEnabled":
      return parseHostPluginCatalog(value) as HostResponsePayloadMap[M];
    case "tools.invoke": {
      const object = asObject(value, '$.payload', 'INVALID_PAYLOAD');
      assertKeys(object, ['generation', 'text'], [], '$.payload', 'INVALID_PAYLOAD');
      return {
        generation: parseGeneration(object.generation, '$.payload.generation'),
        text: parseNonEmptyString(object.text, '$.payload.text', 'INVALID_PAYLOAD'),
      } as HostResponsePayloadMap[M];
    }
    case "model.getSettings":
    case "model.setSettings":
      return parseModelSettingsSnapshot(value) as HostResponsePayloadMap[M];
    case "model.chat.start": {
      const object = asObject(value, "$.payload", "INVALID_PAYLOAD");
      assertKeys(
        object,
        ["streamId", "conversationId", "assistantMessageId", "generation"],
        [],
        "$.payload",
        "INVALID_PAYLOAD",
      );
      return parseModelChatStreamRef(object, "$.payload") as HostResponsePayloadMap[M];
    }
    case "model.chat.cancel": {
      const object = asObject(value, "$.payload", "INVALID_PAYLOAD");
      assertKeys(object, ["streamId", "cancelled"], [], "$.payload", "INVALID_PAYLOAD");
      if (object.cancelled !== true) {
        throw new ProtocolValidationError("INVALID_PAYLOAD", "cancelled must be true", "$.payload.cancelled");
      }
      return {
        streamId: parseBoundedId(object.streamId, "$.payload.streamId"),
        cancelled: true as const,
      } as HostResponsePayloadMap[M];
    }
    case "pluginDrafts.inspect":
      return parsePluginDraftInspection(value) as HostResponsePayloadMap[M];
    case "pluginDrafts.create":
      return parsePluginDraftCreateResult(value) as HostResponsePayloadMap[M];
    case "pluginDrafts.validate":
    case "pluginDrafts.diagnose":
      return parsePluginDraftReport(value) as HostResponsePayloadMap[M];
    case "pluginDrafts.install":
      return parsePluginDraftInstallResult(value) as HostResponsePayloadMap[M];
  }
};

const parseVersion = (value: Record<string, unknown>): void => {
  if (!hasOwn(value, "protocolVersion")) {
    throw new ProtocolValidationError(
      "INVALID_MESSAGE",
      "$.protocolVersion is required",
      "$.protocolVersion",
    );
  }
  if (value.protocolVersion !== HOST_PROTOCOL_VERSION) {
    throw new ProtocolValidationError(
      "UNSUPPORTED_PROTOCOL_VERSION",
      `Unsupported protocol version: ${String(value.protocolVersion)}`,
      "$.protocolVersion",
    );
  }
};

const parseMethod = (value: unknown): HostMethod => {
  if (!isOneOf(HOST_METHODS, value)) {
    throw new ProtocolValidationError(
      "UNKNOWN_METHOD",
      `Unknown host method: ${String(value)}`,
      "$.method",
    );
  }
  return value;
};

const parseRequest = (object: Record<string, unknown>): HostRequest => {
  assertKeys(
    object,
    ["protocolVersion", "kind", "requestId", "method", "payload"],
    [],
    "$",
    "INVALID_MESSAGE",
  );
  const requestId = parseRequestId(object.requestId);
  const method = parseMethod(object.method);
  return {
    protocolVersion: HOST_PROTOCOL_VERSION,
    kind: "request",
    requestId,
    method,
    payload: parseRequestPayload(method, object.payload),
  } as HostRequest;
};

const parseResponse = (object: Record<string, unknown>): HostResponse => {
  if (typeof object.ok !== "boolean") {
    throw new ProtocolValidationError(
      "INVALID_MESSAGE",
      "$.ok must be a boolean",
      "$.ok",
    );
  }
  assertKeys(
    object,
    object.ok
      ? ["protocolVersion", "kind", "requestId", "method", "ok", "payload"]
      : ["protocolVersion", "kind", "requestId", "method", "ok", "error"],
    [],
    "$",
    "INVALID_MESSAGE",
  );
  const requestId = parseRequestId(object.requestId);
  const method = parseMethod(object.method);
  if (object.ok) {
    return {
      protocolVersion: HOST_PROTOCOL_VERSION,
      kind: "response",
      requestId,
      method,
      ok: true,
      payload: parseResponsePayload(method, object.payload),
    } as HostResponse;
  }
  return {
    protocolVersion: HOST_PROTOCOL_VERSION,
    kind: "response",
    requestId,
    method,
    ok: false,
    error: parseProtocolError(object.error, "$.error"),
  } as HostResponse;
};

const parseEvent = (object: Record<string, unknown>): HostEventMessage => {
  assertKeys(object, ["protocolVersion", "kind", "event", "payload"], [], "$", "INVALID_MESSAGE");
  if (!isOneOf(HOST_EVENTS, object.event)) {
    throw new ProtocolValidationError(
      "UNKNOWN_EVENT",
      `Unknown host event: ${String(object.event)}`,
      "$.event",
    );
  }
  switch (object.event) {
    case "host.statusChanged":
      return {
        protocolVersion: HOST_PROTOCOL_VERSION,
        kind: "event",
        event: "host.statusChanged",
        payload: parseHostStatusSnapshot(object.payload),
      };
    case "model.chat.delta":
      return {
        protocolVersion: HOST_PROTOCOL_VERSION,
        kind: "event",
        event: "model.chat.delta",
        payload: parseModelChatDeltaEvent(object.payload),
      };
    case "model.chat.completed":
      return {
        protocolVersion: HOST_PROTOCOL_VERSION,
        kind: "event",
        event: "model.chat.completed",
        payload: parseModelChatCompletedEvent(object.payload),
      };
    case "model.chat.failed":
      return {
        protocolVersion: HOST_PROTOCOL_VERSION,
        kind: "event",
        event: "model.chat.failed",
        payload: parseModelChatFailedEvent(object.payload),
      };
    case "model.chat.cancelled":
      return {
        protocolVersion: HOST_PROTOCOL_VERSION,
        kind: "event",
        event: "model.chat.cancelled",
        payload: parseModelChatCancelledEvent(object.payload),
      };
  }
};

export const parseHostMessage = (value: unknown): HostMessage => {
  const object = asObject(value, "$", "INVALID_MESSAGE");
  parseVersion(object);
  if (object.kind === "request") {
    return parseRequest(object);
  }
  if (object.kind === "response") {
    return parseResponse(object);
  }
  if (object.kind === "event") {
    return parseEvent(object);
  }
  throw new ProtocolValidationError(
    "UNKNOWN_KIND",
    `Unknown message kind: ${String(object.kind)}`,
    "$.kind",
  );
};

export const safeParseHostMessage = (value: unknown): ProtocolParseResult => {
  try {
    return { success: true, data: parseHostMessage(value) };
  } catch (error) {
    if (error instanceof ProtocolValidationError) {
      return { success: false, error };
    }
    return {
      success: false,
      error: new ProtocolValidationError(
        "INVALID_MESSAGE",
        error instanceof Error ? error.message : "Unknown protocol validation failure",
      ),
    };
  }
};

export const createHostRequest = <M extends HostMethod>(
  method: M,
  requestId: string,
  payload: HostRequestPayloadMap[M],
): HostRequestEnvelope<M> => ({
  protocolVersion: HOST_PROTOCOL_VERSION,
  kind: "request",
  requestId,
  method,
  payload,
});

export const createHostSuccessResponse = <M extends HostMethod>(
  request: Pick<HostRequestEnvelope<M>, "requestId" | "method">,
  payload: HostResponsePayloadMap[M],
): HostSuccessResponseEnvelope<M> => ({
  protocolVersion: HOST_PROTOCOL_VERSION,
  kind: "response",
  requestId: request.requestId,
  method: request.method,
  ok: true,
  payload,
});

export const createHostErrorResponse = <M extends HostMethod>(
  request: Pick<HostRequestEnvelope<M>, "requestId" | "method">,
  error: ProtocolErrorPayload,
): HostErrorResponseEnvelope<M> => ({
  protocolVersion: HOST_PROTOCOL_VERSION,
  kind: "response",
  requestId: request.requestId,
  method: request.method,
  ok: false,
  error,
});

export const createHostEvent = <E extends HostEvent>(
  event: E,
  payload: HostEventPayloadMap[E],
): HostEventEnvelope<E> => ({
  protocolVersion: HOST_PROTOCOL_VERSION,
  kind: "event",
  event,
  payload,
});

export const isResponseForRequest = (
  request: Pick<HostRequestEnvelope, "requestId" | "method">,
  response: Pick<HostResponseEnvelope, "requestId" | "method">,
): boolean => request.requestId === response.requestId && request.method === response.method;

export const assertResponseForRequest = (
  request: Pick<HostRequestEnvelope, "requestId" | "method">,
  response: Pick<HostResponseEnvelope, "requestId" | "method">,
): void => {
  if (!isResponseForRequest(request, response)) {
    throw new ProtocolValidationError(
      "RESPONSE_MISMATCH",
      `Response ${response.requestId}/${response.method} does not match request ${request.requestId}/${request.method}`,
      "$.requestId",
    );
  }
};

export { HOST_PROTOCOL_V1_JSON_SCHEMA } from "./schema";
