import { describe, expect, it } from "vitest";

import {
  HOST_PROTOCOL_V1_JSON_SCHEMA,
  HOST_PROTOCOL_VERSION,
  ProtocolValidationError,
  assertResponseForRequest,
  createHostErrorResponse,
  createHostEvent,
  createHostRequest,
  createHostSuccessResponse,
  isResponseForRequest,
  parseHostMessage,
  safeParseHostMessage,
  type ProtocolErrorCode,
} from "../src";

const expectProtocolError = (value: unknown, code: ProtocolErrorCode): void => {
  try {
    parseHostMessage(value);
    throw new Error("Expected protocol parsing to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolValidationError);
    expect((error as ProtocolValidationError).code).toBe(code);
  }
};

describe("Host protocol v1", () => {
  it("parses each legal request method", () => {
    const handshake = createHostRequest("host.handshake", "req-handshake", {
      clientName: "desktop",
      clientVersion: "0.1.0",
      supportedProtocolVersions: [HOST_PROTOCOL_VERSION],
    });
    const ping = createHostRequest("diagnostics.ping", "req-ping", { sentAtMs: 42 });
    const shutdown = createHostRequest("host.shutdown", "req-shutdown", {
      reason: "application quit",
    });

    expect(parseHostMessage(handshake)).toEqual(handshake);
    expect(parseHostMessage(ping)).toEqual(ping);
    expect(parseHostMessage(shutdown)).toEqual(shutdown);
  });

  it("parses success responses, structured failures, and status events", () => {
    const handshake = createHostRequest("host.handshake", "req-1", {
      clientName: "desktop",
      clientVersion: "0.1.0",
      supportedProtocolVersions: [1],
    });
    const success = createHostSuccessResponse(handshake, {
      selectedProtocolVersion: 1,
      hostName: "pc-host",
      hostVersion: "0.1.0",
      status: { state: "ready", generation: 3 },
    });
    const ping = createHostRequest("diagnostics.ping", "req-ping", { sentAtMs: 40 });
    const pingSuccess = createHostSuccessResponse(ping, {
      sentAtMs: 40,
      receivedAtMs: 41,
    });
    const shutdown = createHostRequest("host.shutdown", "req-shutdown", {});
    const shutdownSuccess = createHostSuccessResponse(shutdown, { accepted: true });
    const failure = createHostErrorResponse(handshake, {
      code: "HOST_UNAVAILABLE",
      message: "Host is restarting",
      retryable: true,
      details: { retryAfterMs: 250 },
    });
    const event = createHostEvent("host.statusChanged", {
      state: "restarting",
      generation: 4,
      error: {
        code: "HOST_CRASHED",
        message: "Host exited unexpectedly",
        retryable: true,
      },
    });

    expect(parseHostMessage(success)).toEqual(success);
    expect(parseHostMessage(pingSuccess)).toEqual(pingSuccess);
    expect(parseHostMessage(shutdownSuccess)).toEqual(shutdownSuccess);
    expect(parseHostMessage(failure)).toEqual(failure);
    expect(parseHostMessage(event)).toEqual(event);
  });

  it("rejects unsupported protocol versions before dispatch", () => {
    expectProtocolError(
      {
        protocolVersion: 2,
        kind: "request",
        requestId: "req-1",
        method: "diagnostics.ping",
        payload: { sentAtMs: 1 },
      },
      "UNSUPPORTED_PROTOCOL_VERSION",
    );
  });

  it("rejects unknown kinds, methods, and events", () => {
    expectProtocolError({ protocolVersion: 1, kind: "command" }, "UNKNOWN_KIND");
    expectProtocolError(
      {
        protocolVersion: 1,
        kind: "request",
        requestId: "req-1",
        method: "filesystem.delete",
        payload: {},
      },
      "UNKNOWN_METHOD",
    );
    expectProtocolError(
      {
        protocolVersion: 1,
        kind: "event",
        event: "host.secretChanged",
        payload: {},
      },
      "UNKNOWN_EVENT",
    );
  });

  it("rejects malformed and ambiguous payloads", () => {
    expectProtocolError(
      {
        protocolVersion: 1,
        kind: "request",
        requestId: "req-1",
        method: "diagnostics.ping",
        payload: { sentAtMs: "now" },
      },
      "INVALID_PAYLOAD",
    );
    expectProtocolError(
      {
        protocolVersion: 1,
        kind: "request",
        requestId: "req-1",
        method: "host.shutdown",
        payload: { reason: "quit", unexpected: true },
      },
      "INVALID_PAYLOAD",
    );
    expectProtocolError(
      {
        protocolVersion: 1,
        kind: "response",
        requestId: "req-1",
        method: "host.shutdown",
        ok: true,
        payload: { accepted: false },
      },
      "INVALID_PAYLOAD",
    );
  });

  it("returns errors without throwing through safe parsing", () => {
    const result = safeParseHostMessage(null);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("INVALID_MESSAGE");
      expect(result.error.toPayload()).toEqual({
        code: "INVALID_MESSAGE",
        message: "$ must be an object",
        retryable: false,
        details: { path: "$" },
      });
    }
  });

  it("checks both request id and method when correlating responses", () => {
    const request = createHostRequest("diagnostics.ping", "req-42", { sentAtMs: 10 });
    const response = createHostSuccessResponse(request, {
      sentAtMs: 10,
      receivedAtMs: 11,
    });
    const wrongId = { ...response, requestId: "req-43" };
    const wrongMethod = { ...response, method: "host.shutdown" as const };

    expect(isResponseForRequest(request, response)).toBe(true);
    expect(isResponseForRequest(request, wrongId)).toBe(false);
    expect(isResponseForRequest(request, wrongMethod)).toBe(false);
    expect(() => assertResponseForRequest(request, response)).not.toThrow();
    expect(() => assertResponseForRequest(request, wrongId)).toThrowError(
      expect.objectContaining({ code: "RESPONSE_MISMATCH" }),
    );
  });

  it("exports a self-contained Android-consumable JSON Schema", () => {
    expect(HOST_PROTOCOL_V1_JSON_SCHEMA.$schema).toContain("2020-12");
    expect(HOST_PROTOCOL_V1_JSON_SCHEMA.oneOf).toHaveLength(37);
    expect(HOST_PROTOCOL_V1_JSON_SCHEMA.$defs.hostStatus).toBeDefined();
    expect(HOST_PROTOCOL_V1_JSON_SCHEMA.$defs.handshakeRequest).toBeDefined();
  });

  it('validates host plugin control and serializable tool results', () => {
    for (const request of [
      createHostRequest('plugins.list', 'list', {}),
      createHostRequest('plugins.setEnabled', 'toggle', { pluginId: 'builtin.time-tool', enabled: false }),
      createHostRequest('tools.invoke', 'invoke', { pluginId: 'builtin.time-tool', toolId: 'current-time' }),
    ]) expect(parseHostMessage(request)).toEqual(request);
    const list = createHostRequest('plugins.list', 'list', {});
    const response = createHostSuccessResponse(list, { generation: 2, plugins: [{
      id: 'builtin.time-tool', displayName: 'Time', description: 'Current time', version: '0.1.0',
      status: 'active', error: null, tools: [{ id: 'current-time', label: 'Time' }], composerActions: [],
    }] });
    expect(parseHostMessage(response)).toEqual(response);
    expectProtocolError({ ...response, payload: { ...response.payload, plugins: [{ ...response.payload.plugins[0], status: 'invalid' }] } }, 'INVALID_PAYLOAD');
    expectProtocolError({ ...createHostRequest('plugins.setEnabled', 'bad', { pluginId: 'time', enabled: true }), payload: { pluginId: 'time', enabled: 'yes' } }, 'INVALID_PAYLOAD');
  });

  it('round-trips model settings and chat streams without returning an API key', () => {
    const secret = 'sk-test-should-not-appear-in-snapshots';
    const update = createHostRequest('model.setSettings', 'set-model', {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      providerMode: 'openai-compatible',
      apiKey: secret,
    });
    const snapshot = {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      providerMode: 'openai-compatible' as const,
      hasApiKey: true,
    };
    const saved = createHostSuccessResponse(update, snapshot);
    const read = createHostRequest('model.getSettings', 'get-model', {});
    const start = createHostRequest('model.chat.start', 'start-model', {
      streamId: 'stream-1',
      conversationId: 'conversation-assistant',
      assistantMessageId: 'assistant-1',
      messages: [{ role: 'user', content: 'hello' }],
    });
    const started = createHostSuccessResponse(start, {
      streamId: 'stream-1',
      conversationId: 'conversation-assistant',
      assistantMessageId: 'assistant-1',
      generation: 2,
    });
    const delta = createHostEvent('model.chat.delta', { ...started.payload, textDelta: 'he' });
    const completed = createHostEvent('model.chat.completed', { ...started.payload, text: 'hello' });
    const failed = createHostEvent('model.chat.failed', {
      ...started.payload,
      partialText: 'he',
      error: { code: 'MODEL_REQUEST_FAILED', message: 'The model request failed.', retryable: true },
    });
    const cancelled = createHostEvent('model.chat.cancelled', { ...started.payload, partialText: 'he' });
    const authorTool = createHostEvent('model.authorTool', {
      ...started.payload,
      phase: 'finished',
      tool: 'validate_draft',
      ok: false,
      summary: '没有找到这份插件草稿。',
      pendingInstall: false,
      draft: null,
    });
    const cancel = createHostRequest('model.chat.cancel', 'cancel-model', { streamId: 'stream-1' });
    const cancelResponse = createHostSuccessResponse(cancel, { streamId: 'stream-1', cancelled: true });

    expect(parseHostMessage(update)).toEqual(update);
    expect(JSON.stringify(update)).toContain(secret);
    for (const message of [saved, read, start, started, delta, completed, failed, cancelled, authorTool, cancel, cancelResponse]) {
      expect(parseHostMessage(message)).toEqual(message);
      expect(JSON.stringify(message)).not.toContain(secret);
    }
    expectProtocolError(
      { ...authorTool, payload: { ...authorTool.payload, source: `token ${secret}` } },
      'INVALID_PAYLOAD',
    );
    expectProtocolError(
      { ...saved, payload: { ...snapshot, apiKey: secret } },
      'INVALID_PAYLOAD',
    );
    expectProtocolError(
      { ...failed, payload: { ...failed.payload, partialText: undefined } },
      'INVALID_PAYLOAD',
    );
  });

  it('round-trips plugin draft reports without echoing source or credentials', () => {
    const secret = 'sk-test-should-not-appear-in-snapshots';
    const create = createHostRequest('pluginDrafts.create', 'create-draft', {
      manifestJson: '{"id":"example.note"}',
      source: `token ${secret}`,
    });
    const saved = createHostSuccessResponse(create, {
      persisted: false,
      draft: null,
      ok: false,
      summary: '草稿没有保存：内容里疑似有凭据。',
      issues: [{ severity: 'error', code: 'SECRET_MATERIAL', message: '草稿包含疑似凭据，已拒绝保存。' }],
    });
    const inspect = createHostRequest('pluginDrafts.inspect', 'inspect-drafts', {});
    const inspection = createHostSuccessResponse(inspect, {
      installed: [{ id: 'builtin.time-tool', version: '0.1.0', displayName: '时间工具', status: 'active' }],
      drafts: [{ id: 'example.note', revision: 2, displayName: '草稿示例', version: '0.1.0', updatedAt: 10, ok: true }],
    });
    const diagnose = createHostRequest('pluginDrafts.diagnose', 'diagnose-draft', { draftId: 'example.note' });
    const report = createHostSuccessResponse(diagnose, {
      draft: inspection.payload.drafts[0]!,
      ok: true,
      summary: '校验通过。这份草稿仍未安装。',
      issues: [],
    });

    expect(JSON.stringify(create)).toContain(secret);
    for (const message of [saved, inspect, inspection, diagnose, report]) {
      expect(parseHostMessage(message)).toEqual(message);
      expect(JSON.stringify(message)).not.toContain(secret);
    }
    expectProtocolError({ ...saved, payload: { ...saved.payload, source: secret } }, 'INVALID_PAYLOAD');
    const leakedDraft = { ...report.payload.draft, apiKey: secret };
    expectProtocolError(
      createHostSuccessResponse(createHostRequest('pluginDrafts.validate', 'validate-draft', { draftId: 'example.note' }), {
        ...report.payload,
        draft: leakedDraft,
      }),
      'INVALID_PAYLOAD',
    );
    const marker = 'static-tool-text-must-not-ride-along';
    const install = createHostRequest('pluginDrafts.install', 'install-draft', { draftId: 'example.note', confirmed: true });
    const installed = createHostSuccessResponse(install, {
      installed: true,
      draft: inspection.payload.drafts[0]!,
      ok: true,
      summary: '已安装声明式文本工具。源码没有被执行。',
      issues: [],
      catalog: {
        generation: 1,
        plugins: [{
          id: 'example.note', displayName: '草稿示例', description: '静态文本', version: '0.1.0',
          status: 'active', error: null, tools: [{ id: 'note', label: '便签' }], composerActions: [],
        }],
      },
    });
    expect(parseHostMessage(install)).toEqual(install);
    expect(parseHostMessage(installed)).toEqual(installed);
    expect(JSON.stringify(installed)).not.toContain(marker);
    expect(JSON.stringify(installed)).not.toContain(secret);
    const composerCatalog = {
      generation: 1,
      plugins: [{
        ...installed.payload.catalog.plugins[0]!,
        tools: [],
        composerActions: [{ id: 'sign', label: '署名' }],
      }],
    };
    expect(parseHostMessage(createHostSuccessResponse(install, { ...installed.payload, catalog: composerCatalog }))).toMatchObject({
      payload: { catalog: composerCatalog },
    });
    const leakedAction = JSON.parse(JSON.stringify(createHostSuccessResponse(install, { ...installed.payload, catalog: composerCatalog }))) as {
      payload: { catalog: { plugins: Array<{ composerActions: Array<Record<string, string>> }> } }
    }
    leakedAction.payload.catalog.plugins[0]!.composerActions[0]!.text = marker
    expectProtocolError(leakedAction, 'INVALID_PAYLOAD')
    expectProtocolError({ ...installed, payload: { ...installed.payload, source: marker } }, 'INVALID_PAYLOAD');
    const missingConfirm = createHostRequest('pluginDrafts.install', 'missing-confirm', { draftId: 'example.note', confirmed: true });
    expectProtocolError({ ...missingConfirm, payload: { draftId: 'example.note' } }, 'INVALID_PAYLOAD');
  });
});
