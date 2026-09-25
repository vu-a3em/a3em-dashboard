# A3EM Dashboard — source

The A3EM Dashboard is a static web application. Everything it does with an SD card happens in the
browser, through the File System Access API: there is no server, and nothing on a card is ever
uploaded. Two optional pieces extend it: the **A3EM Card Helper**, a native program with a
browser extension, for what a web page cannot do with a card, and **accounts**, which keep a
person's saved protocols across computers.

## Getting started

You need Node.js 22 or later, Python 3 for the snapshot checks in `npm run ci`, and Go 1.22 or
later for the helper. Clone with `--recurse-submodules`: the checks read the recorder's
firmware from the `a3em-firmware` submodule.

```sh
cd Web
npm install
npm run dev        # the dashboard at http://localhost:5173
npm test           # the schema package's tests
npm run ci         # everything: drift checks, lint, tests, build
npm run build      # the static site, in app/dist
```

## What is here

| Path | Holds |
| --- | --- |
| [`app`](app) | The dashboard: React and TypeScript, built with Vite. |
| [`packages/config-schema`](packages/config-schema) | Everything that understands an A3EM card: the configuration file's format (`_conf.a3m`) and its validation, the storage and battery forecast, and readers for recordings, IMU files, logs, the device file, and self-test results. No interface. |
| [`card-helper`](card-helper) | The A3EM Card Helper's native program, in Go, for macOS, Windows, and Linux, with its installers. |
| [`extension`](extension) | The A3EM Card Helper's browser extension, which relays messages between the dashboard and the program. |
| [`firebase`](firebase) | Optional accounts: the database rules, their tests, and how to set up the Firebase project. |
| [`tools`](tools) | Scripts for the checks, the snapshots, the helper, and the extension. |
| [`reference`](reference) | The deployment planner spreadsheet, and snapshots generated from it, the firmware, and the earlier desktop tool. |
| [`deployment.json`](deployment.json) | The one hand-edited copy of the extension's identity and the account settings. `npm run sync:extension` writes them wherever they are needed. |

## The dashboard

Its tabs follow a deployment from start to finish.

**Configure.** The device label, the deployment's dates and time zone, and how it records: its
phases, each with a schedule (continuous, periods by clock time or anchored to sunrise and sunset,
intervals, or amplitude-triggered), sample rate, clip length, WAV or Opus, silence detection and
filtering, and the motion sensor. Settings are checked as they are entered, against what the
current firmware accepts and does, and the forecast shows how much of the card and the battery the
deployment will use, when each runs out, and the cluster size to format the card with. Settings
used again and again are saved as **protocols**; six starters ship with the dashboard. The
configuration is written to the card as `_conf.a3m`, or downloaded. With the helper, "Configure
SD Card" prepares the open card instead: checked, then given only what it needs, which may be
only its settings and its name, or, confirmed first, erasing it and setting it up again.

**Prepare devices.** A batch of devices, labeled from a prefix, all with the same settings. Without
the helper, each device's configuration is written to its card through the folder picker, or
the batch is downloaded as one archive. With it, the cards plugged into the computer are listed
and each is checked and prepared: the capacity test that catches counterfeit cards, a write-speed
test, the reference exFAT layout, verified, and the device's configuration; a card that needs
only its settings gets them without being erased, and the device's name with them. Settings changed on
Configure after some cards are written return those devices to "No card yet".

**Review card.** A card back from the field: the self-test, how the deployment went and whether
it stopped early, what the device did, battery and temperature over time, microphone health, an
hour-by-hour grid of when it recorded against its schedule, and a plot of the positions in its log
(with no basemap, so it works offline). A clock set wrong is corrected once and applied to every
time shown. With the helper, the card itself is checked too: its layout, what this computer
recorded when it prepared it, its filesystem, which the helper can repair, and a copy of the whole
card to an image file.

**Listen.** Recordings by day, at corrected times, each with its sample rate, waveform, spectrogram,
and levels. The levels are explained: a dead microphone and a quiet site look alike on a waveform
and mean very different things. Playback corrects a clip's header in memory, so an interrupted
clip plays at its true length without the card being touched.

**Check & copy.** Every recording checked, then copied to a folder on the computer, continuing past
anything unreadable and saying what it left behind. Recordings the device never closed, because it
lost power, keep their audio but not their length; they are told apart from real losses and
repaired in the copy. With the helper, the copy also recovers what logs and IMU files hold
past their recorded end, and the card can be ejected afterward. The card is never written to.

**Recover card.** With the helper: a card that no longer opens is copied to an image, checked,
and repaired.

### Browsers

Reading and writing cards needs the File System Access API, which Chrome, Edge, and the other
Chromium browsers have (Brave behind a flag, which the dashboard points out). Firefox and Safari
can build a configuration and download it. The A3EM Card Helper's extension installs from the
Chrome Web Store.

### Card formats

Two are read: **v1**, the prose logs and date-based file names of firmware from before this
repository, and **v2**, what the current firmware writes. They are told apart by what is on the
card rather than by a version number: current firmware writes a device file at the card's root,
so recordings without one date the card.

The configuration file is `_conf.a3m`. Cards prepared before it was renamed carry `_a3em.cfg`,
which the firmware still reads when there is no `_conf.a3m`, and so does the dashboard, except in
Chrome on Windows, which will not let a web page open any `.cfg` file. That refusal is why the
file was renamed.

## Keeping in step with the firmware

The dashboard must describe the recorder exactly, so the facts it depends on come from their
sources and are checked on every `npm run ci`:

- **Firmware constants.** Every limit and enumeration in
  [`firmware-constants.ts`](packages/config-schema/src/firmware-constants.ts) cites the firmware
  file it came from, and `reference/firmware-snapshot.json`, extracted from the `a3em-firmware`
  submodule, must match both the code and the firmware.
- **Power measurements**, from the planner spreadsheet, in `reference/planner-snapshot.json`.
- **The earlier desktop tool's output**, in `reference/desktop-parity.json`, where the two should
  agree.

`npm run sync` regenerates the snapshots after the firmware or the spreadsheet changes, and
`npm run check:solar` compiles the firmware's sunrise and sunset calculation and compares it with
the dashboard's copy. `npm --workspace @a3em/config-schema run open-items` lists what is still
unmeasured or unresolved.

## The A3EM Card Helper

The program and the extension are released separately from the dashboard, and the dashboard works
without them: `tools/check-helper-isolation.mjs`, part of `npm run ci`, fails if anything in the
dashboard's own card path starts depending on the helper.
[`card-helper/README.md`](card-helper/README.md) covers what the program does, its safety rules,
testing, and releasing and signing it; [`extension/README.md`](extension/README.md) covers the
extension.

## Accounts

Sign-in and storage are Firebase, on its free plan, and store only a person's saved protocols.
With no Firebase configuration in `deployment.json`, the dashboard offers no sign-in at all.
[`firebase/README.md`](firebase/README.md) covers setting up the project, the sign-in methods, and
the database rules.

## Other commands

| Command | |
| --- | --- |
| `npm run check-card -- <folder>` | The dashboard's recording checks, outside the browser, on a mounted card, an image, or a copied folder. |
| `npm run install-helper` | Builds the A3EM Card Helper's program and registers it with every Chromium browser found. |
| `npm run helper-doctor` | Checks the helper's registrations, and that it starts and answers. |
| `npm run test:helper` | The helper program's tests. |
| `npm run release:helper` | Tags an A3EM Card Helper release: see [`card-helper/README.md`](card-helper/README.md#releasing). |
| `npm run package:extension` | Builds the extension's zip for the Chrome Web Store. |
| `npm run test:rules` | The account database rules, against the Firebase emulator. |
| `npm run deploy:rules` | Publishes the database rules. |
