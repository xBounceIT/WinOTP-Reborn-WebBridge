# Firefox reviewer build instructions

This source archive builds the Firefox package submitted to addons.mozilla.org for WinOTP
Reborn WebBridge. The browser extension does not require the Rust Native Messaging host to be
built as part of this review.

## Build environment

- Ubuntu 24.04 LTS or another Node.js-supported operating system
- Node.js 26.x
- npm 11.19.0

The archive intentionally does not include `node_modules`. npm downloads the locked
dependencies from the public npm registry. The reviewed lifecycle-script allow-list in
`package.json` permits only the pinned esbuild installation script.

## Reproduce the submitted extension

From the root of the extracted source archive, run:

```bash
npm ci --strict-allow-scripts
npm run build:firefox
```

The submitted extension archive is generated at:

```text
dist/winotp-reborn-<version>-firefox.zip
```

The build uses fixed ZIP timestamps and sorted paths. Given the locked dependencies and the
same source archive, the generated Firefox ZIP is byte-for-byte reproducible.

## Functional testing

The extension communicates only with the locally installed `com.xbounceit.winotp` Native
Messaging host. To exercise the complete UI, install a compatible WinOTP Reborn desktop
release, enable browser extension access in WinOTP settings, and then open the extension
popup. The extension has no content scripts, host permissions, remote services, or test
credentials.
