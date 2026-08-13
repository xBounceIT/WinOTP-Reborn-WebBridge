import { constants, accessSync, statSync } from "node:fs";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOST_NAME = "com.xbounceit.winotp";
const FIREFOX_EXTENSION_ID = "{250f3c41-cf5e-4c20-a07c-e99a8532436b}";
const CHROME_ID_PATTERN = /^[a-p]{32}$/;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(repositoryRoot, "dist", "native-host");
const action = process.argv[2];
const rawArguments = process.argv.slice(3);

if (
  (action !== "generate" && action !== "install" && action !== "uninstall") ||
  (rawArguments.length > 0 &&
    (action === "uninstall" ||
      rawArguments.length !== 2 ||
      rawArguments[0] !== "--host-path" ||
      !rawArguments[1]))
) {
  throw new Error(
    "Usage: node scripts/native-host.ts <generate|install|uninstall> [--host-path <absolute path>]",
  );
}

function hostPath(): string {
  const configured = rawArguments[1] ?? process.env.WINOTP_NATIVE_HOST_PATH;
  const executable =
    process.platform === "win32" ? "winotp-browser-bridge.exe" : "winotp-browser-bridge";
  if (configured !== undefined && !path.isAbsolute(configured)) {
    throw new Error("The native host path must be absolute");
  }
  const candidate =
    configured ?? path.join(repositoryRoot, "rust", "target", "release", executable);
  let stats;
  try {
    stats = statSync(candidate);
    if (process.platform !== "win32") accessSync(candidate, constants.X_OK);
  } catch {
    throw new Error(`Native host not found or not executable at ${candidate}`);
  }
  if (!stats.isFile()) throw new Error(`Native host is not a file at ${candidate}`);
  return candidate;
}

function chromeExtensionId(): string {
  const value = process.env.WINOTP_CHROME_EXTENSION_ID;
  if (!value || !CHROME_ID_PATTERN.test(value)) {
    throw new Error("Set WINOTP_CHROME_EXTENSION_ID to the 32-character Chrome extension ID");
  }
  return value;
}

function manifest(browser: "chrome" | "firefox", executablePath: string): Record<string, unknown> {
  const common = {
    name: HOST_NAME,
    description: "WinOTP Reborn Browser Bridge",
    path: executablePath,
    type: "stdio",
  };
  return browser === "chrome"
    ? { ...common, allowed_origins: [`chrome-extension://${chromeExtensionId()}/`] }
    : { ...common, allowed_extensions: [FIREFOX_EXTENSION_ID] };
}

async function generate(): Promise<Readonly<{ chrome: string; firefox: string }>> {
  await mkdir(outputDirectory, { recursive: true });
  const executablePath = hostPath();
  const chrome = path.join(outputDirectory, `${HOST_NAME}.chrome.json`);
  const firefox = path.join(outputDirectory, `${HOST_NAME}.firefox.json`);
  await Promise.all([
    writeFile(chrome, `${JSON.stringify(manifest("chrome", executablePath), null, 2)}\n`),
    writeFile(firefox, `${JSON.stringify(manifest("firefox", executablePath), null, 2)}\n`),
  ]);
  return { chrome, firefox };
}

function runRegistry(args: readonly string[], tolerateMissing = false): void {
  const result = spawnSync("reg.exe", [...args], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0 && !tolerateMissing) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "Registry update failed");
  }
}

async function install(): Promise<void> {
  const generated = await generate();
  if (process.platform === "win32") {
    const registrations = [
      ["HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts", generated.chrome],
      ["HKCU\\Software\\Chromium\\NativeMessagingHosts", generated.chrome],
      ["HKCU\\Software\\Mozilla\\NativeMessagingHosts", generated.firefox],
    ] as const;
    for (const [root, manifestPath] of registrations) {
      runRegistry([
        "add",
        `${root}\\${HOST_NAME}`,
        "/ve",
        "/t",
        "REG_SZ",
        "/d",
        manifestPath,
        "/f",
      ]);
    }
    return;
  }

  const home = os.homedir();
  const destinations: ReadonlyArray<readonly [string, string]> =
    process.platform === "darwin"
      ? [
          ["Library/Application Support/Google/Chrome/NativeMessagingHosts", generated.chrome],
          ["Library/Application Support/Chromium/NativeMessagingHosts", generated.chrome],
          ["Library/Application Support/Mozilla/NativeMessagingHosts", generated.firefox],
        ]
      : [
          [".config/google-chrome/NativeMessagingHosts", generated.chrome],
          [".config/chromium/NativeMessagingHosts", generated.chrome],
          [".mozilla/native-messaging-hosts", generated.firefox],
        ];
  for (const [relativeDirectory, source] of destinations) {
    const directory = path.join(home, relativeDirectory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await copyFile(source, path.join(directory, `${HOST_NAME}.json`));
  }
}

async function uninstall(): Promise<void> {
  if (process.platform === "win32") {
    for (const root of [
      "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts",
      "HKCU\\Software\\Chromium\\NativeMessagingHosts",
      "HKCU\\Software\\Mozilla\\NativeMessagingHosts",
    ]) {
      runRegistry(["delete", `${root}\\${HOST_NAME}`, "/f"], true);
    }
  } else {
    const home = os.homedir();
    const directories: readonly string[] =
      process.platform === "darwin"
        ? [
            "Library/Application Support/Google/Chrome/NativeMessagingHosts",
            "Library/Application Support/Chromium/NativeMessagingHosts",
            "Library/Application Support/Mozilla/NativeMessagingHosts",
          ]
        : [
            ".config/google-chrome/NativeMessagingHosts",
            ".config/chromium/NativeMessagingHosts",
            ".mozilla/native-messaging-hosts",
          ];
    await Promise.all(
      directories.map((directory) =>
        rm(path.join(home, directory, `${HOST_NAME}.json`), { force: true }),
      ),
    );
  }
  await rm(outputDirectory, { recursive: true, force: true });
}

if (action === "generate") {
  const generated = await generate();
  process.stdout.write(`Generated ${generated.chrome}\nGenerated ${generated.firefox}\n`);
} else if (action === "install") {
  await install();
  process.stdout.write("Installed Native Messaging manifests for the current user.\n");
} else {
  await uninstall();
  process.stdout.write("Removed Native Messaging registrations for the current user.\n");
}
