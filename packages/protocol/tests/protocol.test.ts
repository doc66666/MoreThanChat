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
    expect(HOST_PROTOCOL_V1_JSON_SCHEMA.oneOf).toHaveLength(14);
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
      status: 'active', error: null, tools: [{ id: 'current-time', label: 'Time' }],
    }] });
    expect(parseHostMessage(response)).toEqual(response);
    expectProtocolError({ ...response, payload: { ...response.payload, plugins: [{ ...response.payload.plugins[0], status: 'invalid' }] } }, 'INVALID_PAYLOAD');
    expectProtocolError({ ...createHostRequest('plugins.setEnabled', 'bad', { pluginId: 'time', enabled: true }), payload: { pluginId: 'time', enabled: 'yes' } }, 'INVALID_PAYLOAD');
  });
});
