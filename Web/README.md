# A3EM web dashboard

Browser-based replacement for the Tkinter management dashboard in [`../Python`](../Python).

```bash
cd Web
npm install
npm run dev        # http://localhost:5173
npm run build      # builds the schema package, then the app
npm run ci         # snapshot drift check, tests, and build
```

Chrome, Edge, or Opera for direct SD card access.

## Layout

| Path | Holds |
| --- | --- |
| [`packages/config-schema`](packages/config-schema) | Everything that understands an A3EM card: config, device info, IMU files, logs, self-test results, plus the forecast model and validation. No UI. |
| [`app`](app) | The interface. Vite, React, TypeScript. |
| [`card-helper`](card-helper) | The native card helper, in Go, for macOS, Windows and Linux: lists the cards plugged in, checks one is ready to deploy, and prepares cards — capacity test, write test, the reference exFAT layout, verification, configuration — in one step. Installers are published as GitHub releases. |
| [`extension`](extension) | The Chromium extension that bridges the page to that host. A relay, nothing more. |
| [`firebase`](firebase) | Optional accounts: the Firestore security rules that are their whole server side, their tests, and how to set up the Firebase project. |
| [`tools`](tools) | Snapshot extractors for the firmware and the planner spreadsheet, plus `check-card.mjs` and `helper.mjs`, which builds and registers the card helper. See [MAINTENANCE.md](MAINTENANCE.md). |
| [`reference`](reference) | The planner spreadsheet and the generated snapshots. |

## What exists so far

**Protocols** — the recording settings a lab reuses, saved by name and versioned, so a
new deployment is a label, a date range, and a device. Four starters ship with the app.
A protocol never stores a device label, dates, or a timezone; applying one keeps whatever
is already entered and rebases phase boundaries onto the current window. Local storage
for now, in the shape that will sync when accounts exist.

**Configure** — device, schedule, recording, and motion settings, with live storage and
battery forecasting and inline validation. Writes `_a3em.cfg` directly to a connected
card, or downloads it. Validation is parameterised by firmware version, read from the
card when available and otherwise assumed to be the older, more dangerous behaviour.

**Listen** — browse a card's recordings by day at corrected times, with each file's own
sample rate shown, since the device patches the rate it measured into every header and a
card can hold files at more than one, see each one's
waveform and levels, and play it. Reports what the levels mean rather than only what they
are: a dead or disconnected microphone reads as a constant, which looks identical to a
quiet site on a waveform and is completely different in what it costs. Nothing is read
until a recording is chosen, and playback corrects the header in memory so legacy and
interrupted clips play at their true length without the card being touched.

**Coverage and position** — an hour-by-hour grid of when the deployment recorded against
when its configuration said it should, separating hours that are genuinely missing from
hours that were never scheduled, and reporting the end of recording once rather than as
one gap per hour. Positions from the log are plotted with a scale bar and no basemap, so
it works with no connectivity.

**Check and copy** — a structural check over every recording, then a copy that continues
past anything it cannot read and says exactly what it left behind. Recordings the device
never closed — power lost mid-clip, leaving the audio intact but its length unrecorded —
are identified separately from genuine losses and repaired in the copy. The card itself is
never written to.

**Review card** — connect a retrieved card and see whether the hardware self-test
passed, whether the deployment ended early and why, battery and temperature over time,
microphone health across the deployment, and anything on the card that could not be
read. Clock correction is entered once and applied to every displayed time; nothing on
the card is modified.

## Not built yet

Everything requiring accounts. The position plot has never been exercised against a real
GPS fix — see `data.gps-log-sample` in the open items. See [`design-plan.html`](design-plan.html) for where those
fit — with one correction to it: there is no ultrasonic starter protocol, because the
maximum sample rate is 48 kHz and nothing above 24 kHz can be recorded at all.

## Card formats

Two are supported: **v1**, the legacy prose logs and date-based filenames from firmware
before this repository's, and **v2**, whatever the current firmware writes. There are
correspondingly two capability profiles, told apart by evidence on the card rather than a
version number — current firmware writes a device file at the root, so its absence beside
real recordings dates the card. Formats from builds in between are not carried — the contract is checked against the firmware source on every
run, so there is no need to guess at intermediate shapes.

## Deploying to GitHub Pages

The dashboard is a static bundle. Every card operation runs in the browser through the
File System Access API and there is no server to talk to, so Pages hosts the whole thing
rather than part of it. Nothing here needs a custom response header, which is the usual
reason a single-page app cannot live on Pages.

[`.github/workflows/pages.yml`](../.github/workflows/pages.yml) builds `Web/` on every
push to `main` and publishes `Web/app/dist`. It runs the full `npm run ci` rather than a
bare `vite build`, so a stale firmware snapshot, a lint error or a failing test stops the
deploy instead of shipping.

To turn it on: **Settings → Pages → Build and deployment → Source: GitHub Actions.** That
is the only setting the workflow needs. The repository must be public, or on a plan that
allows private Pages.

### Which URL, and why it matters

Pages serves a project site at `https://<owner>.github.io/<repo>/` unless a custom domain
is configured. Both work without touching the build: `vite.config.ts` sets `base: './'`,
so every asset reference in `index.html` is relative and the bundle runs from any path.

What does NOT float is the Chromium extension. `deployment.json` declares
`dashboardOrigin`, and `npm run sync:extension` writes it into the extension's
`externally_connectable.matches`; `npm run ci` fails if the two drift. The extension will
only talk to a page served from that exact origin, so card tools — format, recover, eject
— go dead on any other URL. Pick one:

- **Custom domain** (what `deployment.json` currently says: `https://config.a3em.com`).
  Point a DNS `CNAME` record for that name at `<owner>.github.io`, set it under
  Settings → Pages → Custom domain, and tick **Enforce HTTPS** once the certificate is
  issued. Nothing in the repository changes.
- **The default project URL.** Set `dashboardOrigin` in `deployment.json` to
  `https://<owner>.github.io`, run `npm run sync:extension`, and reload the unpacked
  extension. Note the origin is the host alone — an origin has no path — so an extension
  pinned this way can talk to every Pages site under that account, which is a reason to
  prefer the custom domain.

If a configured custom domain ever comes unset (it is stored as a repository setting, not
in the tree), commit a file at `Web/app/public/CNAME` containing just the hostname:
`public/` is copied verbatim into `dist`, so the domain then travels with the artifact.
Only do this once the domain is real, because that file makes the `github.io` URL redirect.

### The firmware submodule

The snapshot checks in `npm run ci` read `a3em-firmware`, so the workflow checks out
submodules. If that repository is private to your account, the checkout fails with a
permissions error; either grant the workflow a token that can read it, or drop `npm run
ci` to the steps that do not need it:

```yaml
- run: node tools/sync-extension-manifest.mjs --check
- run: node tools/check-helper-isolation.mjs
- run: npm run lint
- run: npm test
- run: npm run build
```

You lose only the "is the committed snapshot still current?" check. The tests themselves
still compare against the committed snapshots, so drift is caught the next time anyone
runs CI with the firmware present. No `pip install` is needed either way: the parity tool
falls back to a built-in pytz shim and loads `Python/dashboard/write_config.py` directly
rather than importing the Tkinter application.

## Related documents

- [FIRMWARE-FINDINGS.md](FIRMWARE-FINDINGS.md) — what the firmware actually does, and every place the desktop tool disagreed with it
- [FIRMWARE-CHANGE-PLAN.md](FIRMWARE-CHANGE-PLAN.md) — the firmware changes and why
- [NATIVE-HELPER-PLAN.md](NATIVE-HELPER-PLAN.md) — proposed Chromium extension and native host for mounting, formatting, and recovering cards directly
- [MAINTENANCE.md](MAINTENANCE.md) — keeping the app in step with firmware and the power model
- `npm run check-card -- <directory>` — runs the integrity check over a card outside the browser, for a mounted image or a copied folder
- `npm run helper-doctor` — checks whether the card helper is installed and actually runs (`npm run test:helper` runs its tests; both need Go)
- `npm --workspace @a3em/config-schema run open-items` — everything still unmeasured or unresolved
