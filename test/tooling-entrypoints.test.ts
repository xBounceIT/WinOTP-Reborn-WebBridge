import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const storePreload = pathToFileURL(
  path.join(repositoryRoot, "test", "fixtures", "store-fetch.ts"),
).href;

async function runScript(
  script: string,
  arguments_: readonly string[] = [],
  environment: NodeJS.ProcessEnv = process.env,
  nodeArguments: readonly string[] = [],
): Promise<string> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [...nodeArguments, script, ...arguments_],
    {
      cwd: repositoryRoot,
      env: environment,
    },
  );
  return stdout;
}

let buildOutput = "";
test.before(async () => {
  buildOutput = await runScript("scripts/build.ts");
});

test("builds and validates both extension distributions", async () => {
  assert.match(buildOutput, /Built dist[\\/]chrome/u);
  assert.match(buildOutput, /Built dist[\\/]firefox/u);
  assert.match(buildOutput, /Built dist[\\/]winotp-reborn-1\.0\.0-firefox-source\.zip/u);

  const validationOutput = await runScript("scripts/validate-manifests.ts");
  assert.match(validationOutput, /Validated dist\/chrome\/manifest\.json/u);
  assert.match(validationOutput, /Validated dist\/firefox\/manifest\.json/u);

  await assert.rejects(runScript("scripts/build.ts", ["invalid"]), /Usage: node scripts\/build/u);
  await assert.rejects(
    runScript("scripts/validate-manifests.ts", ["invalid"]),
    /Usage: node scripts\/validate-manifests/u,
  );
});

test("verifies matching release tags and rejects missing tags", async () => {
  await runScript("scripts/verify-release-tag.ts", [], { ...process.env, RELEASE_TAG: "v1.0.0" });
  await assert.rejects(
    runScript("scripts/verify-release-tag.ts", [], { ...process.env, RELEASE_TAG: "" }),
    /RELEASE_TAG is required/u,
  );
});

test("runs store publication entrypoints against local fetch doubles", async () => {
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";

  const chromeOutput = await runScript(
    "scripts/publish-chrome.ts",
    [],
    {
      ...process.env,
      CHROME_CLIENT_ID: "test-client",
      CHROME_CLIENT_SECRET: "test-secret",
      CHROME_EXTENSION_ID: extensionId,
      CHROME_PUBLISHER_ID: "test-publisher",
      CHROME_REFRESH_TOKEN: "test-refresh-token",
      WINOTP_TEST_STORE: "chrome",
    },
    ["--import", storePreload],
  );
  assert.match(chromeOutput, /Chrome Web Store submission state: PUBLISHED/u);

  const firefoxOutput = await runScript(
    "scripts/publish-firefox.ts",
    [],
    {
      ...process.env,
      AMO_JWT_ISSUER: "test-issuer",
      AMO_JWT_SECRET: "test-secret",
      WINOTP_TEST_STORE: "firefox",
    },
    ["--import", storePreload],
  );
  assert.match(firefoxOutput, /Firefox AMO submission state: nominated/u);
});

test("generates allow-listed native host manifests without installing them", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "winotp-native-host-test-"));
  const executable = path.join(directory, process.platform === "win32" ? "bridge.exe" : "bridge");
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  try {
    await writeFile(executable, "test executable");
    await chmod(executable, 0o700);
    const output = await runScript(
      "scripts/native-host.ts",
      ["generate", "--host-path", executable],
      { ...process.env, WINOTP_CHROME_EXTENSION_ID: extensionId },
    );
    assert.match(output, /Generated .*\.chrome\.json/u);
    assert.match(output, /Generated .*\.firefox\.json/u);

    const chromeManifest = JSON.parse(
      await readFile(
        path.join(repositoryRoot, "dist", "native-host", "com.xbounceit.winotp.chrome.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    assert.equal(chromeManifest.path, executable);
    assert.deepEqual(chromeManifest.allowed_origins, [`chrome-extension://${extensionId}/`]);
    assert.equal("allowed_extensions" in chromeManifest, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(path.join(repositoryRoot, "dist", "native-host"), { recursive: true, force: true });
  }
});
