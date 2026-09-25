# A3EM card helper

The native program the dashboard uses, through the [browser extension](../extension), to work
on SD cards directly: list the cards plugged into this computer, check whether one is ready to
deploy, and prepare cards — test, erase, format, verify and configure them — in one step.

It is written in Go so that it ships as one self-contained executable per platform, with no
runtime to install. It replaces the earlier TypeScript helper, which needed Node.js and only
ever worked on macOS.

## What it does

| Operation | What happens |
| --- | --- |
| `listDevices` | Removable cards only. The startup disk, internal disks, external drives, and anything outside 1 GiB–2 TiB never appear, so the page can never offer them. |
| `readiness` | Everything about a card that can be learned without writing to it: its layout compared byte for byte with the reference, lock switch, contents, `_a3em.cfg`, free space, the card's identity (its CID register, where the reader exposes it), and what this computer recorded when it prepared it. The dashboard judges the facts with `judgeReadiness` in the schema package. |
| `prepare` | For each card: the capacity probe, the write-latency test, the reference exFAT layout written and read back, the layout verified, the card mounted, and its unit's `_a3em.cfg` written. A batch is one operation, so it costs one administrator prompt; every card still needs its own confirmation. |
| `verify` | The layout comparison on its own. |
| `format` | `prepare` without the two tests, for a card that is known to be good. |
| `diagnose` | [This helper's own check](#the-filesystem-check) of an exFAT card, read-only, the same on every platform; what is wrong in words, with the files it touches. A card that is not exFAT goes to the system's checker. |
| `repair` | This helper's own repair where the check shows it fixes everything — the allocation bitmap rebuilt from the files, or a boot region restored from its intact copy — saving what it replaces first, in the state folder's `repairs`, kept 30 days and at most 256 MB; otherwise the system's tool, `fsck_exfat` / `fsck.exfat` / `chkdsk`. |
| `image` | A sector-by-sector copy to a file, continuing past unreadable sectors. |
| `chooseImage` | The system's own save dialog for a card's image (AppleScript on macOS, the desktop portal's — GNOME's, KDE's — on Linux, else zenity or kdialog, Windows Forms on Windows), then whether the image fits there: free space, and the 4 GB file limit of a FAT32 drive. `image` makes the same check itself before reading a byte, writes to `<name>.partial`, and moves it into place only once it is whole. Without a dialog — a Linux session with no portal, zenity or kdialog — the image goes in `Documents/A3EM card images`. |
| `stop` | Stops a running `image` or `diagnose`, named by its request id; a stopped image's unfinished file is deleted. The page sends it for its Stop button, and the page closing stops them too. A `prepare`, `format` or `repair` is never stopped partway: a half-written card is worse than a slow one. |
| `hello` | The version, platform and operations, and anything this computer lacks that the tools rely on — on Linux, `pkexec`, a polkit agent, `udisks2`, the exFAT driver, a save dialog — which `doctor` prints too, and the dashboard shows beside "Card tools". |
| `mount`, `unmount`, `eject`, `inspect`, `identify`, `writeConfig` | The small ones. |

The helper reports facts; the dashboard decides what they mean. The rules for what the
firmware accepts, whether a configuration parses, and whether free space covers the forecast
already live, tested, in [`@a3em/config-schema`](../packages/config-schema), and are not written
a second time here. The exception is the format request itself, which the helper must refuse on
its own authority: [`internal/rules`](internal/rules) mirrors `validateFormatRequest`, and a
golden test fails if the two ever disagree.

### The layout

[`internal/exfat`](internal/exfat) builds the whole card image itself rather than asking the
system's formatter, so every card gets exactly the layout the recorders were validated against:
an MBR with one exFAT partition at the 2 MiB mark, the FAT and cluster heap aligned to 1 MiB, the
canonical up-case table, and the label `A3EM` unless a unit label is given. It began as a port
of `exfat_image.py`, a Python formatter now retired, and its tests compare it byte for byte with
that script's recorded output for 42 combinations of card size and cluster size
(`internal/exfat/testdata/python-golden.json`).

The format writes, in order: zeros over the first MiB (removing the old partition table, so the
system has nothing to mount mid-write), the volume from the 1 MiB mark, read back and compared,
then the new MBR, read back and compared. Only then does the system see a partition again. The
result is judged by what the card and the system then report, never by an exit code.

### The two card tests

Both are destructive, so they only run while a card is being prepared.

- **Capacity** ([`internal/probe/capacity.go`](internal/probe/capacity.go)). Counterfeit cards
  claim more than they hold and silently wrap or drop writes past the real size. The probe writes
  a uniquely marked 64 KiB block at about 70 places across the claimed capacity, pushes the card's
  cache out with 64 MiB of other writes, and reads every block back. Seconds to a minute.
  It is not a full surface test, which would take one to two hours for 128 GB; it catches every
  counterfeit that misreports its capacity, which is what counterfeits do.
- **Write latency** ([`internal/probe/latency.go`](internal/probe/latency.go)). 64 MiB in
  512 KiB writes to the middle of the card, timing each. A card whose writes stall for over
  a second will make a recorder drop audio.

Their results are kept in a small ledger on this computer, keyed by the identifier the system
derives from the volume serial number the format wrote. A later readiness check of the same
format reports them; a card prepared elsewhere, or formatted again since, says it was not tested.

### The filesystem check

[`internal/exfat/check.go`](internal/exfat/check.go) reads an exFAT card the way the
specification describes it, without mounting it and without any system tool, so the same check
runs on every platform — and finds what each platform's own checker misses: exfatprogs does not
report space marked in use that no file uses, and `fsck_exfat` reports two files sharing space
only as a wrong bitmap. It checks both boot regions and their checksums, the FAT, the up-case
table, every folder and file — entry checksums, name hashes, and each chain of clusters for
ending early, running on, looping or being shared — and then the allocation bitmap against what
the files actually use, both ways. Each finding is a problem (recordings may be lost, or the card
may not open) or minor, in words, naming up to twenty of the files it touches.

[`internal/exfat/repair.go`](internal/exfat/repair.go) fixes the two things that can be fixed
without deciding anything about a file: the allocation bitmap, rebuilt from what the files use —
the usual damage on a card pulled, or losing power, while the recorder is writing — and a boot
region restored from the other, intact copy. It writes only the sectors that differ, after
saving what they held in the helper's state folder, and checks the card again afterward. Anything
else means choosing which of two files keeps a cluster, or cutting a file short, so it goes to
the system's tool, and the dashboard says first which files that may shorten or remove.

`test/crosscheck-macos.sh` and `sudo test/crosscheck-linux.sh` hold the check and repairs up
against `fsck_exfat` and `fsck.exfat` on volumes the system itself formatted and wrote, damaged
four ways: space in use marked free, space marked in use that nothing uses, a damaged boot
region, and two files sharing space. Each repair of the helper's own must leave the system's
checker satisfied and every file byte for byte as it was.

## Safety

- **Invisible, not refused.** Anything that is not removable media never reaches the page.
  [`internal/safety`](internal/safety) is the whole rule, and it is platform-independent.
- **Confirmed in the helper's own words.** A destructive operation needs a grant: the page asks
  for a challenge, the helper describes the device (node, size, bus, what is on it), the person
  confirms that description, and the page redeems the token. Grants are signed with a per-user
  key, bound to the device's fingerprint, expire after a minute, and work once
  ([`internal/grant`](internal/grant)). They are signed rather than remembered because Chrome
  starts a new helper process for every message.
- **The worker trusts nothing.** Raw device access needs administrator rights. On Linux and
  Windows that work runs in a second copy of this executable started with them (`pkexec`, or a
  UAC prompt), which lists devices again with its own privileges and refuses any whose
  fingerprint differs from the one confirmed ([`internal/jobs`](internal/jobs)).
- **On macOS there is no worker.** macOS guards a card's raw device with the Removable Volumes
  permission as well as root ownership, and a root process started through `osascript` is refused
  it ("Operation not permitted"), password or not. So the helper asks for one authorization for
  every device an operation touches (`security authorize`), and `/usr/libexec/authopen` — which
  checks Removable Volumes against the browser that started the helper — opens each device and
  hands the descriptor back. The job then runs in the helper itself; fsck is given the
  descriptor as `/dev/fd/3` ([`internal/blockdev/authorize_darwin.go`](internal/blockdev/authorize_darwin.go)).
- **Test mode hides real devices.** `A3EM_HELPER_VIRTUAL_ONLY=1` makes only disk images visible,
  which is how every test here runs on a computer with a real card attached.

## Platforms

| | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Devices | `diskutil` | `lsblk`, sysfs, `blkid` | Storage cmdlets, `Win32_DiskDrive` |
| Raw access | `/dev/rdiskN`, `F_NOCACHE` | `/dev/sdX`, `O_DIRECT` | `\\.\PhysicalDriveN`, unbuffered |
| Elevation | `security authorize` once, then `authopen` per device | `pkexec` | `Start-Process -Verb RunAs` |
| Filesystem check | this helper's own; `fsck_exfat` for other filesystems and repairs | the same; `fsck.exfat` (exfatprogs) | the same; `chkdsk` |
| Save dialog | AppleScript `choose file name` | the XDG desktop portal's file chooser, over D-Bus ([`internal/dbus`](internal/dbus)); else zenity or kdialog | Windows Forms `SaveFileDialog` |
| Card identity | CID, in the built-in reader | CID, in a native SD slot | reader only |

Each file in [`internal/platform`](internal/platform) opens with what that system does that its
manual pages do not lead you to expect: an external SSD is "ejectable" on macOS but not
"removable", `lsblk` reports no filesystem without udev, Windows refuses raw writes into a
mounted volume until it is locked and dismounted.

## Developing

Go 1.22 or later.

```sh
go test ./...                                   # unit tests, any platform
go build -o dist/ ./cmd/a3em-card-helper
dist/a3em-card-helper call '{"op":"listDevices"}'   # one request, without a browser
```

From `Web/`, `npm run install-helper` builds it and registers it with every Chromium browser
found (`-- --extension-id <id>` for a differently keyed build of the extension), and
`npm run helper-doctor` checks the registrations and that the helper answers.

### Integration tests

Each prepares a virtual disk exactly as the dashboard prepares a card, and checks the results
with the helper's own verifier and the system's filesystem checker.

```sh
test/integration-macos.sh dist/a3em-card-helper          # an hdiutil image; no password needed
sudo test/integration-linux.sh dist/a3em-card-helper     # a loop device
pwsh test/integration-windows.ps1 -Helper dist\a3em-card-helper.exe   # a VHD, elevated
test/crosscheck-macos.sh dist/a3em-card-helper           # the filesystem check against fsck_exfat
sudo test/crosscheck-linux.sh dist/a3em-card-helper      # and against fsck.exfat
```

The [Card helper workflow](../../.github/workflows/card-helper.yml) runs all three on GitHub's
runners on every push that touches this directory. [`test/e2e`](test/e2e) runs the dashboard's
card screens against the real helper on five virtual disks, in headless Chrome. On a Mac, the Linux test also runs in Docker:

```sh
GOOS=linux GOARCH=arm64 go build -o /tmp/helper-linux ./cmd/a3em-card-helper
docker run --rm --privileged -v /dev:/dev -v "$PWD/test:/test:ro" -v /tmp/helper-linux:/helper:ro \
  debian:bookworm-slim sh -c 'apt-get update -qq && apt-get install -y -qq util-linux fdisk exfatprogs python3 >/dev/null && /test/integration-linux.sh /helper'
```

Nothing here has formatted a real card. Before a release, prepare one real card on each
platform, then check it in a recorder.

## Releasing

Commit and push to `main`, then from `Web/`:

```sh
npm run release:helper              # the next patch version, 0.2.0 → 0.2.1
npm run release:helper -- minor     # 0.2.0 → 0.3.0; or major, or an exact version like 0.4.2
```

It checks that `main` is committed and the same as GitHub's, shows what has changed in the helper
since the last release, and asks before tagging the commit `card-helper-v<version>` and pushing
the tag. The [release workflow](../../.github/workflows/card-helper-release.yml) then runs the
unit tests and builds:

| Asset | |
| --- | --- |
| `A3EM-Card-Helper-macOS.pkg` | Universal. Signed with Developer ID, notarized, stapled. Installs to `/Library/Application Support/A3EM`. |
| `A3EM-Card-Helper-Windows.exe` | x64 and ARM64. Per-user, so no administrator rights to install. Signed through SignPath. |
| `a3em-card-helper_{amd64,arm64}.deb` | Registers system-wide for Chrome, Chromium and Edge; installs a polkit policy. |
| `a3em-card-helper_linux_{amd64,arm64}.tar.gz` | With `install.sh`, for other distributions. |

and publishes them as a GitHub release. Asset names carry no version, so the dashboard's install
guide links to `releases/latest/download/<name>`. A manual run of the workflow from any branch
makes the same builds, unsigned, without publishing. Once SignPath signing is set up, each
release waits for its two signing requests to be approved in SignPath.

### Version numbers

The version exists only in the tag: the workflow builds it into the executable, the installers'
metadata and the release's name, so there is no file to edit. A local build
(`npm run helper:build`) names itself from `git describe`, such as `0.2.0-3-gab12cd3-dirty` for
three commits after 0.2.0 with uncommitted changes, and `a3em-card-helper version` or `doctor`
says which build is installed.

Patch for fixes, minor for new operations, major for anything that breaks an installed
dashboard. Separately, `ProtocolVersion` in [`internal/dispatch`](internal/dispatch/dispatch.go)
and `HELPER_PROTOCOL` in [`app/src/lib/helper.ts`](../app/src/lib/helper.ts) change together
whenever a request or reply changes shape. A dashboard that expects a newer protocol than the
installed helper speaks shows "Card tools: Update…" instead of calling it, so release the helper
before deploying a dashboard that needs it.

Installed helpers do not update themselves: people install the new release over the old one.
Publishing a release rebuilds the dashboard ([Pages workflow](../../.github/workflows/pages.yml)),
which then knows the newest version from the tags, and "Card tools" says "update available" to
anyone whose helper is older. A helper too old for the dashboard's protocol says "Update…"
instead, as before.

### Signing credentials

Run [`packaging/setup-signing.sh`](packaging/setup-signing.sh) on the Mac that holds the Apple
Developer account. It checks for the two Developer ID identities, stores notarization
credentials in the login keychain as the `a3em-notary` profile, and, if asked, copies what CI
needs into encrypted secrets on a GitHub environment called `card-helper-release` that only
`card-helper-v*` tags can deploy to. Nothing it asks for is echoed or written to a file.

| Where | Name | What |
| --- | --- | --- |
| Environment secret | `MACOS_CERTS_P12`, `MACOS_CERTS_PASSWORD` | The Developer ID Application and Installer identities, exported together |
| Environment secret | `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | For `notarytool`: an App Store Connect team API key with the Developer role (recommended) |
| Environment secret | `APPLE_ID`, `APPLE_APP_PASSWORD` | Or instead: an Apple ID and an app-specific password |
| Environment secret | `SIGNPATH_API_TOKEN` | A SignPath CI user's token |
| Repository variable | `APPLE_TEAM_ID` | `D3TVN67UY9` |
| Repository variable | `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_POLICY_SLUG` | From SignPath |

The SignPath project needs two artifact configurations, named `executables` and `installer`;
paste them from [`packaging/windows/signpath`](packaging/windows/signpath). Each release makes two
signing requests, which an approver accepts in SignPath; the workflow waits up to an hour for
each. Anything not configured is skipped with a warning, so an unsigned build still completes.

To build a signed macOS installer locally:

```sh
NOTARY_KEYCHAIN_PROFILE=a3em-notary packaging/macos/build-pkg.sh 0.2.0
```

## Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by
[SignPath Foundation](https://signpath.org). This covers the Windows installer and the
executables in it; the macOS installer is signed with the project's Apple Developer ID.

Team roles:

- Committers and reviewers: [Will Hedgecock](https://github.com/hedgecrw)
- Approvers: [Will Hedgecock](https://github.com/hedgecrw)

Every release is built from this repository by the
[release workflow](../../.github/workflows/card-helper-release.yml) on GitHub-hosted runners, and
every signing request is approved by hand in SignPath.

Privacy: this program will not transfer any information to other networked systems unless
specifically requested by the user or the person installing or operating it. It has no network
code at all: it talks only to the browser that starts it and to the cards and disks on this
computer. The full privacy policy is at https://config.a3em.com/privacy.html.
