import assert from "node:assert/strict";
import test from "node:test";

import {
  createRequest,
  isNativeRequest,
  parseNativeResponse,
  type NativeResponse,
} from "../src/shared/protocol.ts";

test("strictly validates requests and account IDs", () => {
  assert.equal(isNativeRequest({ version: 1, requestId: "request-1", method: "ping" }), true);
  assert.equal(isNativeRequest({ version: 2, requestId: "request-1", method: "ping" }), false);
  assert.equal(isNativeRequest({ version: 1, requestId: "request-1", method: "unknown" }), false);
  assert.equal(
    isNativeRequest({
      version: 1,
      requestId: "request-1",
      method: "getTotp",
      params: { accountId: "invalid id" },
    }),
    false,
  );
  assert.equal(
    isNativeRequest({ version: 1, requestId: "request-1", method: "ping", unexpected: true }),
    false,
  );
});

test("accepts only the documented account metadata", () => {
  const request = createRequest("listAccounts");
  const safe: NativeResponse<{ accounts: readonly unknown[] }> = {
    version: 1,
    requestId: request.requestId,
    ok: true,
    result: { accounts: [{ id: "account-1", issuer: "Example", name: "user@example.test" }] },
  };
  assert.deepEqual(parseNativeResponse(request, safe), safe);

  for (const forbidden of [
    { secret: "JBSWY3DPEHPK3PXP" },
    { uri: "otpauth://totp/Example?secret=never" },
    { backupPassword: "never" },
    { encryptedDatabase: "never" },
  ]) {
    const unsafe = structuredClone(safe) as Record<string, unknown>;
    const result = unsafe.result as { accounts: Array<Record<string, unknown>> };
    const unsafeAccount = result.accounts[0];
    assert.ok(unsafeAccount);
    Object.assign(unsafeAccount, forbidden);
    assert.throws(() => parseNativeResponse(request, unsafe), /unsafe Native Messaging result/);
  }
});

test("locked responses contain no result payload", () => {
  const request = createRequest("listAccounts");
  const response = {
    version: 1,
    requestId: request.requestId,
    ok: false,
    error: { code: "APP_LOCKED", message: "WinOTP is locked" },
  };
  assert.deepEqual(parseNativeResponse(request, response), response);
  assert.equal("result" in response, false);
});

test("TOTP results are bounded and reject extra fields", () => {
  const request = createRequest("getTotp", { accountId: "account-1" });
  const response = {
    version: 1,
    requestId: request.requestId,
    ok: true,
    result: { code: "123456", expiresIn: 19, period: 30 },
  };
  assert.deepEqual(parseNativeResponse(request, response), response);
  assert.throws(() =>
    parseNativeResponse(request, {
      ...response,
      result: { ...response.result, secret: "never" },
    }),
  );
  assert.throws(() =>
    parseNativeResponse(request, {
      ...response,
      result: { code: "123456", expiresIn: 31, period: 30 },
    }),
  );
  assert.throws(() =>
    parseNativeResponse(request, {
      ...response,
      result: { code: "123456", expiresIn: 0, period: 30 },
    }),
  );
});

test("rejects duplicate IDs and fields that exceed UTF-8 byte limits", () => {
  const request = createRequest("listAccounts");
  assert.throws(() =>
    parseNativeResponse(request, {
      version: 1,
      requestId: request.requestId,
      ok: true,
      result: {
        accounts: [
          { id: "duplicate", issuer: "One", name: "First" },
          { id: "duplicate", issuer: "Two", name: "Second" },
        ],
      },
    }),
  );
  assert.throws(() =>
    parseNativeResponse(request, {
      version: 1,
      requestId: request.requestId,
      ok: true,
      result: { accounts: [{ id: "account-1", issuer: "é".repeat(129), name: "user" }] },
    }),
  );
});
