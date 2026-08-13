import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publishFirefox } from "./firefox-store.ts";

type JsonObject = Record<string, unknown>;

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8")) as {
  version: string;
};

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function asObject(value: unknown, description: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${description} must be a JSON object`);
  }
  return value as JsonObject;
}

const issuer = requiredEnvironment("AMO_JWT_ISSUER");
const secret = requiredEnvironment("AMO_JWT_SECRET");

const archive =
  process.env.FIREFOX_EXTENSION_ZIP ??
  path.join(repositoryRoot, "dist", `winotp-reborn-${packageJson.version}-firefox.zip`);

const firefoxManifest = asObject(
  JSON.parse(await readFile(path.join(repositoryRoot, "manifests", "firefox.json"), "utf8")),
  "Firefox manifest overlay",
);
const browserSettings = asObject(firefoxManifest.browser_specific_settings, "browser_specific_settings");
const geckoSettings = asObject(browserSettings.gecko, "browser_specific_settings.gecko");
const extensionGuid = geckoSettings.id;
if (typeof extensionGuid !== "string" || !extensionGuid) throw new Error("Firefox manifest has no extension GUID");

const metadata = asObject(
  JSON.parse(await readFile(path.join(repositoryRoot, "store", "firefox-metadata.json"), "utf8")),
  "Firefox store metadata",
);
const status = await publishFirefox({
  apiBase: "https://addons.mozilla.org/api/v5",
  archive,
  expectedVersion: packageJson.version,
  extensionGuid,
  issuer,
  metadata,
  secret,
});
process.stdout.write(`Firefox AMO submission state: ${status}\n`);
