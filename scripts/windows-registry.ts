import { spawnSync } from "node:child_process";

type RegistryRunner = (
  command: string,
  args: readonly string[],
  options: { encoding: "utf8"; windowsHide: true },
) => {
  status: number | null;
  error?: Error;
  stdout?: string;
  stderr?: string;
};

export function removeRegistryRegistration(key: string, run: RegistryRunner = spawnSync): void {
  const literal = `Registry::${key.replace(/^HKCU\\/u, "HKEY_CURRENT_USER\\")}`.replaceAll(
    "'",
    "''",
  );
  const command = `try { Remove-Item -LiteralPath '${literal}' -ErrorAction Stop } catch { if ($_.CategoryInfo.Category -eq 'ObjectNotFound') { exit 0 }; throw }`;
  const result = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      result.error?.message ||
        result.stderr?.trim() ||
        result.stdout?.trim() ||
        "Registry removal failed",
    );
}
