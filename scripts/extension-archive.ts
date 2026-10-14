import { strFromU8, unzipSync } from "fflate";
import { assertBoundedZipDirectory, readBoundedArchive } from "./zip-bounds.ts";

export type ExtensionTarget = "chrome" | "firefox";

const FIREFOX_EXTENSION_ID = "{250f3c41-cf5e-4c20-a07c-e99a8532436b}";
const MAX_ARCHIVE_BYTES = 5 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 5 * 1024 * 1024;
const EXPECTED_FILES = [
  "background.js",
  "icons/winotp-128.png",
  "icons/winotp-16.png",
  "icons/winotp-32.png",
  "icons/winotp-48.png",
  "manifest.json",
  "overlay.js",
  "popup.css",
  "popup.html",
  "popup.js",
  "third-party-licenses.txt",
];

function asObject(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${description} must be an object`);
  }
  return value as Record<string, unknown>;
}

export async function validateExtensionArchive(
  archivePath: string,
  target: ExtensionTarget,
  expectedVersion: string,
): Promise<Buffer<ArrayBuffer>> {
  const archive = await readBoundedArchive(archivePath, MAX_ARCHIVE_BYTES, "Extension archive");
  assertBoundedZipDirectory(
    archive,
    MAX_UNCOMPRESSED_BYTES,
    "Extension archive",
    EXPECTED_FILES.length,
  );

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(archive);
  } catch {
    throw new Error("Extension archive is not a valid ZIP file");
  }
  const names = Object.keys(files).sort();
  if (
    names.length !== EXPECTED_FILES.length ||
    names.some((name, index) => name !== EXPECTED_FILES[index])
  ) {
    throw new Error(`Extension archive contains unexpected files: ${names.join(", ")}`);
  }

  const manifestBytes = files["manifest.json"];
  if (!manifestBytes || manifestBytes.byteLength > 64 * 1024) {
    throw new Error("Extension archive has no valid manifest");
  }
  let manifest: Record<string, unknown>;
  try {
    manifest = asObject(JSON.parse(strFromU8(manifestBytes)), "Extension manifest");
  } catch {
    throw new Error("Extension archive manifest is invalid JSON");
  }
  if (manifest.manifest_version !== 3 || manifest.version !== expectedVersion) {
    throw new Error(`Extension archive does not contain Manifest V3 version ${expectedVersion}`);
  }

  const settings = manifest.browser_specific_settings;
  if (target === "chrome" && settings !== undefined) {
    throw new Error("Chrome archive contains Firefox-specific settings");
  }
  if (target === "firefox") {
    const gecko = asObject(
      asObject(settings, "browser_specific_settings").gecko,
      "browser_specific_settings.gecko",
    );
    if (gecko.id !== FIREFOX_EXTENSION_ID) {
      throw new Error("Firefox archive contains an unexpected extension ID");
    }
  }
  return archive;
}
