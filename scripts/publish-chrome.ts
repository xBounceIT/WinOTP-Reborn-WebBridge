import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertChromePublication, waitForChromeUpload } from "./chrome-store.ts";
import { validateExtensionArchive } from "./extension-archive.ts";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8")) as {
  version: string;
};

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

async function checkedFetch(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof body.error === "object" ? JSON.stringify(body.error) : response.statusText;
    throw new Error(`Chrome Web Store API request failed (${response.status}): ${message}`);
  }
  return body;
}

const archive =
  process.env.CHROME_EXTENSION_ZIP ??
  path.join(repositoryRoot, "dist", `winotp-reborn-${packageJson.version}-chrome.zip`);
await validateExtensionArchive(archive, "chrome", packageJson.version);

const clientId = requiredEnvironment("CHROME_CLIENT_ID");
const clientSecret = requiredEnvironment("CHROME_CLIENT_SECRET");
const refreshToken = requiredEnvironment("CHROME_REFRESH_TOKEN");
const publisherId = requiredEnvironment("CHROME_PUBLISHER_ID");
const extensionId = requiredEnvironment("CHROME_EXTENSION_ID");
if (!/^[a-p]{32}$/u.test(extensionId)) {
  throw new Error("CHROME_EXTENSION_ID must be a 32-character Chrome extension ID");
}

const tokenResponse = await checkedFetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  }),
});
const accessToken = tokenResponse.access_token;
if (typeof accessToken !== "string") throw new Error("OAuth token response did not contain an access token");

const itemName = `publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(extensionId)}`;
const authorization = { authorization: `Bearer ${accessToken}` };
const upload = await checkedFetch(`https://chromewebstore.googleapis.com/upload/v2/${itemName}:upload`, {
  method: "POST",
  headers: { ...authorization, "content-type": "application/zip" },
  body: await readFile(archive),
});
if (upload.itemId !== extensionId) {
  throw new Error("Chrome Web Store upload response contained an unexpected extension ID");
}
if (upload.uploadState === "SUCCEEDED" && upload.crxVersion !== packageJson.version) {
  throw new Error(
    `Chrome Web Store parsed extension version ${String(upload.crxVersion)}, expected ${packageJson.version}`,
  );
}
const uploadStatus = await waitForChromeUpload(upload, () =>
  checkedFetch(`https://chromewebstore.googleapis.com/v2/${itemName}:fetchStatus`, {
    method: "GET",
    headers: authorization,
  }),
);
if (uploadStatus.itemId !== extensionId) {
  throw new Error("Chrome Web Store status response contained an unexpected extension ID");
}

const published = await checkedFetch(`https://chromewebstore.googleapis.com/v2/${itemName}:publish`, {
  method: "POST",
  headers: { ...authorization, "content-type": "application/json" },
  body: JSON.stringify({ publishType: "DEFAULT_PUBLISH", blockOnWarnings: true }),
});
assertChromePublication(published, extensionId);
process.stdout.write(`Chrome Web Store submission state: ${String(published.state ?? "submitted")}\n`);
