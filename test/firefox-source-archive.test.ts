import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { strToU8, unzipSync, zipSync } from "fflate";
import {
  createFirefoxSourceArchive,
  validateFirefoxSourceArchive,
} from "../scripts/firefox-source-archive.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

test("creates and validates a reproducible Firefox reviewer source archive", async () => {
  const outputDirectory = await mkdtemp(path.join(tmpdir(), "winotp-firefox-source-test-"));
  try {
    const archivePath = await createFirefoxSourceArchive(repositoryRoot, "1.0.0", outputDirectory);
    const validated = await validateFirefoxSourceArchive(archivePath, "1.0.0");
    assert.deepEqual(validated, await readFile(archivePath));

    const names = Object.keys(unzipSync(validated));
    assert.ok(names.includes("AMO_BUILD.md"));
    assert.ok(names.includes("PRIVACY.md"));
    assert.ok(names.includes("src/shared/protocol.ts"));
    assert.ok(names.includes("public/icons/winotp-128.png"));
    assert.ok(
      names.every(
        (name) =>
          !name.startsWith("dist/") &&
          !name.startsWith("node_modules/") &&
          !name.startsWith("target/") &&
          !name.startsWith(".git/"),
      ),
    );
    await assert.rejects(
      validateFirefoxSourceArchive(archivePath, "9.9.9"),
      /contains version 1\.0\.0, expected 9\.9\.9/u,
    );
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test("rejects malformed or incomplete Firefox source archives", async () => {
  const outputDirectory = await mkdtemp(path.join(tmpdir(), "winotp-firefox-source-invalid-"));
  try {
    const empty = path.join(outputDirectory, "empty.zip");
    await writeFile(empty, new Uint8Array());
    await assert.rejects(validateFirefoxSourceArchive(empty, "1.0.0"), /invalid size/u);

    const malformed = path.join(outputDirectory, "malformed.zip");
    await writeFile(malformed, "not a zip");
    await assert.rejects(validateFirefoxSourceArchive(malformed, "1.0.0"), /not a valid ZIP/u);

    const unsafe = path.join(outputDirectory, "unsafe.zip");
    await writeFile(unsafe, zipSync({ "../package.json": strToU8("{}") }));
    await assert.rejects(validateFirefoxSourceArchive(unsafe, "1.0.0"), /unsafe path/u);

    const incomplete = path.join(outputDirectory, "incomplete.zip");
    await writeFile(
      incomplete,
      zipSync({ "package.json": strToU8(JSON.stringify({ version: "1.0.0" })) }),
    );
    await assert.rejects(validateFirefoxSourceArchive(incomplete, "1.0.0"), /is missing/u);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
