# Native card helper — plan for approval

Adding direct SD card management to the web dashboard: mount, eject, inspect, format
at a chosen allocation unit, and recover cards too corrupted to mount. Via a Chromium
browser extension and a native messaging host.

Item IDs are stable — reply with IDs to approve, reject, or amend.

Firmware line numbers refer to the `a3em-firmware` submodule as currently checked out.

**Scope settled (2026-09-14).** Chromium only — Chrome, Edge, Opera. No Firefox, no
Safari. Filesystem repair is in scope, but only for the unmountable-card case, which
changes its design substantially (Part 5).

**Implementation status (2026-09-14).** Transport, safety, and the macOS platform are
built and green; Windows and Linux are structured stubs. See
[Part 9](#part-9--implementation-status) for what exists and what is left.

---

## Part 0 — Why this is worth building

### The app already made the decision it cannot execute

[`packages/config-schema/src/allocation-unit.ts`](packages/config-schema/src/allocation-unit.ts)
is a complete model of the cluster-size trade-off: write transactions against slack,
weighted across a deployment's phases, budgeted at 2.5% of capacity. It picks a unit,
explains the choice, and quantifies what the connected card is losing by disagreeing
with it.

Then [`allocation-unit.ts:354`](packages/config-schema/src/allocation-unit.ts#L354) ends
the chain:

```ts
/**
 * The `newfs_exfat` invocation that produces the recommended unit.
 *
 * Shown rather than run: reformatting erases the card, so it is the user's to type.
 */
export function formatCommandFor(unitBytes: number, devicePath = '/dev/diskN'): string {
```

`/dev/diskN` — the app does not know which disk, because the File System Access API
never tells it. So [`DeploymentEditor.tsx:881`](app/src/views/DeploymentEditor.tsx#L881)
renders a command with a placeholder in it, for a field ecologist to translate into a
real device node in a terminal at six in the morning.

That is the gap. The analysis is done and tested; only the arm that acts is missing.

### There is a data-loss hazard the app cannot currently see

This one is worth building for on its own.

The firmware's FatFs is compiled with `FF_LBA64 = 0`
([`ffconf.h:206`](../a3em-firmware/src/external/fatfs/ffconf.h#L206)). That switch guards
the entire GPT branch of `find_volume()`
([`ff.c:3347-3366`](../a3em-firmware/src/external/fatfs/ff.c#L3347)) — with it off, the
code that understands GUID partition tables is not compiled in at all.

So on a GPT-partitioned card, the firmware walks the protective MBR's first entry, finds
the GPT header where it expects a volume boot record, and concludes there is no
filesystem. And `storage_init()`
([`storage.c:775-779`](../a3em-firmware/src/peripherals/src/storage.c#L775)) reacts to
`FR_NO_FILESYSTEM` by formatting:

```c
FRESULT res = f_mount(&file_system, "", 1);
if (res == FR_NO_FILESYSTEM)
{
   const MKFS_PARM opts = { .fmt = FM_EXFAT, .n_fat = 0, .align = 0, .n_root = 0, .au_size = SD_CARD_ALLOCATION_UNIT_BYTES };
   if (f_mkfs("", &opts, work_buf, sizeof(work_buf)) != FR_OK)
```

**A GPT card is silently erased on insertion.** Not refused, not reported — reformatted,
and the deployment proceeds onto a blank card as though nothing happened. macOS Disk
Utility offers "GUID Partition Map" and, in the full-device view, defaults to it. A card
prepared that way looks perfectly healthy in Finder and is destroyed by the device.

The dashboard cannot detect this today: a directory handle exposes files, not partition
tables. A native helper reads it in one call.

### The firmware's card contract, in full

Everything the helper must produce or verify, from the pinned source:

| Requirement | Source | Consequence of getting it wrong |
| --- | --- | --- |
| Partition scheme **MBR**, not GPT | `FF_LBA64 = 0`, `ffconf.h:206` | Card silently reformatted on insert; all data lost |
| Filesystem **exFAT** | `FM_EXFAT`, `storage.c:777` | Not mounted; reformatted |
| Logical sector size **512 B** | `FF_MIN_SS = FF_MAX_SS = 512`, `ffconf.h:196` | Not mounted; reformatted |
| Single volume, first partition | `FF_VOLUMES 1`, `FF_MULTI_PARTITION 0` | Later partitions never examined |
| Allocation unit per deployment | `allocation-unit.ts` | Wasted capacity, or excess card wear |
| Device's own default: **32 kB** | `SD_CARD_ALLOCATION_UNIT_BYTES`, `static_config.h:44` | What you get if the device formats it |

**Doc correction (no code change).** [`FIRMWARE-FINDINGS.md:614`](FIRMWARE-FINDINGS.md#L614)
states the device formats with `au_size = 4096`. The constant is `32 * 1024`
(`static_config.h:44`); it entered the tree as `128 * 1024` in firmware commit `934328f`
and was later reduced. The 4096 reading predates the constant. One-line fix to the
findings doc, listed here so it is not lost.

---

## Part 1 — Architecture

### N1. Page → service worker → native host

Three hops. Dropping Firefox is what buys the short path.

```
  dashboard page
        │  chrome.runtime.sendMessage(EXTENSION_ID, msg)
        ▼
  extension service worker          ◀── externally_connectable gate
        │  chrome.runtime.connectNative
        ▼
  native host (Node)
        │
        ▼
  diskutil / PowerShell / udisks
```

The page talks to the extension directly via `externally_connectable`:

```json
"externally_connectable": {
  "matches": ["https://<dashboard-host>/*", "http://localhost/*"]
}
```

and the service worker answers on `chrome.runtime.onMessageExternal`.

Firefox has never implemented this — bug 1319168 is still open after a decade — and
working around it means injecting a content script into the page and relaying through
`window.postMessage`. That was the four-hop design in the previous draft. It is now
gone, and with it the injected script, the origin checks we would have had to write by
hand, and the `content_scripts` host permission. **The origin allowlist is now enforced
by the browser rather than by our own code**, which is both safer and materially easier
to get through Web Store review (N13).

Two details worth recording because they bite at implementation time:

- **The page must hardcode the extension ID.** That is fine and is why N12 pins it.
- **`http://localhost/*` is permitted** in `externally_connectable.matches`, so the Vite
  dev server on :5173 works. Match patterns ignore the port. Wildcard TLDs
  (`*://*.com/*`) and `<all_urls>` are rejected — the production dashboard host must be
  named explicitly, which means **moving the dashboard to a new domain requires
  republishing the extension**. Worth knowing before choosing a hostname.

### N2. Why native messaging rather than a localhost daemon

The alternative — ship a helper that listens on `http://127.0.0.1:PORT` and have the
page `fetch()` it — needs no extension at all, which is genuinely attractive. It loses
on four counts:

- **Chrome 142 gates it.** Local Network Access now requires an explicit user permission
  prompt for requests from a public origin into loopback, and the request must be
  annotated `targetAddressSpace: "local"` to be exempted from mixed-content blocking.
  A permission prompt per machine, that a user can deny permanently, sitting in front of
  the feature. Native messaging is unaffected by LNA.
- **It must run.** A daemon needs autostart, port-conflict handling, and a lifecycle.
  A native messaging host is spawned by the browser on first message and dies with it.
- **Wider reach.** Any local process can hit an open port. A native messaging host can
  only be spoken to by an extension listed in its own manifest.
- **Origin checking is ours to get right.** The daemon would have to authenticate
  callers itself; `allowed_origins` is enforced by the browser.

### N3. Message size: do not move file data through this

Native host → extension is capped at **1 MB per message**. (Extension → host is 64 MB,
but the small direction is the binding one.)

This is a design constraint, not a nuisance: the native host returns *verdicts and
progress*, never payloads. Directory listings from a 250,000-file card must be paged or
summarised. Audio never crosses this channel — it already flows through the File System
Access API, and should keep doing so.

### N4. Browser support

| Browser | Card access today | With the extension | Confidence |
| --- | --- | --- | --- |
| Chrome | Full (FS Access API) | Full | Primary target |
| Edge | Full | Full | Reads its own registry/manifest tree; one extra install step |
| Opera | Full | Expected full | **Lowest** — see below |

**Opera carries a caveat.** It reads *Chrome's* native messaging manifest directories, so
the host side comes essentially free. The friction is the extension itself: Opera does
not install from the Chrome Web Store without the "Install Chrome Extensions" add-on.
So Opera support costs nothing in code but does not come free in instructions. Treat it
as supported-if-it-works rather than a guaranteed target, and verify (item V5).

Firefox and Safari are out of scope by decision. Both keep today's download fallback and
neither regresses.

---

## Part 2 — The two hard problems

### N5. Correlating a directory handle to a device node

The page holds a `FileSystemDirectoryHandle`. It has a `name` and nothing else — no
path, by design. The native host sees `/Volumes/A3EM` or `E:\`. Acting on the wrong one
means formatting the wrong card.

**Matching on volume name and size is not acceptable here.**
[`BatchPrepare.tsx`](app/src/views/BatchPrepare.tsx) exists to prepare six units in one
sitting from identical cards. Six cards named `A3EM` of identical capacity is the
*normal* case, not the edge case, and a heuristic match would pick one of them at random.

**Proposal — nonce probe.** Exact, and uses only capabilities both sides already have:

1. Page generates a UUID and writes an empty file `.a3em-probe-<uuid>` through the
   directory handle it already holds.
2. Page asks the host: "which device carries a file named `.a3em-probe-<uuid>`?"
3. Host enumerates *removable* volumes only and stats that one filename in each root.
   One match → that device node. Zero or more than one → refuse, do not guess.
4. Page deletes the probe file.

One write, to a card we were already going to write, on a filename the existing scanner
skips (`scanCard` in [`card.ts`](app/src/lib/card.ts) ignores dot-prefixed entries, so a
stranded probe cannot pollute a card listing). It doubles as proof we hold write access.
The host stats a known filename rather than listing directories, so a 250,000-file card
costs one syscall, not a walk.

**This applies only to cards that mount.** The recovery flow has no handle to probe with
and needs a different entry path entirely — see N16.

**After a format, the handle is dead.** The volume it referred to no longer exists. The
page must drop the handle, clear the IndexedDB entry via `forgetCardHandle()`, and
re-prompt. Design this into the flow as a step — "Formatted. Reconnect the card to
continue." — rather than letting it surface as a stale-handle error.

### N6. Privilege, per platform

**What follows was verified on this machine today (Darwin 25.6) for macOS; Windows and
Linux are from documentation and marked accordingly.**

**macOS — verified, with one caveat.**

- `diskutil partitionDisk /dev/diskN MBR ExFAT NAME 100%` **succeeded without sudo** and
  produced `FDisk_partition_scheme` — exactly the MBR layout the firmware needs.
  `diskutil` works through `diskarbitrationd`, which authorizes the console user for
  removable media.
- `newfs_exfat -R -b 32768 -v NAME /dev/diskNs1` **succeeded without sudo** and produced
  `Bytes per cluster: 32768`.
- **Caveat that matters.** The test ran against a file-backed disk image, whose device
  node `hdiutil` created as `hedgecrw:staff`. A physical card's node is `root:operator`
  with mode `brw-r-----`, and the console user is not in `operator`. So the `newfs_exfat`
  result **probably does not generalise to a real SD card** — it likely needs elevation,
  while the `diskutil` paths likely do not. **Test against a physical card before the
  privilege design is settled** (item V1).
- If elevation is needed, the low-ceremony route for a lab tool is
  `osascript -e 'do shell script "…" with administrator privileges'`, which raises the
  standard macOS auth dialog with no code-signing requirement. The proper route is a
  `SMAppService` privileged helper, which needs a Developer ID and an app bundle.
  Start with the former; treat the latter as hardening.

**Two macOS traps found by testing, both of which would have shipped as bugs:**

1. **`newfs_exfat` without `-R` silently does nothing and exits 0.** Given an
   already-exFAT device whose cluster size differs from `-b`, it prints
   `Cluster size differs from command line argument; skipping reformat` and returns
   success. A format button built on the command in `formatCommandFor()` — which does
   not pass `-R` — would report success while changing nothing. **`-R` is mandatory, and
   the result must be verified by re-reading the cluster size, not by trusting the exit
   code.**
2. **`statfs` is the wrong source for cluster size.** `stat -f %k` on a mounted exFAT
   volume returned `1048576` — macOS's optimal I/O size, not the 4096-byte cluster.
   Use `diskutil info -plist`, whose `VolumeAllocationBlockSize` was correct and needs no
   elevation.

**Windows — from documentation, unverified.** `Format-Volume -FileSystem exFAT
-AllocationUnitSize 32768` requires an elevated session; 32768 is a documented-supported
value. Partitioning via `Initialize-Disk -PartitionStyle MBR` likewise. Route: relaunch
the worker elevated with `ShellExecute` `runas`, raising the standard UAC prompt.

**Linux — from documentation, unverified.** `udisksctl mount/unmount` goes through
polkit and needs no root. `mkfs.exfat -c 32K` (exfatprogs) does — udisks2's `Format`
method does not expose cluster size, so this path is `pkexec mkfs.exfat -c 32K` rather
than udisks. `sfdisk` for the MBR label.

---

## Part 3 — The native host

### N7. Node, reusing `@a3em/config-schema`

The host mostly shells out to platform tools, which any language could do. The reason to
choose Node is what comes next: [`tools/check-card.mjs`](tools/check-card.mjs) already
runs the app's real `judgeWavFile`/`judgeImuFile` over a mounted card outside the
browser, and [`transfer.ts`](app/src/lib/transfer.ts) already knows how to repair a WAV
header the device never closed.

Reimplementing any of that in Go or Rust creates precisely the parity drift this repo
spends effort preventing — `desktop-parity.json`, the snapshot tests, the whole of
[`MAINTENANCE.md`](MAINTENANCE.md). The host should import the same package the app
imports, so "what the tool says" and "what the app says" cannot diverge.

Ship as a Node Single Executable Application, or a small launcher plus bundled runtime.
Binary size (~60 MB) is irrelevant for a lab tool installed once per laptop.

**Follow-on this unlocks, explicitly out of scope here.** Once a trusted native process
is present, "Check & copy" could run card-side at native speed instead of streaming every
byte through the browser, with only progress crossing the 1 MB channel. Its own plan —
noted so the architecture choice is made in view of it.

### N8. Command set

```
listDevices    → removable block devices: node, size, bus, partition scheme,
                 volumes, filesystem, cluster size, mount points, mountability
identify       {probe}            → device node carrying that probe file, or refusal
inspect        {device}           → scheme, fs, bytesPerSector, clusterSize, label,
                                    dirty flag, firmware-compatibility verdict
mount          {device}
unmount        {device}
eject          {device}           → unmount, then power down for safe removal
diagnose       {device}           → read-only fsck; findings, no writes
image          {device, dest}     → sector-level copy to a file, progress-reported
repair         {device, grant}    → fsck with repair
format         {device, allocationUnitBytes, label, grant}
                                  → MBR label, single exFAT partition, stated cluster size
```

`inspect` closes a real gap independent of everything else. Today the card's actual
cluster size is known only from `CARD_ALLOCATION_UNIT_BYTES` in `_a3em.dev`
([`device-info.ts:145`](packages/config-schema/src/device-info.ts#L145)) — which means
only after the card has been in a device. A blank card, or one from older firmware,
reports `unknown` and `recommendAllocationUnit` cannot judge it. The helper reads it from
the volume directly, so the Configure view can say "this card is 4 kB, you want 64 kB"
*before* the deployment rather than after it.

### N9. Refusals are in the host, not the UI

The host is the last line and must not rely on the page having asked sensibly. Hard
refusals, returning an error rather than a warning:

- Any device that is not removable, or is internal, or is the boot disk.
- Any device outside a plausible SD card capacity range.
- Any destructive call whose `grant` does not match an outstanding challenge (N10).
- `identify` matching zero or multiple devices.

An allowlist of what may be touched, not a blocklist of what may not.

### N10. Destructive operations take a challenge

`format` and `repair` are two-step. The page asks; the host returns a challenge carrying
its own description of the target — device node, capacity, bus, current label, current
filesystem — and a token expiring in ~60 seconds. The page shows *the host's* description,
not its own idea of the card, and the operator confirms. The page returns the token.

This closes the window where a card is swapped between the decision and the act, and it
means the text the operator confirms came from the process that will do the erasing.

Where the platform raises its own auth dialog (macOS admin prompt, Windows UAC), that is
a second, OS-level confirmation and should not be suppressed.

---

## Part 4 — Building and shipping the extension

### N11. Manifests

One extension, MV3, `"permissions": ["nativeMessaging"]`, plus the
`externally_connectable` block from N1. No content scripts, no host permissions.

One native host manifest format — Chrome's — since Firefox is out:

```json
{
  "name": "org.a3em.card_helper",
  "description": "A3EM card helper",
  "path": "/usr/local/lib/a3em/a3em-card-helper",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://<EXTENSION_ID>/"]
}
```

Placed per browser. Opera reads Chrome's locations, so the middle column covers it:

| | Chrome (and Opera) | Edge |
| --- | --- | --- |
| macOS | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` | `~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/` |
| Linux | `~/.config/google-chrome/NativeMessagingHosts/` | `~/.config/microsoft-edge/NativeMessagingHosts/` |
| Windows | `HKCU\Software\Google\Chrome\NativeMessagingHosts\org.a3em.card_helper` | `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\org.a3em.card_helper` |

Opera additionally honours `<OPERA_PROFILE_DIR>/NativeMessagingHosts`; the installer can
write there too as a belt-and-braces measure.

### N12. A stable extension ID

`allowed_origins` names the extension by ID, and an unpacked extension's ID derives from
its filesystem path — so it changes per machine, and the native manifest written by the
installer would be wrong everywhere.

Generate an RSA keypair once, put the public key in `manifest.json`'s `key` field, commit
it. The ID then derives from the key and is identical on every machine. If this goes to
the Chrome Web Store: `key` must be **absent** on first upload, then restored for every
upload after.

### N13. Distribution — what I was asking, and the answer

The question was: *how does the extension get onto each lab laptop?* A native messaging
host is just a binary an installer can drop anywhere, but an extension has to be
installed into the browser, and Chrome deliberately makes that hard for anything not from
the Web Store. Three routes exist:

| Route | How | Cost |
| --- | --- | --- |
| **Load unpacked** | Developer mode, "Load unpacked", point at a folder | Chrome nags to disable developer-mode extensions on every launch; manual per machine; no auto-update |
| **Self-hosted `.crx` + enterprise policy** | `ExtensionSettings` / `ExtensionInstallForcelist` pointing at our own update URL | **Does not work on unmanaged Macs** — see below |
| **Chrome Web Store, Unlisted** | Install by URL; not publicly listed or searchable | One review per update, hours to weeks, unpredictable |

**The policy route is out for macOS.** Google's documentation is explicit: on macOS,
extensions from outside the Web Store can only be force-installed if the machine is MDM-
managed, domain-joined via MCX, or enrolled in Chrome Enterprise Core. An ordinary lab
Mac is none of these, so writing the policy would simply not take effect.

**Recommendation: Chrome Web Store, Unlisted.** It works on unmanaged machines, on all
three browsers, auto-updates, and needs no developer-mode toggle. Unlisted means no
public listing and no search result — installation is by URL only.

**This has a real architectural consequence, and it is the reason to accept the review
latency: keep the extension thin.** Every millimetre of logic that lives in the extension
must clear a Web Store review to change. Every millimetre in the native host updates by
installer, instantly, with no review at all. So the extension should be a dumb pipe —
relay a message to the host, relay the answer back — and *all* device logic, platform
branching, refusals, and challenge handling belongs in the host. Done that way, the
extension is reviewed roughly once and then left alone, while the part that actually
churns stays free to change.

This also argues for N1's `externally_connectable` over the content-script bridge on
review grounds: no injected scripts and no host permissions is a markedly smaller ask
than "runs code on a page", and native-messaging extensions already attract scrutiny.

### N14. Installers

Three, each doing the same three things: place the host binary, write the native
manifests for every browser present, and be uninstallable.

- **macOS** — `.pkg` or shell installer. **The host binary needs Developer ID signing and
  notarization** — it is a downloaded executable, and Gatekeeper will block it otherwise.
  This is required regardless of the extension's distribution route.
- **Windows** — Inno Setup or MSI; registry keys above under HKCU.
- **Linux** — `.deb`/tarball plus an `install.sh`.

The installer should end by *self-testing*: spawn the host, exchange a ping, report which
browsers were wired up. A native messaging install that silently did not take is
otherwise indistinguishable from an extension bug.

---

## Part 5 — Recovering an unmountable card

Scoped per your answer: filesystem repair earns its place only when the card is so
corrupted it will not mount or read. That is a narrower feature than generic `fsck`, and
a **different** one — three consequences follow, and they reshape it.

### N15. Two different things are called "repair" — keep them apart

| | Filesystem repair (new) | Clip repair (exists) |
| --- | --- | --- |
| What is broken | FAT, bitmap, or directory structure | A single WAV header missing its length |
| Symptom | Card will not mount at all | Card mounts; one clip has no duration |
| Cause | Corruption, bad sectors, interrupted write | Power lost mid-clip |
| Handled by | Native host, `fsck_exfat` | [`transfer.ts`](app/src/lib/transfer.ts), already, in the copy |
| Card written? | Yes — in place | **No** — repaired into the copy |

The existing clip repair is not affected by any of this and must not be relabelled. The
UI should never offer one where the other is meant.

### N16. The entry path is different from everything else in the app

An unmountable card **cannot produce a `FileSystemDirectoryHandle`.** The File System
Access API needs a mounted volume. So for this flow, and only this flow:

- `useCard()` never reaches `ready`, and `card.contents` stays null.
- The nonce probe (N5) cannot run — there is no filesystem to write a probe into.
- The directory picker is useless: there is nothing for the operator to pick.

**The helper's own device list is the entry point.** The operator selects the card from a
list the host produced, not from an OS file dialog. This is the one screen in the app
driven by the device enumeration rather than by a handle, and it should be designed as
such rather than bolted onto the existing card UI.

It follows that this screen must be reachable *while no card is connected* as far as the
rest of the app is concerned — the existing `CardStatus` states
([`useCard.ts`](app/src/lib/useCard.ts): `unsupported | disconnected | reconnectable |
scanning | ready | error`) do not describe "a card is physically present and broken".
That is a new state, and the helper is the only thing that can report it.

### N17. Image before repairing

This is the part that matters most and the reason to build the feature carefully.

A card reaching this flow holds field data that cannot be recollected. `fsck_exfat -y`
rewrites the FAT and directory entries **in place**; where it guesses wrong, data that a
carving tool could have recovered becomes unrecoverable. Repairing first and thinking
second is how a lost deployment becomes a permanently lost deployment.

**So: take a sector-level image first, by default, and repair afterwards.** A 128 GB
image on a lab laptop is cheap; the alternative is not recoverable.

- `ddrescue` where available — it continues past bad sectors and keeps a map file, so a
  physically failing card yields everything still readable rather than stopping at the
  first error. This is the same principle as
  [`scanCard`](app/src/lib/card.ts) recording unreadable entries and carrying on, and the
  same one behind [`transfer.ts`](app/src/lib/transfer.ts)'s "continue past anything it
  cannot read".
- `dd conv=noerror,sync` as the fallback.
- Report progress over the message channel — not the bytes (N3).

The payoff is already documented in this repo: [`tools/check-card.mjs`](tools/check-card.mjs)
opens with instructions for attaching a card image read-only with
`hdiutil attach -readonly`, and notes exactly why read-only matters — "a damaged
filesystem is exactly the case where the OS may decide to 'helpfully' repair it." That
workflow exists; this gives it a card image to work on.

### N18. Diagnose read-only, then repair, then hand off

1. **Diagnose.** `fsck_exfat -q` for the clean/dirty verdict via exit status, then
   `fsck_exfat -n` for a full check that **opens the device read-only and writes
   nothing**. Report findings. Note `fsck_exfat` wants the raw character device
   (`/dev/rdiskNsM`), not the block device.
2. **Image** (N17).
3. **Repair.** `fsck_exfat -y`, behind the N10 challenge, on explicit confirmation.
4. **Hand off.** A repaired card mounts — and at that point *the entire existing app
   works on it*: Review, Listen, and Check & copy, including the clip repair in
   `transfer.ts`. Recovery is a gateway that returns the card to machinery that already
   exists, not a parallel universe.

Windows: `chkdsk /f`. Linux: `fsck.exfat -r` (exfatprogs). Both unverified (V3).

### N19. Where this stops

If the partition table itself is gone — `listDevices` shows the disk with no partitions —
`fsck` has nothing to operate on. Recovering that means signature-carving with `testdisk`
or `photorec`, which is a different tool, a different risk profile, and not something to
drive from a web page.

**The helper should say so plainly and stop**, with the card image from N17 in hand as
the thing to take to those tools. Reporting the limit accurately is worth more than an
attempt that might make things worse.

---

## Part 6 — Degradation

### N20. Nothing regresses when the helper is absent

The dashboard must remain fully usable with no extension, which is the state every
existing user is in. Detection: the page sends a `hello` on load and treats "no such
extension" as tier 2.

Three tiers, and the UI should name which one it is in — the same principle
[`CardStatus.tsx`](app/src/components/CardStatus.tsx) already applies to browser
capability, stated up front rather than discovered at the moment of need:

| Tier | State | Card management |
| --- | --- | --- |
| 1 | Chromium + helper | Everything |
| 2 | Chromium, no helper | Today's behaviour — `formatCommandFor()` prints a command to run by hand |
| 3 | Firefox / Safari | Download the config; card management by hand |

`formatCommandFor()` **stays**. It is the tier-2 path and the honest answer when the
helper refuses. Two changes: its default argument should become the real device node when
the helper is present, making the printed command correct and copy-pasteable for an
operator who would rather run it themselves — and **it must emit `-R`** (N6), which it
does not today and which makes the currently-printed command a silent no-op on any card
that is already exFAT.

---

## Part 7 — Phasing

Each phase is independently useful and independently shippable.

| | Phase | Delivers |
| --- | --- | --- |
| **P1** | Transport | Extension, host, `hello`/`listDevices`, installers, self-test. Proves the path on all three platforms before any card is at risk. |
| **P2** | Read-only | `inspect`, `identify`, nonce probe. Configure reports the card's real cluster size and partition scheme, and **flags GPT cards before they are destroyed**. No write path exists yet. |
| **P3** | Mount control | `mount`, `unmount`, `eject`. Low risk, immediately useful in batch preparation. |
| **P4** | Format | `format` with challenge-grant, MBR, chosen allocation unit, verified by re-reading the geometry. Handle invalidation and reconnect flow. |
| **P5** | Recovery | Device-list entry screen, `diagnose`, `image`, `repair`. Part 5 in full. |

**P2 is still the highest value per unit of risk** and should ship first regardless of
what happens to the rest. It writes nothing and it catches a failure mode that currently
destroys deployments silently.

**P5 can be built any time after P1** — it shares only the transport with P2–P4, since it
is driven by the device list rather than by a directory handle. If a corrupted card turns
up before P4 is done, it can jump the queue.

---

## Part 8 — Verification and open questions

- **V1. Does a physical SD card need elevation on macOS?** The `newfs_exfat` test passed
  only because a disk-image node is user-owned. Test against a real card: if `diskutil`
  paths work unprivileged and only `newfs_exfat` needs elevation, a `diskutil`-first
  design avoids the auth prompt for mount, eject and inspect entirely.
- **V2. Partition alignment — resolved, no action needed.** The 63-sector offset was an
  artifact of the 64 MB test image. On a 128 GB image `diskutil partitionDisk` places the
  partition at **2048 sectors (1 MiB)**, correctly aligned, and `newfs_exfat -R` preserves
  that offset. Verified end to end: partition at 1 MiB, 64 kB clusters, read back through
  `diskutil info -plist` as `VolumeAllocationBlockSize = 65536`.
- **V3. Windows and Linux paths are entirely unverified** — `Format-Volume` at 32 kB
  exFAT, driving it non-interactively from an elevated child, `chkdsk /f`, `mkfs.exfat -c`
  under `pkexec`, `fsck.exfat -r`. All documented, none run.
- **V5. Opera.** Whether the extension installs at all without the Chrome-extension
  add-on, and whether it finds a manifest in Chrome's directory in practice.
- **Q1. Where will the dashboard be hosted?** `externally_connectable.matches` must name
  the production origin explicitly, and changing it later means a new Web Store review
  (N1, N13). Worth settling before the first submission.
- **Q2. Confirm the Web Store Unlisted route** (N13), given the macOS policy finding — or
  say if these machines are in fact MDM-managed, which reopens self-hosting.
- **Q3. Scope of the follow-on in N7** — should native-side copy and integrity checking be
  planned now, given it changes nothing structurally but would justify more investment in
  the host?

---

## Sources

- [Native messaging — Chrome for Developers](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [`externally_connectable` — Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/manifest/externally-connectable) · [Match patterns](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns)
- [`externally_connectable` — MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/externally_connectable) (unsupported in Firefox) · [Firefox bug 1319168](https://bugzilla.mozilla.org/show_bug.cgi?id=1319168)
- [New permission prompt for Local Network Access — Chrome](https://developer.chrome.com/blog/local-network-access)
- [Manifest `key` — Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/manifest/key)
- [Prepare to publish: set up distribution — Chrome for Developers](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution)
- [Set Chrome app and extension policies (Mac) — Google](https://support.google.com/chrome/a/answer/7517624) — the MDM restriction on off-store extensions
- [Porting extension from Chrome: macOS native messaging — Opera forums](https://forums.opera.com/topic/15735/porting-extension-from-chrome-macos-native-messaging)
- [`Format-Volume` — Microsoft Learn](https://learn.microsoft.com/en-us/powershell/module/storage/format-volume?view=windowsserver2025-ps)
- [`mkfs.exfat(8)` — exfatprogs](https://man.archlinux.org/man/mkfs.exfat.8)
- `newfs_exfat(8)`, `fsck_exfat(8)`, `diskutil(8)` — local man pages, Darwin 25.6

---

## Part 9 — Implementation status

> Superseded by [Part 11](#part-11--the-go-helper-2026-09-23): the TypeScript host below was
> replaced by a Go one, and every platform is now implemented.

Built on 2026-09-14. `npm run ci` is green: 460 schema tests, 23 helper tests, app build.

### What exists

| Component | Path | State |
| --- | --- | --- |
| Firmware contract and verdicts | [`packages/config-schema/src/card-format.ts`](packages/config-schema/src/card-format.ts) | **Done**, 16 tests. Shared by app and helper |
| Native host, transport | [`packages/card-helper/src/protocol.ts`](packages/card-helper/src/protocol.ts) | **Done**, 8 tests including split-frame reassembly |
| Refusals | [`packages/card-helper/src/safety.ts`](packages/card-helper/src/safety.ts) | **Done** |
| Challenge / grant | [`packages/card-helper/src/challenge.ts`](packages/card-helper/src/challenge.ts) | **Done** |
| Command dispatch | [`packages/card-helper/src/dispatch.ts`](packages/card-helper/src/dispatch.ts) | **Done**, 15 tests against a fake platform |
| macOS platform | [`packages/card-helper/src/platform/darwin.ts`](packages/card-helper/src/platform/darwin.ts) | **Done**, exercised against disk images |
| Windows platform | [`packages/card-helper/src/platform/win32.ts`](packages/card-helper/src/platform/win32.ts) | **Stub** — every method names the command it needs |
| Linux platform | [`packages/card-helper/src/platform/linux.ts`](packages/card-helper/src/platform/linux.ts) | **Stub** — same |
| Extension | [`extension/`](extension) | **Done** — deliberately a dumb pipe |
| App client | [`app/src/lib/helper.ts`](app/src/lib/helper.ts), [`useHelper.ts`](app/src/lib/useHelper.ts) | **Done** — three-tier degradation |
| Installer + self-test | [`tools/install-card-helper.mjs`](tools/install-card-helper.mjs) | **Done** on macOS/Linux; Windows prints its `reg add` commands |

### What is left

- **UI.** No view has been wired to `useHelper` yet. The client and hook exist and are
  typed; what is missing is the Configure-view compatibility banner (P2), the device list
  and recovery screen (P5), and the format dialog (P4).
- **Windows and Linux platforms.** Nine methods each; see
  [`packages/card-helper/README.md`](packages/card-helper/README.md#porting).
- **Extension key and production origin.** Both are placeholders — see
  [`extension/README.md`](extension/README.md).

### Four things the implementation found that the plan did not

1. **`newfs_exfat` without `-R` exits 0 having done nothing.** Already recorded in N6, but
   it turned out `formatCommandFor()` — the command the app has been printing for users to
   type — omitted `-R`. **That command was a silent no-op on any card already formatted
   exFAT**, which is most of them. Fixed, with a test.
2. **`.filter(isEligible)` passes the array index as the second argument**, which landed in
   the new `allowVirtual` parameter and made it truthy for every device after the first —
   disabling the disk-image filter exactly where it mattered. Caught by TypeScript because
   the parameter was typed; it would have been invisible in plain JS.
3. **Disk images are indistinguishable from cards on every field that matters.** A laptop
   with Xcode lists one simulator image per runtime — removable, external, card-sized.
   Without a `virtual` flag the device list was 16 entries of noise on this machine, every
   one of them formattable. Hidden by default, `A3EM_HELPER_ALLOW_VIRTUAL=1` to include.
4. **A container partition is not a damaged filesystem.** APFS, LVM, and EFI partitions
   have no filesystem type, which the first cut reported as "unmountable — this card is
   damaged". That would send an operator into the recovery flow for a healthy disk.

### Partition alignment, settled

The V2 concern is closed and needs no work. On a 128 GB volume the full flow produces:

```
Partition offset : 2048 sectors (1048576 bytes)     ← 1 MiB, correctly aligned
Bytes per sector : 512
Bytes per cluster: 65536
```

and reads back through `diskutil info -plist` as `VolumeAllocationBlockSize = 65536`. The
63-sector offset seen earlier was an artifact of a 64 MB test image using legacy CHS
geometry. `newfs_exfat -R` preserves the partition offset, so the two-step format does not
disturb the alignment `partitionDisk` established.

Worth noting for the allocation-unit model: **macOS defaults a 128 GB exFAT volume to 128 kB
clusters**, which is two to four times larger than `recommendAllocationUnit` typically
picks. The "wasteful" verdict is the common real-world case, not an edge case.

---

## Part 10 — Review findings, 2026-09-14

Six questions asked of the implementation. Four found real defects.

### R1. The no-extension fallback is structural, and now guarded

Confirmed: nothing in the card path (`card.ts`, `useCard.ts`, `transfer.ts`,
`CardStatus.tsx`, and three others) imports anything from the helper. There is no code
path where an absent helper can affect reading or writing a card, so the fallback is a
property of the architecture rather than of care.

Because that is exactly the kind of property that decays silently — one convenient import
and it is gone, with no test failing until someone without the extension opens the app —
[`tools/check-helper-isolation.mjs`](tools/check-helper-isolation.mjs) now enforces it in
`npm run ci`.

### R2. `chrome.runtime` was being used to detect the wrong thing — **fixed**

`HELPER_TRANSPORT_AVAILABLE` tested for `chrome.runtime` and reported its absence as "this
browser is unsupported". **Since Chrome 106 that object is undefined on a page unless a
matching extension is installed**, so on ordinary Chrome with no extension the app would
have said the browser could not use the helper — and hidden the installer at precisely the
moment it should be offered.

Split into `isChromium()` (via `navigator.userAgentData.brands`, which exists only in
Chromium) and `extensionPresent()`. The status enum gains a fourth state so the four cases
stay distinct: `unsupported` / `absent` / `incomplete` / `ready`.

### R3. Long operations would have timed out mid-work — **fixed**, twice over

Two independent defects:

1. **A 30-second total deadline on every call.** Imaging a 128 GB card runs for half an
   hour. The client would have abandoned the request while the host carried on formatting.
   Replaced with an **inactivity deadline**: the host heartbeats every two seconds, and the
   client gives up only on silence. A long operation that keeps reporting is healthy; no
   fixed total can tell that from a dead helper.
2. **Progress could not have been delivered at all.** The first cut pushed heartbeats with
   `chrome.runtime.sendMessage` from the service worker — but **an extension cannot push a
   message to a web page**. A page has `sendMessage` and `connect`; it has no `onMessage`.
   Long operations now run over a port the *page* opens, which is the only channel that
   works in that direction.

`format`, `repair`, and `diagnose` also emitted nothing at all, since none of them has
measurable progress. They now heartbeat with a phrase and elapsed time, because a page
that cannot distinguish "working" from "hung" gets reloaded halfway through a format by
someone assuming the worst. `HelperStatus` shows the running task in the header, held in
`App` so it survives switching sections, with a `beforeunload` guard — the same pattern
[`useOffloadTask`](app/src/lib/useOffloadTask.ts) already uses, for a sharper reason: an
interrupted copy leaves a partial folder, an interrupted format leaves a card that mounts
nowhere.

### R4. The production origin now has one home and a CI gate

[`deployment.json`](deployment.json) is the only place it is written by hand.
[`tools/sync-extension-manifest.mjs`](tools/sync-extension-manifest.mjs) writes it into the
extension manifest; `--check` runs in `npm run ci` and fails both on drift and on the
placeholder still being present. Same arrangement as the firmware and planner snapshots.

**`npm run ci` fails today**, deliberately, until `dashboardOrigin` is set. That is the
accurate state: the extension genuinely cannot reach the dashboard in production until it
is, and `externally_connectable` is fixed at build time, so discovering it after
publication costs another Chrome Web Store review.

**localhost always works.** `http://localhost/*` and `http://127.0.0.1/*` are unconditional
and not configurable, and match patterns ignore ports, so the Vite dev server is covered
permanently. The exposure this carries — any page served from the machine can reach the
extension — is noted in `deployment.json`, along with why it is acceptable: running a local
server already implies code execution there, and every destructive operation still requires
a native confirmation the page cannot fake.

### R5. Formatting does specify the allocation unit — with a fix worth having

To correct a misreading: nothing forces a wasteful cluster size. `newfs_exfat -R -b <size>`
sets exactly what is asked for, verified at 65536 and read back through `diskutil`. The
128 kB figure was macOS's default **for cards formatted by other tools**, i.e. what
`inspect` finds on arrival — which is why "wasteful" is the common verdict on a card
someone formatted in Disk Utility.

The review did surface a real inefficiency behind that. `format()` ran `partitionDisk` with
a volume name, which makes macOS lay down a filesystem at *its* default cluster size, and
then reformatted at the requested one — **formatting the card twice**, the first time
wastefully. Passing `%noformat%` in the volume-name slot writes the partition table and
stops. Verified that the partition type code and the 1 MiB alignment are identical either
way.

### R6. Extension key generated

A 2048-bit RSA keypair was generated and the public half committed to `deployment.json`,
which pins the extension ID to `felbcgjkphldokgcjildnmnclokfngnh` on every machine. The
private key is at `extension/a3em-extension-key.pem` and is **gitignored** — back it up
somewhere durable; it is only needed for self-packaging a `.crx`, since the Web Store
holds its own signing key.

Remember that `key` must be **absent** from the manifest on the first Web Store upload and
restored for every upload after.

---

## Part 11 — Interface changes, 2026-09-14

Both raised against the first cut; both were right, and one turned out to be hiding a
typography bug.

### U1. Card tools moved to the rail foot

"Enable card tools" was a full-size `.btn` in the top bar beside Rescan and Disconnect,
where an optional feature competed with the controls people came to press.

The component was doing two unrelated jobs because both came from one hook. Split:

- **`HelperRailStatus`** — the ambient capability, in the rail foot beneath the firmware
  version, as a `CARD TOOLS / Enable…` pair with the action rendered as chrome-weight text
  rather than a button.
- **`HelperTaskChip`** — a running format, repair, or image, which stays in the top bar
  because it *is* time-critical and that is where someone looks to find out what the app is
  doing to their card right now.

### U2. The firmware version is labelled

It rendered as a bare `fw 1.4.2`, which says neither whose firmware nor where the number
came from. Now `DEVICE FIRMWARE / 1.4.2`, with a tooltip noting it is read from `_a3em.dev`
— so it is the firmware of the device that last wrote this card, not of anything attached
now. Absent reads `no card connected` rather than `no device connected`, which is the
accurate statement.

The first attempt laid these out label-left/value-right and looked worse than what it
replaced: the rail is about 180 px wide, so both halves wrapped and interleaved. Stacked
now, echoing the `stat-label`/`stat-value` pairing the forecast panel already uses.

### U3. The protocol library collapses itself

Five cards with descriptions and buttons, held open above the settings for the whole
session, is most of a screen spent on a decision made once in the first ten seconds.

A plain collapsible would have fixed the size and left the user managing it every session.
Instead the open state follows the workflow: **open when nothing has been chosen**, which
is the "first thing used rather than a filing cabinet visited afterwards" case the feature
exists for, and **collapsed the moment a choice is made**, to a summary line carrying the
provenance and the drift warning. The common path costs no clicks at all.

Collapsing loses nothing, because the summary absorbs what the `basedOn` banner was already
saying lower down. Applying is watched via the provenance rather than only the button, so
restoring a saved draft or loading a configuration found on a card collapses it too.

### U4. Three defects found by looking at it

Screenshots, not inspection, caught these:

1. **The install dialog rendered entirely in spaced-out monospace.** A `<dialog>` renders
   in the top layer but still inherits from its DOM parent — and this one is rendered from
   inside `.rail-foot`, which is 10 px monospace with wide letter spacing. Typography is now
   reset on `.modal`.
2. **The install command was cut off** by `overflow-x: auto`, hiding the end — which is
   where the arguments are. Wrapped instead; a wrapped command pastes identically.
3. **The command said `--extension-id <id>`**, making the reader go and find their own.
   Since R6 pinned the ID by key, it is the same everywhere — the real one is now in the
   command, copy-pasteable as written.

The dialog also became a native `<dialog>` rather than a div with `role="dialog"`, which
brings focus trapping, Escape, page inertness, and `::backdrop` from the platform. Escape
is verified closing it.

**Incidentally confirmed**: headless Chromium with no extension installed renders
`CARD TOOLS / Enable…`, not "unsupported browser" — the R2 tier fix behaving correctly in a
real browser rather than only in the type system.


## Part 11 — The Go helper, 2026-09-23

The TypeScript host is gone. Its replacement, [`card-helper`](card-helper), is one Go
executable per platform with no runtime to install, and implements macOS, Windows and Linux
alike. What changed from the plan, and why:

- **N7 (Node, reusing the schema) is reversed.** A helper that needs Node.js installed first is
  not something a field team installs. The schema's rules stay in the schema: the helper
  reports facts and the dashboard judges them (`judgeCardFormat`, and the new
  `judgeReadiness`). The one rule the helper must enforce itself, the format request, is
  mirrored in Go and checked against the TypeScript by a golden test.
- **The formatter writes the image itself.** `newfs_exfat`, `mkfs.exfat` and `Format-Volume`
  each choose their own offsets and alignment. The helper builds the reference layout byte for
  byte — a port of the Python formatter `exfat_image.py` (since retired), tested against its
  recorded output — and writes it raw.
- **Grants are signed, not remembered.** Chrome starts a new host process for every message and
  every port, so a challenge issued by one process was always redeemed by another, and the
  in-memory store could never have worked. Grants now carry their own terms under a per-user
  HMAC key, and a ledger makes each single-use.
- **Raw access goes through an elevated worker** — this executable again, started with
  `osascript`, `pkexec` or a UAC prompt — which re-lists devices with its own privileges and
  refuses any whose fingerprint differs from the confirmed one. A batch is one job and one prompt.
- **New:** the capacity probe for counterfeit cards, the write-latency test, byte-for-byte
  layout verification, write-protect detection, the card's CID where the reader exposes it,
  and a one-step readiness check. The probe and latency results are remembered per format of
  a card, since both are destructive and can only run while preparing it.
- **A bug the port found:** a card in a Mac's built-in SD slot reports `Internal: true` — the
  reader is internal — so the old eligibility rule hid exactly the card it was built for. The
  medium's own flag is `OSInternalMedia`. Separately, an external SSD is `Ejectable` and
  `RemovableMediaOrExternalDevice` but not `Removable`; only the latter describes a card.

Tested: unit tests on all three platforms, and an integration test per platform that prepares
a virtual disk (hdiutil image, loop device, VHD) and checks it with the system's own tools — in
CI on GitHub's runners. The dashboard's panel was driven end to end in Chrome against the real
helper and two disk images. **No real card has been formatted yet.** Installers: signed and
notarized `.pkg`, per-user Inno Setup installer signed through SignPath, `.deb` and tarball,
built by the release workflow; see the helper's README for the credentials it needs.
