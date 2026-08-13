import assert from "node:assert/strict";
import test from "node:test";
import { assertExtensionVersion, cargoWorkspaceVersion } from "../scripts/version.ts";

test("accepts only stable Chrome-compatible release versions", () => {
  assert.doesNotThrow(() => assertExtensionVersion("0.1.0"));
  for (const invalid of ["1.0.0-beta.1", "01.0.0", "1.2", "1.2.3.4", "65536.0.0"]) {
    assert.throws(() => assertExtensionVersion(invalid), /Chrome-compatible/u);
  }
});

test("reads only the Rust workspace package version", () => {
  assert.equal(
    cargoWorkspaceVersion('[workspace]\nmembers = []\n\n[workspace.package]\nversion = "1.2.3"\nedition = "2024"\n'),
    "1.2.3",
  );
  assert.throws(() => cargoWorkspaceVersion('[package]\nversion = "9.9.9"\n'), /no workspace package version/u);
});
