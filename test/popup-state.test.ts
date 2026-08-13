import assert from "node:assert/strict";
import test from "node:test";

import {
  filterAccounts,
  loadPopup,
  requestTotp,
  stateForTotpError,
  type NativeGateway,
} from "../src/popup/state.ts";
import type { NativeRequest, NativeResponse } from "../src/shared/protocol.ts";
import { NativeTransportError } from "../src/shared/transport.ts";

const account = { id: "account-1", issuer: "Example", name: "user@example.test" };

function response<T>(request: NativeRequest, result: T): NativeResponse<T> {
  return { version: 1, requestId: request.requestId, ok: true, result };
}

function error(
  request: NativeRequest,
  code: "APP_NOT_RUNNING" | "APP_LOCKED" | "UNSUPPORTED_PROTOCOL",
): NativeResponse {
  return { version: 1, requestId: request.requestId, ok: false, error: { code, message: code } };
}

function gateway(
  handler: (request: NativeRequest) => NativeResponse | Promise<NativeResponse>,
): NativeGateway {
  return {
    async request<T>(request: NativeRequest): Promise<NativeResponse<T>> {
      return (await handler(request)) as NativeResponse<T>;
    },
  };
}

test("loads the connected account list", async () => {
  const state = await loadPopup(
    gateway((request) => {
      if (request.method === "ping")
        return response(request, { protocolVersion: 1, bridgeVersion: "0.1.0" });
      if (request.method === "getStatus")
        return response(request, { state: "unlocked", appVersion: "2.0.1" });
      return response(request, { accounts: [account] });
    }),
  );
  assert.deepEqual(state, {
    kind: "ready",
    bridgeVersion: "0.1.0",
    appVersion: "2.0.1",
    accounts: [account],
  });
});

test("shows locked without requesting account metadata", async () => {
  const methods: string[] = [];
  const state = await loadPopup(
    gateway((request) => {
      methods.push(request.method);
      if (request.method === "ping")
        return response(request, { protocolVersion: 1, bridgeVersion: "0.1.0" });
      return response(request, { state: "locked", appVersion: "2.0.1" });
    }),
  );
  assert.equal(state.kind, "locked");
  assert.deepEqual(methods, ["ping", "getStatus"]);
});

test("distinguishes app not running, host missing, and incompatible protocol", async () => {
  const notRunning = await loadPopup(
    gateway((request) =>
      request.method === "ping"
        ? response(request, { protocolVersion: 1, bridgeVersion: "0.1.0" })
        : error(request, "APP_NOT_RUNNING"),
    ),
  );
  assert.equal(notRunning.kind, "app-not-running");

  const missing = await loadPopup(
    gateway(() => Promise.reject(new NativeTransportError("HOST_UNAVAILABLE"))),
  );
  assert.equal(missing.kind, "host-missing");

  const timedOut = await loadPopup(
    gateway(() => Promise.reject(new NativeTransportError("TIMEOUT"))),
  );
  assert.equal(timedOut.kind, "error");

  const incompatibleTransport = await loadPopup(
    gateway(() => Promise.reject(new NativeTransportError("UNSUPPORTED_PROTOCOL"))),
  );
  assert.equal(incompatibleTransport.kind, "incompatible");

  const incompatible = await loadPopup(
    gateway((request) => error(request, "UNSUPPORTED_PROTOCOL")),
  );
  assert.equal(incompatible.kind, "incompatible");
});

test("requests a code only for an explicit account action", async () => {
  const result = await requestTotp(
    gateway((request) => {
      assert.equal(request.method, "getTotp");
      return response(request, { code: "123456", expiresIn: 18, period: 30 });
    }),
    account.id,
  );
  assert.deepEqual(result, { code: "123456", expiresIn: 18, period: 30 });
});

test("maps mid-session code failures to specific popup states", () => {
  const ready = {
    kind: "ready" as const,
    bridgeVersion: "0.1.0",
    appVersion: "2.0.1",
    accounts: [account],
  };
  assert.equal(stateForTotpError({ code: "APP_LOCKED" }, ready).kind, "locked");
  assert.equal(stateForTotpError({ code: "APP_NOT_RUNNING" }, ready).kind, "app-not-running");
  assert.equal(stateForTotpError({ code: "UNSUPPORTED_PROTOCOL" }, ready).kind, "incompatible");
  assert.equal(
    stateForTotpError(new NativeTransportError("HOST_UNAVAILABLE"), ready).kind,
    "host-missing",
  );
  assert.equal(stateForTotpError(new NativeTransportError("TIMEOUT"), ready).kind, "error");
});

test("filters accounts by issuer and name", () => {
  const accounts = [account, { id: "account-2", issuer: "ISSUER", name: "admin" }];
  assert.deepEqual(filterAccounts(accounts, "example"), [account]);
  assert.deepEqual(filterAccounts(accounts, "ADMIN"), [accounts[1]]);
  assert.deepEqual(filterAccounts(accounts, "issuer"), [accounts[1]]);
});
