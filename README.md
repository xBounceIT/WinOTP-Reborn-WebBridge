# WinOTP Reborn WebBridge

The official FOSS browser extension and Native Messaging host for [WinOTP Reborn](https://github.com/xBounceIT/WinOTP-Reborn). It supports Google Chrome/Chromium and Mozilla Firefox without a cloud service, network API, telemetry, or page inspection.

## Architecture

```text
Chrome / Firefox popup
        │ WebExtensions runtime messages
        ▼
MV3 background service worker / event page
        │ Native Messaging, framed JSON
        ▼
winotp-browser-bridge (Rust)
        │ authenticated user-local IPC
        ▼
WinOTP Electron main-process adapter
        │ existing persistence and Rust core APIs
        ▼
winotp-core
```

The extension receives only account `id`, `issuer`, and `name`. A TOTP `code`, `expiresIn`, and `period` can be returned only after the user selects an account. Secrets, `otpauth://` URIs, backup material, database data, encryption keys, and protection credentials are rejected by allow-list validation in both TypeScript and Rust.

## Requirements

- The latest stable Node.js release (Node.js 26 at the time of writing)
- Rust stable
- Chrome 152 or newer, or Firefox 153 or newer

## Build and test

```bash
npm install --strict-allow-scripts
npm audit --audit-level=low
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm run lint:firefox

cargo test --manifest-path rust/Cargo.toml --workspace
cargo fmt --manifest-path rust/Cargo.toml --all -- --check
cargo clippy --manifest-path rust/Cargo.toml --workspace --all-targets -- -D warnings
cargo build --release --manifest-path rust/Cargo.toml --package winotp-browser-bridge
```

Extension outputs:

```text
dist/chrome/
dist/firefox/
dist/winotp-reborn-<version>-chrome.zip
dist/winotp-reborn-<version>-firefox.zip
```

The ZIP writer fixes timestamps and sorts paths so identical inputs produce reproducible archives. The in-repository validator checks both generated manifests and store publishers revalidate the exact ZIP contents and version before upload; AMO performs its full validation during submission.

## Development installation

### Chrome / Chromium

1. Run `npm run build:chrome`.
2. Open `chrome://extensions` (or `chromium://extensions`).
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select `dist/chrome`.
5. Copy the generated 32-character extension ID. It is needed to generate the native host allow-list.

### Firefox

1. Run `npm run build:firefox`.
2. Open `about:debugging#/runtime/this-firefox`.
3. Choose **Load Temporary Add-on** and select `dist/firefox/manifest.json`.

Firefox uses the stable add-on ID `{250f3c41-cf5e-4c20-a07c-e99a8532436b}`. Its manifest declares `data_collection_permissions.required: ["none"]` and a minimum Firefox version of 153.

## Native host development registration

Build the Rust host, set the Chrome extension ID from the unpacked extension, then install per-user manifests:

```powershell
cargo build --release --manifest-path rust/Cargo.toml --package winotp-browser-bridge
$env:WINOTP_CHROME_EXTENSION_ID = "<32-character-extension-id>"
npm run native:install
```

Override the executable with `WINOTP_NATIVE_HOST_PATH` or `--host-path`. Remove only the development registration with `npm run native:uninstall`. The tooling supports Chrome, Chromium, and Firefox on Windows, macOS, and Linux. Production users receive this registration from the WinOTP desktop installer; an extension cannot install a native host by itself.

## Documentation

- [Protocol](docs/protocol.md)
- [Security and local threat model](docs/security.md)
- [Native host registration and troubleshooting](docs/native-host.md)
- [Desktop integration contract](docs/desktop-integration.md)
- [Release and store publishing](docs/release.md)

## License

MIT
