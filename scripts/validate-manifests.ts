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

const iconPaths = {
  "16": "icons/winotp-16.png",
  "32": "icons/winotp-32.png",
  "48": "icons/winotp-48.png",
  "128": "icons/winotp-128.png",
} as const;

async function assertPngDimensions(file: string, expectedSize: number): Promise<void> {
  const image = await readFile(file);
  assert.ok(image.byteLength >= 24, `${file} is not a complete PNG`);
  assert.deepEqual(
    [...image.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
    `${file} has an invalid PNG signature`,
  );
  assert.equal(image.readUInt32BE(16), expectedSize, `${file} has the wrong width`);
  assert.equal(image.readUInt32BE(20), expectedSize, `${file} has the wrong height`);
}

for (const target of targets) {
  const manifest = JSON.parse(
    await readFile(path.join(repositoryRoot, "dist", target, "manifest.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["nativeMessaging"]);
  assert.deepEqual(manifest.content_security_policy, {
    extension_pages: "script-src 'self'; object-src 'none'",
  });
  assert.deepEqual(manifest.icons, iconPaths);
  assert.deepEqual((manifest.action as Record<string, unknown>).default_icon, {
    "16": iconPaths["16"],
    "32": iconPaths["32"],
  });
  await Promise.all(
    Object.entries(iconPaths).map(([size, icon]) =>
      assertPngDimensions(path.join(repositoryRoot, "dist", target, icon), Number(size)),
    ),
  );
  for (const forbidden of [
    "host_permissions",
    "optional_host_permissions",
    "optional_permissions",
    "content_scripts",
    "externally_connectable",
    "sandbox",
    "web_accessible_resources",
  ]) {
    assert.equal(
      forbidden in manifest,
      false,
      `${target} manifest contains forbidden ${forbidden}`,
    );
  }

  const background = manifest.background as Record<string, unknown>;
  if (target === "chrome") {
    assert.equal(background.service_worker, "background.js");
    assert.equal("scripts" in background, false);
    assert.equal("browser_specific_settings" in manifest, false);
    assert.equal(manifest.minimum_chrome_version, "151");
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
