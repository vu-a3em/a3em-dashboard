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
[`../packages/card-helper`](../packages/card-helper).

## Before first use: two things to fill in

### 1. A stable extension ID

`allowed_origins` in the native host manifest names the extension by ID, and an unpacked
extension's ID is derived from its filesystem path — so it differs per machine and the
installed manifest would be wrong everywhere.

```bash
# once, and keep it somewhere safe
openssl genrsa -out a3em-extension.pem 2048
openssl rsa -in a3em-extension.pem -pubout -outform DER | openssl base64 -A
```

Add the output to `manifest.json` as `"key": "<base64>"`. The ID then derives from the key
and is identical on every machine.

> When first uploading to the Chrome Web Store, `key` must be **absent**. Restore it for
> every upload after that, or the ID changes and every installed native manifest breaks.

### 2. The production origin

`externally_connectable.matches` currently lists only localhost. Add the dashboard's real
origin before shipping:

```json
"matches": ["https://a3em.example.org/*", "http://localhost/*"]
```

Match patterns ignore ports, so `http://localhost/*` covers the Vite dev server on 5173.
Wildcard TLDs (`*://*.com/*`) and `<all_urls>` are rejected — the host must be named
explicitly, which means **changing the dashboard's hostname later requires republishing
the extension**. Worth settling the hostname before the first submission.

## Loading it for development

1. `chrome://extensions` → enable Developer mode → **Load unpacked** → this folder.
2. Copy the extension ID it shows.
3. Register the native host:

   ```bash
   npm --workspace @a3em/card-helper run build
   npm run install-helper -- --extension-id <id>
   ```

   That writes the manifest for every Chromium browser it finds, then spawns the host and
   exchanges a real message to prove the registration took.

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
