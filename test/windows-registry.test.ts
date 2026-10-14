import assert from "node:assert/strict";
import test from "node:test";
import { removeRegistryRegistration } from "../scripts/windows-registry.ts";

test("registry removal ignores only absent keys and propagates tool failures", () => {
  const key = "HKCU\\Software\\Mozilla\\NativeMessagingHosts\\com.xbounceit.winotp";
  removeRegistryRegistration(key, (tool, args, options) => {
    assert.equal(tool, "powershell.exe");
    assert.equal(options.windowsHide, true);
    assert.ok(args.includes("-NonInteractive"));
    const command = args.at(-1)!;
    assert.match(command, /try \{ Remove-Item -LiteralPath 'Registry::HKEY_CURRENT_USER\\Software/);
    assert.match(command, /CategoryInfo.Category -eq 'ObjectNotFound'/);
    assert.match(command, /-ErrorAction Stop \} catch/);
    return { status: 0 };
  });
  for (const failure of [
    { status: 1, stderr: "Access denied" },
    { status: null, error: new Error("PowerShell missing") },
    { status: 1, stdout: "failed" },
    { status: null },
  ]) {
    assert.throws(
      () => removeRegistryRegistration(key, () => failure),
      /Access denied|PowerShell missing|failed|Registry removal failed/,
    );
  }
});
