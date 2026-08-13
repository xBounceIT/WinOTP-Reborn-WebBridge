import { createHmac, randomUUID } from "node:crypto";

export function createAmoJwt(
  issuer: string,
  secret: string,
  issuedAt = Math.floor(Date.now() / 1_000),
  jwtId: string = randomUUID(),
): string {
  if (!issuer || !secret) throw new Error("AMO JWT issuer and secret are required");

  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: issuer,
      jti: jwtId,
      iat: issuedAt,
      exp: issuedAt + 60,
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");

  return `${header}.${payload}.${signature}`;
}
