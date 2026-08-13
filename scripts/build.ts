import { readFile, readdir, rm, mkdir, copyFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { zipSync, type Zippable } from "fflate";
import { createFirefoxSourceArchive } from "./firefox-source-archive.ts";
import { assertExtensionVersion } from "./version.ts";

type BrowserTarget = "chrome" | "firefox";

const ICON_SIZES = [16, 32, 48, 128] as const;

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
) as {
  version: string;
};
assertExtensionVersion(packageJson.version);
const requestedTarget = process.argv[2];

if (
  requestedTarget !== undefined &&
  requestedTarget !== "chrome" &&
  requestedTarget !== "firefox"
) {
  throw new Error("Usage: node scripts/build.ts [chrome|firefox]");
}

const targets: readonly BrowserTarget[] = requestedTarget
  ? [requestedTarget]
  : ["chrome", "firefox"];

function mergeManifest(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  return { ...base, ...overlay, version: packageJson.version };
}

async function collectFiles(directory: string, prefix = ""): Promise<Zippable> {
  const result: Zippable = {};
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      Object.assign(result, await collectFiles(absolute, relative));
    } else if (entry.isFile()) {
      // ZIP stores local DOS date fields. Constructing the epoch in local time keeps
      // the encoded timestamp identical regardless of the build machine's timezone.
      result[relative] = [
        new Uint8Array(await readFile(absolute)),
        { mtime: new Date(1980, 0, 1) },
      ];
    }
  }
  return result;
}

async function buildTarget(target: BrowserTarget): Promise<void> {
  const targetDirectory = path.join(repositoryRoot, "dist", target);
  const browserTarget = target === "chrome" ? "chrome152" : "firefox153";
  await rm(targetDirectory, { recursive: true, force: true });
  await mkdir(path.join(targetDirectory, "icons"), { recursive: true });

  await Promise.all([
    build({
      entryPoints: [path.join(repositoryRoot, "src", "background", "main.ts")],
      outfile: path.join(targetDirectory, "background.js"),
      bundle: true,
      format: "iife",
      minify: true,
      platform: "browser",
      target: browserTarget,
      legalComments: "none",
    }),
    build({
      entryPoints: [path.join(repositoryRoot, "src", "popup", "main.ts")],
      outfile: path.join(targetDirectory, "popup.js"),
      bundle: true,
      format: "iife",
      minify: true,
      platform: "browser",
      target: browserTarget,
      legalComments: "none",
    }),
    copyFile(
      path.join(repositoryRoot, "src", "popup", "index.html"),
      path.join(targetDirectory, "popup.html"),
    ),
    copyFile(
      path.join(repositoryRoot, "src", "popup", "styles.css"),
      path.join(targetDirectory, "popup.css"),
    ),
    ...ICON_SIZES.map((size) =>
      copyFile(
        path.join(repositoryRoot, "public", "icons", `winotp-${size}.png`),
        path.join(targetDirectory, "icons", `winotp-${size}.png`),
      ),
    ),
  ]);

  const base = JSON.parse(
    await readFile(path.join(repositoryRoot, "manifests", "base.json"), "utf8"),
  ) as Record<string, unknown>;
  const overlay = JSON.parse(
    await readFile(path.join(repositoryRoot, "manifests", `${target}.json`), "utf8"),
  ) as Record<string, unknown>;
  const manifest = mergeManifest(base, overlay);
  await writeFile(
    path.join(targetDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  const zip = zipSync(await collectFiles(targetDirectory), { level: 9 });
  const archivePath = path.join(
    repositoryRoot,
    "dist",
    `winotp-reborn-${packageJson.version}-${target}.zip`,
  );
  await writeFile(archivePath, zip);
  process.stdout.write(
    `Built ${path.relative(repositoryRoot, targetDirectory)} and ${path.relative(repositoryRoot, archivePath)}\n`,
  );
  if (target === "firefox") {
    const sourceArchive = await createFirefoxSourceArchive(repositoryRoot, packageJson.version);
    process.stdout.write(`Built ${path.relative(repositoryRoot, sourceArchive)}\n`);
  }
}

await mkdir(path.join(repositoryRoot, "dist"), { recursive: true });
for (const target of targets) await buildTarget(target);
