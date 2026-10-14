# Security model

## Boundaries

The browser extension is an untrusted presentation client. It never receives TOTP seeds or material capable of reconstructing an account from the desktop. Explicit QR scans temporarily process user-provided authenticator URIs, which can contain secrets, and forward them only to the desktop import review. The Rust native host is a transport adapter: it does not open WinOTP storage, decrypt data, implement OTP algorithms, or decide whether the app is unlocked. The WinOTP desktop main process remains the persistence and operating-system boundary, and `winotp-core` remains authoritative for portable domain, security-policy, and OTP behavior.

Defense in depth is applied at both bridge layers:

- TypeScript validates closed request/response shapes.
- Rust validates every Native Messaging frame and closed protocol shape.
- Rust deserializes desktop results into allow-listed structs, rejects duplicate account IDs and unknown fields, and replaces desktop error messages with fixed safe text.
- `listAccounts` and `getTotp` must return `APP_LOCKED` when desktop protection is active.
- The popup does not persist accounts or codes and clears an expired displayed code.
- No code, secret, or credential is logged.
- The extension has `nativeMessaging`, `activeTab`, and `scripting`, with no persistent host permissions or automatic content scripts. Its bundled overlay is injected only on an explicit scan action; it does not inspect page content. The background accepts only QR capture and bounded QR-import messages from that top-level page, and rejects generic native requests from page contexts. Page capture occurs only after the user confirms a rectangle. QR images and text are not persisted or logged.
- `importQr` accepts only bounded opaque authenticator payloads and returns only a fixed acknowledgement. Account validation, confirmation, duplicate handling and persistence remain in WinOTP.
- There is no HTTP listener, cloud service, telemetry, analytics, tracking, advertising, or remotely loaded code.

## Local IPC authentication

The desktop adapter creates a new high-entropy token for each app session and publishes a
short-lived descriptor at the fixed current-user runtime path. The descriptor expires within
24 hours; normal desktop behavior should use a much shorter lifetime and rotate it on every
start and lock boundary.

The native host opens and validates the same descriptor file handle it reads. On Unix it refuses symlinks and requires a regular file owned by the effective user with no group/other permissions. On Windows it requires the current user as owner and rejects read access for every SID except that user, Local System, and built-in Administrators. The desktop application must create matching restrictive permissions; an ordinary inherited ACL is intentionally insufficient.

The descriptor identifies either:

- a Windows named pipe whose name starts with `\\.\pipe\winotp-reborn-browser-`, or
- an absolute Unix-domain socket path.

The desktop server must also restrict the named-pipe/socket ACL to the current user. Before sending any request, the host checks the connected server's OS user: the process token SID on Windows and peer credentials on Unix. Windows connections permit identification only, without allowing the server to impersonate the host. The host sends the ephemeral token inside the first framed local IPC request. It never writes that token elsewhere.

## Threat model

Protected against:

- websites and injected page contexts attempting to request account metadata or OTP codes through Native Messaging;
- a different installed extension attempting to launch this host (browser host-manifest allow-list);
- malformed, oversized, truncated, or unexpected browser messages;
- accidental secret-bearing fields in a desktop response;
- other operating-system users accessing the endpoint where platform permissions are correctly applied;
- stale endpoint reuse after descriptor expiry or app restart.

Not protected against:

- malware already executing as the same OS user with permission to read the user's processes/files;
- a compromised browser, desktop application, OS, or signed release pipeline;
- screen/clipboard capture after the user explicitly displays or copies a code.

The desktop app must re-check its live lock/protection state for every `listAccounts`, `getTotp` and `importQr` request, and again when confirming an import. Authentication to the IPC endpoint is not authorization to bypass locking.

Release jobs validate archive contents, manifest target/GUID/version, compressed size, and declared uncompressed size before sending a package or store credential. Store credentials are scoped to the final publication step, GitHub Actions are pinned to immutable commit SHAs, and release artifacts include SHA-256 checksums. npm installs fail on unreviewed dependency lifecycle scripts; the only approved script is pinned to the reviewed esbuild version.
