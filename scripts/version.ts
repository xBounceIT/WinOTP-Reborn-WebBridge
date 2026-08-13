const EXTENSION_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

export function assertExtensionVersion(version: string): void {
  if (
    !EXTENSION_VERSION_PATTERN.test(version) ||
    version.split(".").some((component) => Number(component) > 65_535)
  ) {
    throw new Error(`Version ${version} is not a stable Chrome-compatible extension version`);
  }
}

export function cargoWorkspaceVersion(cargoToml: string): string {
  const workspacePackage = /^\[workspace\.package\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/mu.exec(cargoToml)?.[1];
  const version = /^version\s*=\s*"([^"]+)"\s*$/mu.exec(workspacePackage ?? "")?.[1];
  if (!version) throw new Error("rust/Cargo.toml has no workspace package version");
  return version;
}
