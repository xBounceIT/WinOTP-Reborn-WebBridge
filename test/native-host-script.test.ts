import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");

test("native-host tooling rejects ambiguous or relative executable arguments", async () => {
  for (const arguments_ of [
    ["scripts/native-host.ts", "generate", "--host-path"],
    ["scripts/native-host.ts", "generate", "--host-path", "relative-host"],
    ["scripts/native-host.ts", "uninstall", "--host-path", "C:\\unexpected.exe"],
  ]) {
    await assert.rejects(execFileAsync(process.execPath, arguments_, { cwd: repositoryRoot }));
  }
});
