# A3EM Card Helper — browser extension

A relay between the dashboard page and the native host. It contains no card logic and
should not acquire any.

## Why it is this small

The extension is distributed through the Chrome Web Store, so every change to
[`background.js`](background.js) needs a review — hours to weeks, unpredictable. The
native host updates by installer with no review at all. Keeping the extension a dumb pipe
means it is reviewed roughly once and then left alone, while the part that actually
changes stays free to change.

If you are about to add something here, it almost certainly belongs in
[`../card-helper`](../card-helper), the native helper.

## Its ID, and where it is written

[`deployment.json`](../deployment.json) holds the extension's public key and the ID derived from
it; `npm run sync:extension` writes them into [`manifest.json`](manifest.json), the native
helper's registration, and the dashboard, and `npm run ci` fails if any copy has drifted or if the
ID is not the key's. The key in the manifest exists so that an unpacked extension, loaded for
development, gets the published extension's ID.

The Chrome Web Store assigns the published ID when the item is first uploaded. Copy that item's
public key from the Developer Dashboard (Package tab, "View public key", as one line without the
BEGIN/END lines) into `extensionPublicKey`, its ID into `extensionId`, and run
`npm run sync:extension`. Do it before releasing the card helper: the helper answers only the
extension it names.

`externally_connectable` names the dashboard's origin, from `dashboardOrigin`. Changing the
hostname later means a new extension version and another store review.

## Publishing

`npm run package:extension` builds the zip to upload, without the manifest's `key` (the store
keeps its own). What to enter in each tab of the listing is in
[`STORE-LISTING.md`](STORE-LISTING.md); the privacy policy it links to is
[`PRIVACY.md`](PRIVACY.md).

## Loading it for development

1. `chrome://extensions` → enable Developer mode → **Load unpacked** → this folder.
2. Copy the extension ID it shows.
3. Register the native host (needs Go 1.22 or later), or install a release of it:

   ```bash
   npm run install-helper -- --extension-id <id>
   ```

   That builds the helper and writes its manifest for every Chromium browser it finds.
   `npm run helper-doctor` then starts it the way a browser would and exchanges a real
   message, to prove the registration took.

4. Point the app at it, if the ID is not the published one:

   ```bash
   VITE_A3EM_HELPER_EXTENSION_ID=<id> npm run dev
   ```

`npm run helper-doctor` re-runs the verification at any time.

## Debugging

- **Service worker logs**: `chrome://extensions` → the extension → "service worker".
- **Host logs**: the host writes diagnostics to stderr, which Chrome surfaces in that same
  console.
- **"Specified native messaging host not found"**: the manifest is missing, in the wrong
  directory for this browser, or its `path` points somewhere that does not exist. Run
  `npm run helper-doctor` — it checks all three.
- **The page gets `undefined` back**: the service worker returned a falsy value from
  `onMessageExternal` instead of `true`, closing the message channel before the async
  reply. This is the most common way the bridge appears to do nothing at all.

## Browser support

Chrome and Edge are the targets. Opera reads Chrome's native-messaging directories, so
the host side works unchanged — but Opera will not install from the Chrome Web Store
without its "Install Chrome Extensions" add-on, which is a manual step for the operator.

Firefox is not supported: it has never implemented `externally_connectable` for web pages
(bug 1319168). Safari is not supported: its native messaging requires a signed, notarized
containing app. Both keep the dashboard's existing download fallback.
