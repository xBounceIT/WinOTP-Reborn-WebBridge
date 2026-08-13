import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { unzipSync, zipSync, type Zippable } from "fflate";

const MAX_SOURCE_ARCHIVE_BYTES = 200 * 1024 * 1024;
const SOURCE_FILES = [
  "AMO_BUILD.md",
  "LICENSE",
  "PRIVACY.md",
  "package-lock.json",
  "package.json",
  "tsconfig.json",
  "manifests/base.json",
  "manifests/firefox.json",
  "public/icons/winotp.png",
  "public/icons/winotp-16.png",
  "public/icons/winotp-32.png",
  "public/icons/winotp-48.png",
  "public/icons/winotp-128.png",
  "scripts/build.ts",
  "scripts/firefox-source-archive.ts",
  "scripts/version.ts",
] as const;
const SOURCE_DIRECTORIES = ["src"] as const;
const REQUIRED_SOURCE_ENTRIES = [
  "AMO_BUILD.md",
  "PRIVACY.md",
  "package-lock.json",
  "package.json",
  "manifests/base.json",
  "manifests/firefox.json",
  "scripts/build.ts",
  "scripts/firefox-source-archive.ts",
  "scripts/version.ts",
  "src/background/main.ts",
  "src/popup/main.ts",
] as const;

function zipEntry(contents: Uint8Array): Zippable[string] {
  return [contents, { mtime: new Date(1980, 0, 1) }];
}

async function collectDirectory(
  repositoryRoot: string,
  relativeDirectory: string,
): Promise<Zippable> {
  const result: Zippable = {};
  const absoluteDirectory = path.join(repositoryRoot, relativeDirectory);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    const relative = path.posix.join(relativeDirectory.replaceAll("\\", "/"), entry.name);
    if (entry.isDirectory()) {
      Object.assign(result, await collectDirectory(repositoryRoot, relative));
    } else if (entry.isFile()) {
      result[relative] = zipEntry(
        new Uint8Array(await readFile(path.join(repositoryRoot, relative))),
      );
    }
  }
  return result;
}

export async function createFirefoxSourceArchive(
  repositoryRoot: string,
  version: string,
  outputDirectory = path.join(repositoryRoot, "dist"),
): Promise<string> {
  await mkdir(outputDirectory, { recursive: true });
  const files: Zippable = {};
  for (const relative of SOURCE_FILES) {
    files[relative] = zipEntry(new Uint8Array(await readFile(path.join(repositoryRoot, relative))));
  }
  for (const directory of SOURCE_DIRECTORIES) {
    Object.assign(files, await collectDirectory(repositoryRoot, directory));
  }

  const archive = path.join(outputDirectory, `winotp-reborn-${version}-firefox-source.zip`);
  await writeFile(archive, zipSync(files, { level: 9 }));
  return archive;
}

export async function validateFirefoxSourceArchive(
  archivePath: string,
  expectedVersion: string,
): Promise<Buffer> {
  const archive = await readFile(archivePath);
  if (archive.byteLength === 0 || archive.byteLength > MAX_SOURCE_ARCHIVE_BYTES) {
    throw new Error("Firefox source archive has an invalid size");
  }

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(archive);
  } catch {
    throw new Error("Firefox source archive is not a valid ZIP file");
  }
  const names = Object.keys(files);
  if (
    names.some(
      (name) =>
        name.includes("\\") ||
        name.startsWith("/") ||
        /^[a-z]:/iu.test(name) ||
        name.split("/").some((component) => ["", ".", ".."].includes(component)),
    )
  ) {
    throw new Error("Firefox source archive contains an unsafe path");
  }
  if (
    names.some(
      (name) =>
        name === "dist" ||
        name.startsWith("dist/") ||
        name === "node_modules" ||
        name.startsWith("node_modules/") ||
        name === "target" ||
        name.startsWith("target/") ||
        name === ".git" ||
        name.startsWith(".git/"),
    )
  ) {
    throw new Error("Firefox source archive contains build output or dependencies");
  }
  const uncompressedBytes = Object.values(files).reduce(
    (total, contents) => total + contents.byteLength,
    0,
  );
  if (uncompressedBytes > MAX_SOURCE_ARCHIVE_BYTES) {
    throw new Error("Firefox source archive exceeds the uncompressed size limit");
  }
  for (const required of REQUIRED_SOURCE_ENTRIES) {
    if (!files[required]) throw new Error(`Firefox source archive is missing ${required}`);
  }

  const packageJsonBytes = files["package.json"];
  if (!packageJsonBytes || packageJsonBytes.byteLength > 64 * 1024) {
    throw new Error("Firefox source archive has no valid package.json");
  }
  let version: unknown;
  try {
    version = (JSON.parse(Buffer.from(packageJsonBytes).toString("utf8")) as { version?: unknown })
      .version;
  } catch {
    throw new Error("Firefox source archive package.json is invalid JSON");
  }
  if (version !== expectedVersion) {
    throw new Error(
      `Firefox source archive contains version ${String(version)}, expected ${expectedVersion}`,
    );
  }
  return archive;
}
