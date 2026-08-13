# Release and store publishing

Tags such as `v1.0.0` must match both `package.json` and the Rust workspace version. The release workflow runs TypeScript checks/tests, Firefox manifest linting, Rust tests/formatting, builds reproducible Chrome and Firefox ZIPs, packages the native host for Windows x64, Linux x64, and both macOS ARM64 and x64, and attaches the artifacts plus `SHA256SUMS` to the GitHub Release. Unix hosts use `tar.gz` so executable permissions survive artifact transport.

Pull-request workflows never publish to either store. Store jobs exist only in the tag-triggered workflow and run only when their required secrets are configured.

CI uses the current stable Node/npm toolchain and rejects dependency lifecycle scripts not covered by the pinned `allowScripts` review in `package.json`. Dependency updates that change an install-script package must be reviewed before that allow-list pin is updated.

## Chrome Web Store one-time setup

1. Create the item manually and complete its Store Listing and Privacy tabs.
2. Record the assigned 32-character extension ID. Do not invent it or add a wildcard.
3. Enable Chrome Web Store API v2 in a Google Cloud project.
4. Create OAuth credentials and a refresh token with the `https://www.googleapis.com/auth/chromewebstore` scope, using the Google account that owns the item.
5. Record the Publisher ID from the Developer Dashboard.
6. Configure the production desktop native-host manifest with the assigned extension ID.

GitHub Actions secrets:

- `CHROME_CLIENT_ID`
- `CHROME_CLIENT_SECRET`
- `CHROME_REFRESH_TOKEN`
- `CHROME_PUBLISHER_ID`
- `CHROME_EXTENSION_ID`

The publisher uses the official Chrome Web Store API v2 upload and publish endpoints. Store credentials are injected only into the publication step, after checkout, dependency installation, and artifact download; they are never written into extension artifacts.

## Firefox AMO one-time setup

The stable extension GUID is already in the manifest. Create AMO API credentials and add:

- `AMO_JWT_ISSUER`
- `AMO_JWT_SECRET`

The workflow submits the built archive and `store/firefox-metadata.json` directly through AMO API v5. It creates a fresh short-lived HS256 JWT for every request using only Node's built-in crypto APIs, so release publishing does not pull in a separate signing toolchain. The first submission creates the listing; later versions update the same GUID. AMO performs validation, signing, and publication/review.

## Version compatibility

Extension release versions follow this repository's tags. They do not need to match the WinOTP desktop app version. Protocol compatibility is an explicit independent value (`1`) and cannot be inferred from SemVer.
