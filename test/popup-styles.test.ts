import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const styles = await readFile(new URL("../src/popup/styles.css", import.meta.url), "utf8");

test("keeps keyboard focus visible on the popup search", () => {
  assert.match(styles, /\.search:focus-within\s*\{[^}]*outline:\s*2px solid var\(--ring\)/su);
});
