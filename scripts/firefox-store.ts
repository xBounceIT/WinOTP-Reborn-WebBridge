import { readFile } from "node:fs/promises";
import path from "node:path";
import { createAmoJwt } from "./amo-auth.ts";
import { validateExtensionArchive } from "./extension-archive.ts";

type JsonObject = Record<string, unknown>;

export interface FirefoxPublicationOptions {
  readonly apiBase: string;
  readonly archive: string;
  readonly delay?: () => Promise<void>;
  readonly expectedVersion: string;
  readonly extensionGuid: string;
  readonly fetcher?: typeof fetch;
  readonly issuer: string;
  readonly metadata: JsonObject;
  readonly secret: string;
}

function asObject(value: unknown, description: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${description} must be a JSON object`);
  }
  return value as JsonObject;
}

const ACCEPTED_ADDON_STATUSES = new Set(["public", "nominated"]);

export function assertAmoSubmission(response: JsonObject, extensionGuid: string): string {
  if (response.guid !== extensionGuid || !ACCEPTED_ADDON_STATUSES.has(String(response.status))) {
    throw new Error(`AMO did not accept the submission: ${JSON.stringify(response)}`);
  }
  return response.status as string;
}

export async function publishFirefox(options: FirefoxPublicationOptions): Promise<string> {
  await validateExtensionArchive(options.archive, "firefox", options.expectedVersion);
  const apiBase = options.apiBase.replace(/\/$/u, "");
  const fetcher = options.fetcher ?? fetch;
  const delay = options.delay ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 2_000)));

  async function amoFetch(endpoint: string, init: RequestInit): Promise<JsonObject> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `JWT ${createAmoJwt(options.issuer, options.secret)}`);

    const response = await fetcher(`${apiBase}${endpoint}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(60_000),
    });
    const body = asObject(await response.json().catch(() => ({})), "AMO response");
    if (!response.ok) {
      const detail = body.detail ?? body.error ?? body.errors ?? response.statusText;
      throw new Error(`AMO API request failed (${response.status}): ${JSON.stringify(detail)}`);
    }
    return body;
  }

  const form = new FormData();
  form.set("channel", "listed");
  form.set(
    "upload",
    new Blob([await readFile(options.archive)], { type: "application/zip" }),
    path.basename(options.archive),
  );

  let upload = await amoFetch("/addons/upload/", { method: "POST", body: form });
  const uploadId = upload.uuid;
  if (typeof uploadId !== "string" || !uploadId)
    throw new Error("AMO upload response did not contain a UUID");

  for (let attempt = 0; upload.processed !== true && attempt < 60; attempt += 1) {
    await delay();
    upload = await amoFetch(`/addons/upload/${encodeURIComponent(uploadId)}/`, { method: "GET" });
  }
  if (upload.processed !== true)
    throw new Error("AMO validation did not finish within two minutes");
  if (upload.valid !== true) {
    throw new Error(
      `AMO validation failed: ${JSON.stringify(upload.validation ?? "No details returned")}`,
    );
  }
  if (upload.submitted === true)
    throw new Error("AMO reported that this upload was already submitted");
  if (upload.version !== options.expectedVersion) {
    throw new Error(
      `AMO validated extension version ${String(upload.version)}, expected ${options.expectedVersion}`,
    );
  }

  const versionMetadata = asObject(options.metadata.version, "Firefox version metadata");
  const result = await amoFetch(`/addons/addon/${encodeURIComponent(options.extensionGuid)}/`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...options.metadata,
      version: { ...versionMetadata, upload: uploadId },
    }),
  });

  return assertAmoSubmission(result, options.extensionGuid);
}
