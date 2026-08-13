import assert from "node:assert/strict";
import test from "node:test";
import { createGateway } from "../src/popup/gateway.ts";
import { createRequest } from "../src/shared/protocol.ts";
import { NativeTransportError } from "../src/shared/transport.ts";
import type { RuntimeApi } from "../src/shared/webextension.ts";

function runtimeWith(reply: unknown): RuntimeApi {
  return {
    id: "extension-id",
    onMessage: { addListener() {} },
    connectNative() { throw new Error("unused"); },
    sendMessage(_message, callback) { callback(reply); },
  };
}

test("validates the complete background reply envelope", async () => {
  const request = createRequest("ping");
  const response = {
    version: 1,
    requestId: request.requestId,
    ok: true,
    result: { protocolVersion: 1, bridgeVersion: "0.1.0" },
  };
  assert.deepEqual(
    await createGateway(runtimeWith({ kind: "native-response", response })).request(request),
    response,
  );

  for (const invalid of [
    undefined,
    { kind: "native-response", response, extra: true },
    { kind: "transport-error", reason: "arbitrary-error-name" },
  ]) {
    await assert.rejects(
      createGateway(runtimeWith(invalid)).request(request),
      (error) => error instanceof NativeTransportError && error.reason === "INVALID_RESPONSE",
    );
  }
});

test("times out an unresponsive background and ignores its late reply", async () => {
  let reply: ((value: unknown) => void) | undefined;
  let lastErrorReads = 0;
  const runtime: RuntimeApi = {
    id: "extension-id",
    get lastError() {
      lastErrorReads += 1;
      return { message: "The message port closed" };
    },
    onMessage: { addListener() {} },
    connectNative() {
      throw new Error("unused");
    },
    sendMessage(_message, callback) {
      reply = callback;
    },
  };
  const request = createRequest("ping");
  await assert.rejects(
    createGateway(runtime, 10).request(request),
    (error) => error instanceof NativeTransportError && error.reason === "TIMEOUT",
  );
  assert.doesNotThrow(() => reply?.({ kind: "transport-error", reason: "HOST_UNAVAILABLE" }));
  assert.equal(lastErrorReads, 1);
});
