# Desktop integration contract

This document is the handoff for the later change to the separate WinOTP Reborn desktop repository. No Electron source or installer in that repository is modified here.

## Runtime descriptor

When WinOTP is ready to accept browser requests, Electron creates an authenticated current-user local endpoint and atomically publishes `browser-bridge.json`:

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
