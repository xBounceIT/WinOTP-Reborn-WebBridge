# Desktop integration contract

This document defines the protocol implemented by compatible WinOTP Reborn desktop releases.
The desktop application and its installer are maintained in a separate repository; no Electron
or installer source is owned here.

## Runtime descriptor

When WinOTP accepts browser requests, Electron creates an authenticated current-user local
endpoint and atomically publishes `browser-bridge.json`:

```json
{
  "version": 1,
  "endpoint": { "kind": "windowsNamedPipe", "name": "\\\\.\\pipe\\winotp-reborn-browser-<random>" },
  "authToken": "<at-least-43-base64url-characters-from-256-random-bits>",
  "expiresAt": 1786579200
}
```

Unix uses:

```json
{
  "version": 1,
  "endpoint": {
    "kind": "unix",
    "path": "/absolute/current-user/runtime/path/browser-<random>.sock"
  },
  "authToken": "<at-least-43-base64url-characters-from-256-random-bits>",
  "expiresAt": 1786579200
}
```

Descriptor locations:

- Windows: `%LOCALAPPDATA%\WinOTP_Reborn\runtime\browser-bridge.json`
- macOS: `~/Library/Application Support/WinOTP_Reborn/runtime/browser-bridge.json`
- Linux: `$XDG_RUNTIME_DIR/winotp-reborn/browser-bridge.json`, falling back to the platform local-data directory

The file and endpoint must be current-user-only. Write to a sibling temporary file, apply permissions, then atomically rename. Rotate the endpoint/token each app start and remove the descriptor before shutdown. Do not use a fixed or installation-wide token.

## First IPC message

Local IPC uses the same four-byte little-endian 64 KiB framing. The host sends:

```json
{
  "version": 1,
  "requestId": "8ab6...",
  "auth": { "scheme": "ephemeral-token", "token": "..." },
  "request": { "version": 1, "requestId": "8ab6...", "method": "getStatus" }
}
```

Electron authenticates before dispatch. It returns the standard response from [protocol.md](protocol.md).

## Required desktop behavior

1. Reuse the existing Electron persistence/OS boundary and existing Rust-core sidecar calls.
2. Do not read/decrypt storage from the browser bridge binary.
3. Evaluate the existing protection policy for every request, not just connection setup.
4. When locked, `getStatus` may safely report `state: "locked"`; `listAccounts` and `getTotp` must return `APP_LOCKED` with no result.
5. Map accounts to exactly `id`, `issuer`, and `name`.
6. Generate TOTP through `winotp-core`; map only `code`, `expiresIn`, and `period`.
7. Return `ACCOUNT_NOT_FOUND` for missing/stale IDs without revealing other accounts.
8. Rate-limit abusive same-user requests without creating a second lock policy.
9. Install the bridge binary and browser host manifests through Electron Builder/NSIS plus macOS/Linux packaging; remove registrations on uninstall without deleting user data.
10. Add platform tests for endpoint ACLs, lifecycle cleanup, lock transitions, and single-instance behavior.

Starting or activating WinOTP is intentionally deferred. Until a safe cross-platform application lifecycle is implemented, a missing endpoint maps to `APP_NOT_RUNNING` and the popup directs the user to open WinOTP and retry.

## QR import support

The WebBridge `importQr` transport is implemented in this repository. The separate desktop repository must implement its handler before users can complete imports:

1. Authenticate the request and re-check the current lock/protection policy. Return `APP_LOCKED` or `APP_NOT_RUNNING` as appropriate.
2. Apply the same closed request shape and 8192-byte payload bounds as [protocol.md](protocol.md). Treat the text as untrusted input and use the existing desktop QR/URI import validation, including migration support where available.
3. Open/activate the existing import review UI with the payload held only in memory. Require explicit user confirmation before saving; prevent duplicate concurrent reviews/imports through the existing account flow.
4. Respond immediately with `{ "accepted": true }` once the review has been queued. Do not wait for user input within the five-second transport deadline. Reject unsupported payloads with `INVALID_REQUEST`; never return the payload in results or errors.
5. Re-check protection at confirmation, await persistence, handle duplicates/errors in the desktop UI, and discard the payload on cancellation/lock/completion. Do not log QR text.

Test this on Windows, macOS and Linux with locked, unavailable, older and compatible desktop releases. This repository's tests cover the extension and bridge contract, not the separately maintained desktop implementation.
