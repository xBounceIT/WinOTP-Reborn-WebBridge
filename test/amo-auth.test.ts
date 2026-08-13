import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createAmoJwt } from "../scripts/amo-auth.ts";

test("creates a short-lived HS256 AMO token with the required claims", () => {
  const token = createAmoJwt("user:123", "test-secret", 1_700_000_000, "unique-id");
  const parts = token.split(".");
  assert.equal(parts.length, 3);

  const [header, payload, signature] = parts as [string, string, string];
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString("utf8")), {
    alg: "HS256",
    typ: "JWT",
  });
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), {
    iss: "user:123",
    jti: "unique-id",
    iat: 1_700_000_000,
    exp: 1_700_000_060,
  });
  assert.equal(
    signature,
    createHmac("sha256", "test-secret").update(`${header}.${payload}`).digest("base64url"),
  );
});

test("rejects missing AMO credentials", () => {
  assert.throws(() => createAmoJwt("", "secret"), /issuer and secret are required/u);
  assert.throws(() => createAmoJwt("issuer", ""), /issuer and secret are required/u);
});
