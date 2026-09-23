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

### A new version

The version is `version` in [`manifest.json`](manifest.json), and the store refuses an upload
that is not higher than the one it has. So:

```sh
npm run package:extension -- patch    # 0.1.0 → 0.1.1, then packages; or minor, major
```

Commit the changed `manifest.json`, then in the Developer Dashboard open the item, choose
Package, upload the new zip, and submit it for review. Chrome updates installed copies by
itself once the review passes.

That should be rare. The extension only relays messages, so almost every change belongs in the
helper, which ships without a store review. A new extension version is needed only to change
`background.js`, the manifest (its permissions, or the dashboard origin in
`externally_connectable`), or the icons.

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

It works in Chromium browsers that install from the Chrome Web Store: Chrome, Edge, Brave,
Vivaldi, Arc, and Chromium itself (not the Linux snap, which cannot start native helpers).
Opera reads Chrome's native-messaging locations, so the helper works unchanged, but Opera installs
from the Chrome Web Store only after its own "Install Chrome Extensions" add-on. Brave runs the
extension and helper as they are, but turns off the File System Access API the rest of the
dashboard reads cards with; `brave://flags/#file-system-access-api` turns it on, and the
dashboard says so.

Firefox and Safari cannot run it. Firefox has native messaging, but no `externally_connectable`,
so a page cannot talk to an extension directly; Safari extensions must ship inside a Mac app.
Neither has the File System Access API either, so the dashboard falls back to downloads there.

Firefox is not supported: it has never implemented `externally_connectable` for web pages
(bug 1319168). Safari is not supported: its native messaging requires a signed, notarized
containing app. Both keep the dashboard's existing download fallback.
