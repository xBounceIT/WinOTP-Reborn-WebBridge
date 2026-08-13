import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import { assertAmoSubmission, publishFirefox } from "../scripts/firefox-store.ts";

test("accepts only successful AMO states for the expected extension", () => {
  const guid = "{250f3c41-cf5e-4c20-a07c-e99a8532436b}";
  assert.equal(assertAmoSubmission({ guid, status: "nominated" }, guid), "nominated");
  for (const response of [
    { status: "nominated" },
    { guid, status: "rejected" },
    { guid, status: "incomplete" },
    { guid },
  ]) {
    assert.throws(() => assertAmoSubmission(response, guid), /did not accept/u);
  }
});

test("publishes a validated Firefox archive directly through AMO API v5", async () => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "winotp-amo-test-"));
  const archive = path.join(temporaryDirectory, "extension.zip");
  await writeFile(
    archive,
    zipSync({
      "background.js": strToU8(""),
      "icons/winotp.png": new Uint8Array([1]),
      "manifest.json": strToU8(
        JSON.stringify({
          manifest_version: 3,
          version: "0.1.0",
          browser_specific_settings: { gecko: { id: "{250f3c41-cf5e-4c20-a07c-e99a8532436b}" } },
        }),
      ),
      "popup.css": strToU8(""),
      "popup.html": strToU8(""),
      "popup.js": strToU8(""),
    }),
  );

  const requests: Array<{ authorization: string; body: string; method: string; url: string }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        authorization: request.headers.authorization ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
        method: request.method ?? "",
        url: request.url ?? "",
      });

      response.setHeader("content-type", "application/json");
      if (request.method === "POST" && request.url === "/api/v5/addons/upload/") {
        response.writeHead(201).end(JSON.stringify({ uuid: "upload-1", processed: false }));
      } else if (request.method === "GET" && request.url === "/api/v5/addons/upload/upload-1/") {
        response.end(
          JSON.stringify({
            uuid: "upload-1",
            processed: true,
            valid: true,
            submitted: false,
            version: "0.1.0",
          }),
        );
      } else if (
        request.method === "PUT" &&
        request.url === "/api/v5/addons/addon/%7B250f3c41-cf5e-4c20-a07c-e99a8532436b%7D/"
      ) {
        response
          .writeHead(201)
          .end(
            JSON.stringify({ guid: "{250f3c41-cf5e-4c20-a07c-e99a8532436b}", status: "nominated" }),
          );
      } else {
        response.writeHead(404).end(JSON.stringify({ detail: "unexpected test request" }));
      }
    });
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null)
      throw new Error("Test server has no TCP address");

    const status = await publishFirefox({
      apiBase: `http://127.0.0.1:${address.port}/api/v5`,
      archive,
      delay: async () => {},
      expectedVersion: "0.1.0",
      extensionGuid: "{250f3c41-cf5e-4c20-a07c-e99a8532436b}",
      issuer: "test-issuer",
      metadata: { name: { "en-US": "WinOTP Reborn" }, version: { license: "MIT" } },
      secret: "test-secret",
    });

    assert.equal(status, "nominated");
    assert.deepEqual(
      requests.map(({ method, url }) => `${method} ${url}`),
      [
        "POST /api/v5/addons/upload/",
        "GET /api/v5/addons/upload/upload-1/",
        "PUT /api/v5/addons/addon/%7B250f3c41-cf5e-4c20-a07c-e99a8532436b%7D/",
      ],
    );
    assert.ok(requests.every(({ authorization }) => authorization.startsWith("JWT ")));
    assert.equal(new Set(requests.map(({ authorization }) => authorization)).size, requests.length);
    assert.match(requests[0]?.body ?? "", /name="channel"\r\n\r\nlisted/u);

    const submission = JSON.parse(requests[2]?.body ?? "{}") as Record<string, unknown>;
    assert.deepEqual(submission.name, { "en-US": "WinOTP Reborn" });
    assert.deepEqual(submission.version, { license: "MIT", upload: "upload-1" });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
