# WinOTP Reborn WebBridge Privacy Policy

Effective date: August 13, 2026

WinOTP Reborn WebBridge is a browser extension and local Native Messaging bridge for the
WinOTP Reborn desktop application. This policy applies to the Chrome/Chromium and Firefox
versions of the extension and to the `winotp-browser-bridge` native host.

## Data processed by the extension

When you open the extension, it communicates with the WinOTP Reborn desktop application on
the same device. It may temporarily receive:

- account identifiers, issuers, and account names; and
- a one-time password, its remaining lifetime, and its period, only after you explicitly
  request the code for an account.

This information is used only to display your WinOTP accounts and the one-time password you
requested. The extension does not receive OTP seeds, `otpauth://` URIs, backup data,
encryption keys, database contents, or WinOTP protection credentials.

## Local processing and retention

All communication takes place locally between the browser extension, the Native Messaging
host, and the WinOTP Reborn desktop application. The extension does not send account data or
one-time passwords to the developer or to any remote service.

Account details and one-time passwords are kept only in memory while needed by the extension.
They are not written to browser storage. A displayed password is removed when it expires or
when the popup is closed. If you choose to copy a password, it is written to the operating
system clipboard and remains subject to your operating system and clipboard-manager settings.

## Data not collected

The extension does not:

- inspect or modify websites, page content, browser history, or network traffic;
- collect telemetry, analytics, diagnostics, advertising identifiers, or usage statistics;
- use cookies or tracking technologies;
- load remote code or contact a developer-operated service; or
- sell, share, or transfer user data to third parties.

The extension has no host permissions or content scripts. Its only browser permission is
`nativeMessaging`, which is required to communicate with the locally installed WinOTP Reborn
bridge.

## Store and browser services

Google, Mozilla, browser vendors, and extension stores may independently process installation,
update, review, or aggregate store-usage information under their own privacy policies. That
processing is not performed by WinOTP Reborn WebBridge and is not accessible through the
extension.

## Security and limited use

The extension validates the data exchanged with the local bridge and accepts only the fields
needed for its user-facing purpose. Use of information received from browser APIs adheres to
the Chrome Web Store User Data Policy, including its Limited Use requirements.

## Changes to this policy

Material changes to this policy will be published in this repository and reflected in the
extension-store disclosures before a release with different data practices is published.

## Contact

Questions or privacy concerns can be submitted through the public issue tracker:

https://github.com/xBounceIT/WinOTP-Reborn-WebBridge/issues
