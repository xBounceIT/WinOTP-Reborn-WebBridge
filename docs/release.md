# Release and store publishing

Tags such as `v1.0.0` must match both `package.json` and the Rust workspace version. The release workflow runs TypeScript checks/tests, Firefox manifest linting, Rust tests/formatting, builds reproducible Chrome and Firefox ZIPs, packages the native host for Windows x64, Linux x64, and both macOS ARM64 and x64, and attaches the artifacts plus `SHA256SUMS` to the GitHub Release. Unix hosts use `tar.gz` so executable permissions survive artifact transport.

Pull-request workflows never publish to either store. Store jobs exist only in the tag-triggered workflow and run only when their required secrets are configured.

CI uses the current stable Node/npm toolchain and rejects dependency lifecycle scripts not covered by the pinned `allowScripts` review in `package.json`. Dependency updates that change an install-script package must be reviewed before that allow-list pin is updated.

## Chrome Web Store one-time setup

1. Create the item manually and complete its Store Listing and Privacy tabs. Use
   `https://github.com/xBounceIT/WinOTP-Reborn-WebBridge/blob/main/PRIVACY.md` as the public
   privacy-policy URL.
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

### Recovering an incomplete Chrome submission

`INVALID_ITEM_METADATA` from the publish endpoint means that the uploaded package cannot
be submitted until the item's dashboard metadata is completed. Changing the ZIP, increasing
the version, or disabling `blockOnWarnings` does not complete these required fields. The v2
API cannot edit Store Listing, Privacy practices, or Distribution metadata.

Open the item's Developer Dashboard and check the publishing requirements. Complete the
description, category, language, required images, distribution settings, privacy-policy URL,
single purpose, permission justifications, remote-code declaration, and data-use disclosures
as indicated by the dashboard. For the current extension, these descriptions explain the
permissions:

- Single purpose: Connect the browser to the local WinOTP Reborn desktop app to request
  one-time passwords and send explicitly selected authenticator QR codes for desktop import review.
- `nativeMessaging`: Exchange account labels and explicitly requested codes with the local
  WinOTP Reborn bridge, and forward a user-confirmed QR import to the desktop app.
- `activeTab`: Capture the visible tab only after the user explicitly starts a QR scan.
- `scripting`: Inject the bundled selection overlay so the user can select and confirm the
  area to decode. No page content is inspected automatically.
- Remote code: None; the selection overlay and QR decoder are bundled with the extension.

Data-use disclosures must reflect `PRIVACY.md`, including temporary local processing of
account labels, requested authentication codes, and the selected QR image. Do not infer that
all data-use fields can be left blank merely because there is no remote transmission.

After saving the missing dashboard fields, run **Retry Chrome Web Store submission** from
GitHub Actions on `main`, with `release_tag` set to `v1.1.0` (or the existing release matching
the current package version). This downloads and validates the original Chrome ZIP from
the existing GitHub Release, then retries upload and submission. It preserves the release
version, tag, and assets and does not submit Firefox again. The regular tag workflow is for
new releases; rerunning it in full would also attempt to recreate the existing GitHub Release
and resubmit the Firefox version.

## Firefox AMO one-time setup

The stable extension GUID is already in the manifest. Create AMO API credentials and add:

- `AMO_JWT_ISSUER`
- `AMO_JWT_SECRET`

The workflow submits the built archive, its matching reproducible source archive, the public
privacy policy, and `store/firefox-metadata.json` directly through AMO API v5. It creates a
fresh short-lived HS256 JWT for every request using only Node's built-in crypto APIs, so
release publishing does not pull in a separate signing toolchain. The first submission creates
the listing; later versions update the same GUID. AMO performs validation, signing, and
publication/review.

The source archive includes `AMO_BUILD.md`, the Node dependency lockfile, build tooling,
manifests, assets, and TypeScript sources required to reproduce the submitted Firefox ZIP. The
publisher validates its package version and required contents before making any AMO request,
then attaches it to the exact submitted version and updates the AMO privacy-policy text.

## Version compatibility

Extension release versions follow this repository's tags. They do not need to match the WinOTP desktop app version. Protocol compatibility is an explicit independent value (`1`) and cannot be inferred from SemVer.
