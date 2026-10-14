# Native Messaging protocol

The browser protocol version is independent from the application version. The current protocol is `1`. Messages are UTF-8 JSON framed with a four-byte little-endian unsigned length. This project imposes a 64 KiB limit in both directions, below the browsers' larger transport limits.

Every request is a closed object: unknown properties, malformed IDs, unknown methods, and incompatible versions are rejected.

## Requests

```json
{ "version": 1, "requestId": "8ab6...", "method": "ping" }
{ "version": 1, "requestId": "8ab6...", "method": "getStatus" }
{ "version": 1, "requestId": "8ab6...", "method": "listAccounts" }
{
  "version": 1,
  "requestId": "8ab6...",
  "method": "getTotp",
  "params": { "accountId": "account-id" }
}
```

`ping` is answered by the Rust host without contacting the desktop app. This lets the popup distinguish an absent native host from a desktop app that is not running.

### QR import handoff

```json
{
  "version": 1,
  "requestId": "scan-1",
  "method": "importQr",
  "params": { "text": "otpauth://totp/Example?secret=EXAMPLE" }
}
```

`text` is an opaque, user-scanned payload with an `otpauth://` or `otpauth-migration://` prefix (case insensitive), no ASCII control characters, and at most 8192 UTF-8 bytes. Both transport layers enforce these bounds and reject unknown fields. URI, secret and account validation remain exclusively in the desktop app. Images never cross Native Messaging.

The only success result is `{ "accepted": true }`. It acknowledges that WinOTP has accepted the request for a local import review; it does not mean persistence succeeded. The desktop must respond promptly, then let the user review and confirm in its existing import UI. It must not hold the request open while waiting for confirmation. No decoded payload or account secrets may be returned.

This is an additive protocol-1 method: older hosts/apps reject it with `INVALID_REQUEST`, and the extension explains that a compatible update is required. There is no automatic retry of an import after timeout because the review may already have opened.

## Success responses

```json
{
  "version": 1,
  "requestId": "8ab6...",
  "ok": true,
  "result": { "protocolVersion": 1, "bridgeVersion": "0.1.0" }
}
```

`getStatus` result:

```json
{ "state": "unlocked", "appVersion": "2.0.1" }
```

`listAccounts` result:

```json
{
  "accounts": [{ "id": "account-id", "issuer": "Example", "name": "user@example.test" }]
}
```

`getTotp` result:

```json
{ "code": "123456", "expiresIn": 18, "period": 30 }
```

`expiresIn` must be a positive whole number no greater than `period`; an already-expired code is rejected.

The host parses forwarded desktop responses into these exact structures and serializes them again. Additional fields are not passed through.

## Error responses

```json
{
  "version": 1,
  "requestId": "8ab6...",
  "ok": false,
  "error": { "code": "APP_LOCKED", "message": "WinOTP is locked" }
}
```

Stable error codes:

- `APP_NOT_RUNNING`
- `APP_LOCKED`
- `ACCOUNT_NOT_FOUND`
- `INVALID_REQUEST`
- `UNSUPPORTED_PROTOCOL`
- `NATIVE_HOST_ERROR`
- `INTERNAL_ERROR`

Desktop-provided error messages are never forwarded verbatim. The native host maps each accepted error code to fixed user-safe text so paths, identifiers, secrets, and internal diagnostics cannot cross into the browser.

Malformed requests that do not contain a valid request ID use `invalid-request`. Framing errors are answered once when safe and then the host exits because stream alignment can no longer be trusted.

The extension opens a dedicated Native Messaging port for each request and disconnects it after the first response. An unresponsive host is terminated after five seconds; the popup also abandons an unresponsive background message after seven seconds. Either failure is shown as an unexpected bridge error rather than leaving the popup indefinitely in `Connecting…`.

## Compatibility

The extension requires exact protocol version `1`; it does not silently accept another version. Application and extension release versions may change independently while the protocol remains compatible. A future protocol change must add an explicit compatibility path or increment the protocol and produce `UNSUPPORTED_PROTOCOL` for older peers.
