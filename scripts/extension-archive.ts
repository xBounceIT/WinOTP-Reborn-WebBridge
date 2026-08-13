import { readFile } from "node:fs/promises";
import { strFromU8, unzipSync } from "fflate";

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
  "popup.css",
  "popup.html",
  "popup.js",
];

function assertBoundedZipDirectory(archive: Uint8Array): void {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const searchStart = Math.max(0, archive.byteLength - 65_557);
  let end = -1;
  for (let offset = archive.byteLength - 22; offset >= searchStart; offset -= 1) {
    if (view.getUint32(offset, true) === 0x0605_4b50) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new Error("Extension archive has no ZIP directory");

  const entries = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (entries !== EXPECTED_FILES.length || directoryOffset + directorySize > end) {
    throw new Error("Extension archive has an invalid ZIP directory");
  }

  let offset = directoryOffset;
  let uncompressedBytes = 0;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x0201_4b50) {
      throw new Error("Extension archive has an invalid ZIP entry");
    }
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    if (uncompressedSize === 0xffff_ffff)
      throw new Error("ZIP64 extension archives are not supported");
    uncompressedBytes += uncompressedSize;
    if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES) {
      throw new Error("Extension archive exceeds the uncompressed size limit");
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== directoryOffset + directorySize) {
    throw new Error("Extension archive ZIP directory length is inconsistent");
  }
}

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
): Promise<void> {
  const archive = await readFile(archivePath);
  if (archive.byteLength === 0 || archive.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error("Extension archive has an invalid size");
  }
  assertBoundedZipDirectory(archive);

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
}
