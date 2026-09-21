# @a3em/card-helper

Native messaging host for SD card management: enumerate, inspect, mount, format at a
chosen allocation unit, image, and repair.

**macOS is implemented. Windows and Linux are stubs.** See [Porting](#porting) — filling
one in is a matter of implementing nine methods, and everything else already works.

The design and the reasoning behind it are in
[`../../NATIVE-HELPER-PLAN.md`](../../NATIVE-HELPER-PLAN.md). This file is how to build,
install, and extend it.

```bash
npm --workspace @a3em/card-helper run build
npm --workspace @a3em/card-helper test          # 23 tests, no disk required
npm run install-helper -- --extension-id <id>   # register with every Chromium browser
npm run helper-doctor                           # verify an install actually works
```

## What it is for

The dashboard already computes the allocation unit a deployment should use
([`allocation-unit.ts`](../config-schema/src/allocation-unit.ts)) and then prints a
command for someone to type, because the File System Access API never tells a web page
which disk a folder is on. This closes that gap.

It also catches something no other tool on the operator's machine will. The firmware's
FatFs is built with `FF_LBA64 = 0`, which compiles out GPT support entirely — so a
GPT-partitioned card reads as *no filesystem*, and `storage_init()` responds to that by
calling `f_mkfs`. **A GPT card is silently erased on insertion**, and Finder shows it as
perfectly healthy right up until that happens. `judgeCardFormat` in
[`card-format.ts`](../config-schema/src/card-format.ts) reports it before the card ever
reaches a device.

## Architecture

```
dashboard page ──externally_connectable──▶ extension service worker ──stdio──▶ this
```

Three layers, and the split matters:

| Layer | Where | Changes require |
| --- | --- | --- |
| Extension | [`../../extension`](../../extension) | A Chrome Web Store review |
| Host | here | An installer run |
| Firmware contract | [`card-format.ts`](../config-schema/src/card-format.ts) | Nothing — shared with the app |

The extension is deliberately a dumb pipe for exactly this reason: anything in it is
expensive to change, so all the logic lives here.

## Safety model

Four independent layers, each of which must pass:

1. **The browser** gates which origins may reach the extension, via
   `externally_connectable.matches`.
2. **The host manifest** gates which extension may reach this process, via
   `allowed_origins`.
3. **[`safety.ts`](src/safety.ts)** allowlists what may be touched: removable, external,
   not the boot disk, not a disk image, and within a plausible card capacity. Ineligible
   devices are not merely refused — they never appear in a listing.
4. **[`challenge.ts`](src/challenge.ts)** requires a two-step confirmation for anything
   destructive, against the *host's own* description of the target, with the device
   fingerprinted at issue time so a card swapped mid-decision invalidates the grant.

None of it lives in a platform file. That is what makes the rules testable on one
operating system and identical on three.

### Disk images are hidden by default

A developer machine lists one simulator image per installed Xcode runtime — each
removable, external, and card-sized. Set `A3EM_HELPER_ALLOW_VIRTUAL=1` to include them,
which is how this is tested without risking a real card.

## Porting

Everything above [`Platform`](src/platform/types.ts) is platform-independent and already
tested. Implementing an OS means producing four shapes — `RawDevice`, `CardGeometry`,
`FsckReport`, `ImageReport` — from that OS's tools. Nothing else.

1. Open [`src/platform/win32.ts`](src/platform/win32.ts) or
   [`src/platform/linux.ts`](src/platform/linux.ts). Every method throws
   `NotImplementedOnPlatform` carrying the command it is meant to run, so the file is
   already a specification.
2. Implement against [`darwin.ts`](src/platform/darwin.ts) as the worked example.
3. Add the operation names to `implementedOperations` in
   [`src/platform/index.ts`](src/platform/index.ts) as they land. Partial support is a
   supported state: the handshake reports it, and the UI degrades per operation.
4. `npm --workspace @a3em/card-helper test` — the 23 existing tests run against a fake
   platform and cover every refusal your implementation inherits. You should not need to
   write new ones for those rules.

**Do not put policy in a platform file.** Whether an operation is permitted is decided in
`safety.ts` before your code is called. A platform that refuses on its own makes that
rule untestable everywhere else.

### Three traps macOS taught us, worth checking for on every platform

1. **Verify the result; never trust the exit code.** `newfs_exfat` without `-R` declines
   to reformat an existing volume whose cluster size differs — printing a message and
   **exiting 0**. `verifyGeometry` re-reads the geometry and fails if it is not what was
   asked for. Whatever tool you use, do the same.
2. **A cluster size is not an I/O size.** `statfs` on macOS reports 1 MiB for exFAT.
   Use the API that reports the allocation unit specifically.
3. **A partition type code is not a filesystem.** exFAT and NTFS share MBR type `0x07`,
   so macOS reports `Windows_NTFS` for a healthy exFAT card. Read the filesystem from the
   volume, not the partition table.

### A fourth, for the recovery path

A partition that holds a container rather than a filesystem (APFS, LVM, EFI) has no
filesystem type, which reads as "damaged" unless you allow for it — see
`NON_FILESYSTEM_CONTENTS` in `darwin.ts`. Reporting a healthy disk as a damaged card
sends an operator into the recovery flow for nothing.

## Testing without a card

```bash
# macOS: a sparse image behaves like a card for everything except device-node ownership
dd if=/dev/zero of=/tmp/card.img bs=1 count=0 seek=128g
hdiutil attach -nomount -imagekey diskimage-class=CRawDiskImage /tmp/card.img
A3EM_HELPER_ALLOW_VIRTUAL=1 node -e "…"
hdiutil detach /dev/diskN && rm /tmp/card.img
```

**One thing a disk image cannot test.** `hdiutil` creates device nodes owned by the
attaching user, whereas a physical card's node is `root:operator`. So tools that open the
node directly — `newfs_exfat`, `fsck_exfat` — succeed unelevated against an image and
probably will not against a card. `runMaybeElevated` tries unelevated first and escalates
on a permission error, which is correct either way, but the actual requirement is
unverified. See `ELEVATION_UNRESOLVED` in `darwin.ts`.

## Protocol

Chrome's native messaging framing: a 32-bit native-order length, then UTF-8 JSON.
**Host → extension is capped at 1 MB**, which is why this returns verdicts and progress
rather than payloads. Audio and file data go through the File System Access API, which
has no such limit, and must never be routed through here.

`stdout` is the wire. Diagnostics go to `stderr`, which Chrome captures into the
extension's console — a `console.log` in this process is a protocol bug.
