# WinOTP Reborn WebBridge

This repository owns the browser extension, the Native Messaging host, and their shared protocol contract. The WinOTP desktop application is maintained separately.

- Use TypeScript for browser and Node tooling source. Do not add JavaScript source files.
- Keep OTP, cryptographic, account, persistence, and protection logic out of this repository.
- From the desktop, the extension may receive only account `id`, `issuer`, and `name`, plus an explicitly requested OTP `code`, `expiresIn`, and `period`.
- Explicit user-requested QR scans are the sole input exception: the extension may temporarily decode a user-selected image or visible-page capture and forward the bounded authenticator URI as opaque text to WinOTP. Never persist or log the image or payload, interpret account secrets, or return them from the desktop. Account validation, import confirmation, and persistence remain exclusively in WinOTP.
- Treat Windows, macOS, and Linux as first-class targets.
- Never add telemetry, analytics, remote logging, remote code, or network-facing services.
- Generated extension bundles, archives, and Rust binaries are build artifacts and are not committed.

Run `npm run check` and `cargo test --manifest-path rust/Cargo.toml --workspace` before completing a change.
