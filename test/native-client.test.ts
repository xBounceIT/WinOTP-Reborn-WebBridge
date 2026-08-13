import assert from "node:assert/strict";
import test from "node:test";

import {
  NativeHostTimeoutError,
  NativeHostUnavailableError,
  NativeProtocolMismatchError,
  sendNativeRequest,
} from "../src/native/client.ts";
import { createRequest } from "../src/shared/protocol.ts";
import type { RuntimeApi, RuntimePort } from "../src/shared/webextension.ts";

function runtimeWith(
  handler: (message: unknown, callback: (response: unknown) => void) => void,
  error?: { message: string },
): RuntimeApi {
  let messageListener: (message: unknown) => void = () => {};
  let disconnectListener: () => void = () => {};
  const port: RuntimePort = {
    onMessage: { addListener(listener) { messageListener = listener; } },
    onDisconnect: { addListener(listener) { disconnectListener = listener; } },
    postMessage(message) {
      if (error) disconnectListener();
      else handler(message, (response) => messageListener(response));
    },
    disconnect() {},
  };
  return {
    id: "extension-id",
    ...(error ? { lastError: error } : {}),
    onMessage: { addListener() {} },
    sendMessage() {},
    connectNative() { return port; },
  };
}

test("sends and validates a normal native response", async () => {
  const request = createRequest("ping");
  const runtime = runtimeWith((message, callback) => {
    assert.deepEqual(message, request);
    callback({
      version: 1,
      requestId: request.requestId,
      ok: true,
      result: { protocolVersion: 1, bridgeVersion: "0.1.0" },
    });
  });
  const response = await sendNativeRequest(runtime, request);
  assert.equal(response.ok, true);
});

test("maps a missing native host to a transport error without exposing browser text", async () => {
  const runtime = runtimeWith(() => {}, { message: "Specified native messaging host not found." });
  await assert.rejects(sendNativeRequest(runtime, createRequest("ping")), NativeHostUnavailableError);
});

test("rejects protocol mismatches", async () => {
  const request = createRequest("ping");
  const runtime = runtimeWith((_message, callback) => {
    callback({
      version: 2,
      requestId: request.requestId,
      ok: true,
      result: { protocolVersion: 2, bridgeVersion: "2.0.0" },
    });
  });
  await assert.rejects(sendNativeRequest(runtime, request), NativeProtocolMismatchError);
});

test("times out and disconnects an unresponsive native host", async () => {
  let disconnected = false;
  const runtime = runtimeWith(() => {});
  const originalConnect = runtime.connectNative.bind(runtime);
  runtime.connectNative = (application) => {
    const port = originalConnect(application);
    const disconnect = port.disconnect.bind(port);
    port.disconnect = () => {
      disconnected = true;
      disconnect();
    };
    return port;
  };

  await assert.rejects(sendNativeRequest(runtime, createRequest("ping"), 10), NativeHostTimeoutError);
  assert.equal(disconnected, true);
});
