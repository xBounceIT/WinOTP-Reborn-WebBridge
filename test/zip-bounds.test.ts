import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { assertBoundedZipDirectory, readBoundedArchive } from "../scripts/zip-bounds.ts";

test("bounds archive reads even when the file grows after its metadata was checked", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "winotp-zip-read-"));
  const archive = path.join(directory, "archive.zip");
  try {
    await writeFile(archive, "abcd");
    assert.equal((await readBoundedArchive(archive, 4, "Test archive")).toString(), "abcd");
    await assert.rejects(readBoundedArchive(archive, 3, "Test archive"), /invalid size/);
    const handle = await open(archive, "r");
    const prototype = Object.getPrototypeOf(handle) as typeof handle;
    const stat = prototype.stat;
    await handle.close();
    t.mock.method(prototype, "stat", async function (this: typeof handle) {
      const metadata = await stat.call(this);
      await writeFile(archive, "abcdefgh");
      return metadata;
    });
    await assert.rejects(readBoundedArchive(archive, 4, "Test archive"), /invalid size/);
  } finally {
    t.mock.restoreAll();
    await rm(directory, { recursive: true, force: true });
  }
});

test("checks ZIP allocations and directory boundaries before extraction", () => {
  const original = zipSync({ "one.txt": strToU8("one"), "two.txt": strToU8("two") });
  const check = (bytes: Uint8Array, limit = 6, entries?: number) =>
    assertBoundedZipDirectory(bytes, limit, "Test archive", entries);
  check(original, 6, 2);
  check(zipSync({}), 0, 0);
  assert.throws(() => check(original, 5), /uncompressed size limit/);
  assert.throws(() => check(original, 6, 1), /valid ZIP directory/);
  assert.throws(() => check(new Uint8Array(2)), /valid ZIP directory/);
  const end = original.length - 22;
  const directory = new DataView(original.buffer).getUint32(end + 16, true);
  const corrupt = (offset: number, size: 2 | 4, value: number) => {
    const bytes = original.slice();
    const view = new DataView(bytes.buffer);
    if (size === 2) view.setUint16(offset, value, true);
    else view.setUint32(offset, value, true);
    assert.throws(() => check(bytes), /valid ZIP directory/);
  };
  for (const offset of [end + 4, end + 6, end + 8, end + 20]) corrupt(offset, 2, 1);
  corrupt(end - 20, 4, 0x0706_4b50);
  corrupt(end + 10, 2, 0xffff);
  corrupt(end + 16, 4, 0xffff_ffff);
  corrupt(directory, 4, 0);
  corrupt(directory + 10, 2, 7);
  corrupt(directory + 20, 4, 0xffff_ffff);
  corrupt(directory + 24, 4, 0xffff_ffff);
  corrupt(directory + 28, 2, 0xffff);
  corrupt(directory + 42, 4, 0xffff_ffff);
  corrupt(0, 4, 0);
  corrupt(26, 2, 0xffff);
  const stored = zipSync({ "one.txt": strToU8("one") }, { level: 0 });
  check(stored);
  const storedView = new DataView(stored.buffer);
  storedView.setUint32(storedView.getUint32(stored.length - 6, true) + 24, 1, true);
  assert.throws(() => check(stored), /valid ZIP directory/);
});
