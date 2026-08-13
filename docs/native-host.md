# Native host registration and troubleshooting

The stable host name is `com.xbounceit.winotp`. Chrome/Chromium manifests use `allowed_origins`; Firefox manifests use `allowed_extensions`. The executable path is always absolute in generated manifests.

Build the native host before running `npm run native:manifests` or `npm run native:install`. The tooling rejects missing files, directories, relative overrides, and non-executable Unix host files instead of generating an unusable registration.

## Development registration locations

`npm run native:install` registers the current user at the official browser locations:

| Platform | Chrome / Chromium                                                                               | Firefox                                                           |
| -------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Windows  | `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.xbounceit.winotp` and Chromium equivalent | `HKCU\Software\Mozilla\NativeMessagingHosts\com.xbounceit.winotp` |
| macOS    | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` and Chromium equivalent     | `~/Library/Application Support/Mozilla/NativeMessagingHosts/`     |
| Linux    | `~/.config/google-chrome/NativeMessagingHosts/` and `~/.config/chromium/NativeMessagingHosts/`  | `~/.mozilla/native-messaging-hosts/`                              |

The WinOTP desktop installer must use the same locations (or their documented system-wide
equivalents), point manifests to its installed bridge binary, and remove only these
registrations/artifacts on uninstall. It must not delete WinOTP user data.

## Troubleshooting

### “WinOTP bridge not installed”

- Confirm the Rust binary exists and is executable.
- Confirm the host manifest file is valid JSON and its `path` is correct.
- On Windows, confirm the registry default value points to that manifest.
- Confirm the Chrome extension ID in `allowed_origins` matches `chrome://extensions` exactly.
- Confirm the Firefox GUID in `allowed_extensions` matches the extension manifest.
- Re-run `npm run native:install` after moving the binary.

### “WinOTP is not running”

The native host is installed and answered `ping`, but the desktop IPC descriptor or endpoint
is absent. Confirm that a compatible WinOTP release is running, unlocked as required by its
protection policy, and has browser extension access enabled.

### “Unexpected bridge error”

The descriptor, local authentication, IPC response, or response schema failed validation. Update both WinOTP and the extension. Browser consoles may report native-host startup/transport failures, but the popup intentionally does not expose stack traces.

### Manual framing test

Use the Rust unit tests rather than piping newline-delimited JSON: Native Messaging is binary length-framed, not line-oriented.
