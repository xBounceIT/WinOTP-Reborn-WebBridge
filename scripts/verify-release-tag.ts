import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertExtensionVersion, cargoWorkspaceVersion } from "./version.ts";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
) as {
  version: string;
};
assertExtensionVersion(packageJson.version);
const rustVersion = cargoWorkspaceVersion(
  await readFile(path.join(repositoryRoot, "rust", "Cargo.toml"), "utf8"),
);
if (rustVersion !== packageJson.version) {
  throw new Error(
    `Rust workspace version ${rustVersion} does not match extension version ${packageJson.version}`,
  );
}
const tag = process.env.RELEASE_TAG;
if (!tag) throw new Error("RELEASE_TAG is required");
if (tag !== `v${packageJson.version}`) {
  throw new Error(`Release tag ${tag} does not match package version v${packageJson.version}`);
}
