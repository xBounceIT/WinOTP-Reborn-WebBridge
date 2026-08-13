import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { strToU8, zipSync, type Zippable } from "fflate";
import { validateExtensionArchive, type ExtensionTarget } from "../scripts/extension-archive.ts";

const expectedFiles: Zippable = {
  "background.js": strToU8(""),
  "icons/winotp.png": new Uint8Array([1]),
  "popup.css": strToU8(""),
  "popup.html": strToU8(""),
  "popup.js": strToU8(""),
};

async function writeArchive(
  directory: string,
  target: ExtensionTarget,
  overrides: Record<string, unknown> = {},
  extraFiles: Zippable = {},
): Promise<string> {
  const manifest = {
    manifest_version: 3,
    version: "0.1.0",
    ...(target === "firefox"
      ? { browser_specific_settings: { gecko: { id: "{250f3c41-cf5e-4c20-a07c-e99a8532436b}" } } }
      : {}),
    ...overrides,
  };
  const archive = path.join(directory, `${target}-${Object.keys(extraFiles).length}.zip`);
  await writeFile(
    archive,
    zipSync({ ...expectedFiles, ...extraFiles, "manifest.json": strToU8(JSON.stringify(manifest)) }),
  );
  return archive;
}

test("accepts only the expected browser archive and release version", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "winotp-archive-test-"));
  try {
    await validateExtensionArchive(await writeArchive(directory, "chrome"), "chrome", "0.1.0");
    await validateExtensionArchive(await writeArchive(directory, "firefox"), "firefox", "0.1.0");

    await assert.rejects(
      validateExtensionArchive(await writeArchive(directory, "chrome", { version: "9.9.9" }), "chrome", "0.1.0"),
      /does not contain Manifest V3 version/u,
    );
    await assert.rejects(
      validateExtensionArchive(
        await writeArchive(directory, "firefox", {}, { "unexpected.js": strToU8("alert(1)") }),
        "firefox",
        "0.1.0",
      ),
      /invalid ZIP directory|unexpected files/u,
    );
    await assert.rejects(
      validateExtensionArchive(
        await writeArchive(directory, "chrome", {}, { "background.js": new Uint8Array(6 * 1024 * 1024) }),
        "chrome",
        "0.1.0",
      ),
      /uncompressed size limit/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
