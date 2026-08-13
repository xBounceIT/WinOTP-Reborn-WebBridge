# WinOTP Reborn WebBridge

This repository owns the browser extension, the Native Messaging host, and their shared protocol contract. The WinOTP desktop application is maintained separately.

- Use TypeScript for browser and Node tooling source. Do not add JavaScript source files.
- Keep OTP, cryptographic, account, persistence, and protection logic out of this repository.
- The extension may receive only account `id`, `issuer`, and `name`, plus an explicitly requested OTP `code`, `expiresIn`, and `period`.
- Treat Windows, macOS, and Linux as first-class targets.
- Never add telemetry, analytics, remote logging, remote code, or network-facing services.
- Generated extension bundles, archives, and Rust binaries are build artifacts and are not committed.

Run `npm run check` and `cargo test --manifest-path rust/Cargo.toml --workspace` before completing a change.
