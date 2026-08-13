import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type BrowserTarget = "chrome" | "firefox";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requested = process.argv[2];
if (requested !== undefined && requested !== "chrome" && requested !== "firefox") {
  throw new Error("Usage: node scripts/validate-manifests.ts [chrome|firefox]");
}
const targets: readonly BrowserTarget[] = requested ? [requested] : ["chrome", "firefox"];

for (const target of targets) {
  const manifest = JSON.parse(
    await readFile(path.join(repositoryRoot, "dist", target, "manifest.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["nativeMessaging"]);
  assert.deepEqual(manifest.content_security_policy, {
    extension_pages: "script-src 'self'; object-src 'none'",
  });
  for (const forbidden of [
    "host_permissions",
    "optional_host_permissions",
    "optional_permissions",
    "content_scripts",
    "externally_connectable",
    "sandbox",
    "web_accessible_resources",
  ]) {
    assert.equal(forbidden in manifest, false, `${target} manifest contains forbidden ${forbidden}`);
  }

  const background = manifest.background as Record<string, unknown>;
  if (target === "chrome") {
    assert.equal(background.service_worker, "background.js");
    assert.equal("scripts" in background, false);
    assert.equal("browser_specific_settings" in manifest, false);
    assert.equal(manifest.minimum_chrome_version, "152");
  } else {
    assert.deepEqual(background.scripts, ["background.js"]);
    assert.equal("service_worker" in background, false);
    assert.equal("minimum_chrome_version" in manifest, false);
    const settings = manifest.browser_specific_settings as {
      gecko: {
        id: string;
        strict_min_version: string;
        data_collection_permissions: { required: readonly string[] };
      };
    };
    assert.equal(settings.gecko.id, "{250f3c41-cf5e-4c20-a07c-e99a8532436b}");
    assert.equal(settings.gecko.strict_min_version, "153.0");
    assert.deepEqual(settings.gecko.data_collection_permissions.required, ["none"]);
  }
  process.stdout.write(`Validated dist/${target}/manifest.json\n`);
}
