# End-to-end tests: the dashboard's A3EM Card Helper screens against the real helper

`e2e.mjs` serves the built dashboard, stands in for the browser extension, and drives headless
Chrome through the card screens. Every request the page makes goes to the **real** helper program,
started as a browser starts it and spoken to in native messaging's framing — one helper for the
whole run, so a Stop reaches the copy it stops — in test mode (`A3EM_HELPER_VIRTUAL_ONLY=1` hides
every real device), and only the virtual disks named in `cards.json` are listed. The harness also
sets `A3EM_HELPER_TEST_NEEDS_ADMIN=1`, so the helper treats each disk's raw device as needing
administrator access to read, as a real card's does: a disk image the user can read directly
otherwise hides every path where a quick check skips the layout. So these tests
exercise the helper's platform code and the dashboard together, on disks that cannot be anyone's
card.

What is **not** covered: the extension itself and Chrome's own native messaging (the stand-in
replaces both), and the folder picker (a stand-in "picks" the prepared card). Real card readers,
administrator prompts and privacy permissions need a real card and a person.

## Scenarios

| Scenario | Checks |
| --- | --- |
| `configure` | With the A3EM Card Helper, the forecast's "Recommended card format" sends formatting to "Prepare devices" instead of listing commands, and the link opens it. |
| `recover` | Recover card lists only the cards that do not open. The damaged one: opening it fails and says so; a copy to an image is stopped partway, says so and leaves no file; it is copied (saying where, and how much room there is); the check finds the damaged boot region and that its backup can replace it; the repair is confirmed in the helper's words as the narrow one, restores the boot region, and the card opens and stays listed as "Opens now". |
| `prepare` | Prepare devices, with the old card open in the dashboard: the cards pane follows the batch; without a batch "Prepare this card" cannot be pressed and says why; in a batch, a card beyond the units has "No unit left"; preparing all without a check checks first, in the same log; only the old card is confirmed for erasing; the prepared card only gets its settings; both units end "Card written"; the old card, erased, is let go of — the header says why, and Review card shows no card rather than what it held. |
| `review` | Review card, for the dirty card, picked in the folder picker: "The card itself" comes first; no repair is offered until a check finds the problem, explains it, and names the recording it touches, and finds the log lines past the log's recorded end, for the copy — and so says to copy before repairing; a copy is stopped and leaves no file; the image copy is still showing after a visit to another tab; the repair is the helper's own, rebuilds the bitmap and says where it saved what it replaced, and the card is open again; no marker file is left. |
| `prepare-open` | First, on Prepare devices, a batch of one, and "Prepare this card" pressed on the prepared card unchecked: it gets its settings, and its result shows the layout the check read on the way. Then Configure, with the card open: it warns that the batch has a card written with these settings, and once a setting changes, that the card now differs. "Prepare OWL_01…" replaces writing the configuration alone; with only other settings on the card, it writes this unit's and erases nothing; once a file from before is on the card (put there through the harness), it asks to confirm erasing in the helper's words, erases and sets the card up again, keeps what it did on screen, and lets go of the folder that was open on it. Back on Prepare devices, the unit written before the change is "No card yet" again, saying why, until its card, now with the current settings, is checked and counts as its card. |
| `match` | Connect SD card is matched to its card: the header offers Eject, no marker file is left behind, Review card shows the card itself and what this computer found preparing it, its filesystem check is clean, Review card, Listen and Check & copy each say the card is not deployed yet, and Eject leaves "Reopen". Needs the harness to be able to write to the prepared card's mount point. |

Run in the order `configure,recover,prepare,review,prepare-open,match` (the default): `prepare-open` erases the prepared card and sets it up again, and `match` ejects it.

The harness answers the helper's save dialog itself, through `A3EM_HELPER_SAVE_AS_DIR` (cards.json's
`imageDir`), so no dialog opens. The real dialogs — AppleScript's, the Linux desktop portal's (or zenity or kdialog), Windows Forms —
need a person to see them.

## The cards

A setup script creates five virtual disks and writes `cards.json`:

| Role | What it is |
| --- | --- |
| `old` | exFAT made by the operating system, with a file on it. Preparing must erase it. |
| `prepared` | Prepared by the helper as `OWL_01`, at 4 kB clusters (what the default configuration recommends for a 1 GB card), and mounted. It needs at most its settings. |
| `damaged` | Prepared by the helper as `OWL_07`, with files, then sector 11 of its boot region — the boot checksum, at sector 4107 of the disk — zeroed. The system will not mount it; fsck can repair it. |
| `blank` | No partitions. |
| `dirty` | Prepared by the helper as `OWL_09`, with a recording, and a log whose directory entry records 2,000 of its 3,120 bytes (`shorten.py`), as a recorder that lost power before syncing leaves one; then 80 of the recording's clusters marked free in its allocation bitmap. It opens normally; the check finds the bitmap wrong, and the helper's own repair fixes it — what a card pulled while the recorder was writing looks like. On macOS the card carries `.fseventsd/no_log` and `.metadata_never_index`: otherwise macOS, mounting it, writes its own files into the space marked free — onto the recording — and the card is then cross-linked, which only the system's repair can deal with. (That is also why a wrong bitmap matters.) |

```json
{ "old": "<device id>", "prepared": "<id>", "damaged": "<id>", "blank": "<id>", "dirty": "<id>",
  "preparedLabel": "OWL_01", "preparedMount": "<where the prepared card is mounted>",
  "dirtyLabel": "OWL_09", "dirtyMount": "<where the dirty card is mounted>",
  "oldLabel": "OLDCARD", "oldMount": "<where the old card is mounted>",
  "stateDir": "<the helper state folder the setup used>", "imageDir": "<where images go>",
  "localImageDir": "<imageDir as the harness sees it, where the helper runs elsewhere>" }
```

`localImageDir` is optional: without it, the harness looks for a stopped copy's leftovers in
`imageDir`, which is right unless the helper runs in a container.

Device ids are the helper's own (`listDevices`): `disk19` on macOS, `loop1` on Linux. The setup
scripts are `setup-macos.sh` and `setup-linux.sh`.

## Running

```sh
# macOS
go build -o /tmp/a3em-card-helper ./cmd/a3em-card-helper          # in Web/card-helper
npm --workspace app run build                                       # in Web
test/e2e/setup-macos.sh /tmp/a3em-card-helper /tmp/a3em-cards
node test/e2e/e2e.mjs --helper /tmp/a3em-card-helper --cards /tmp/a3em-cards/cards.json
test/e2e/setup-macos.sh teardown /tmp/a3em-cards

# Linux (root, for the loop devices)
sudo test/e2e/setup-linux.sh /tmp/a3em-card-helper /tmp/a3em-cards
sudo node test/e2e/e2e.mjs --helper /tmp/a3em-card-helper --cards /tmp/a3em-cards/cards.json
sudo test/e2e/setup-linux.sh teardown /tmp/a3em-cards
```

Options: `--only recover,prepare`, `--out <folder>` for results and screenshots (default
`./e2e-results`), `--app <built dashboard>`, `--chrome <path>` (or `CHROME=`). Needs Node 22 or
later and Chrome. Exit status is non-zero if any expectation failed; each is printed with what was
seen, and every helper call is listed with its outcome.

The helper can also run elsewhere than the harness — in a container, say — by giving `--helper` a
script that runs it there (for example `docker exec -i -e A3EM_HELPER_VIRTUAL_ONLY -e
A3EM_HELPER_TEST_NEEDS_ADMIN -e A3EM_HELPER_STATE_DIR -e A3EM_HELPER_SAVE_AS_DIR <container>
/work/a3em-card-helper "$@"`), with
`cards.json`'s paths as the helper sees them, and `localImageDir` set to the image folder as the
harness sees it. `review` and `match` then cannot write their marker file, so run
`--only configure,recover,prepare`.

## Platforms

- **macOS** (26, Apple silicon): all six scenarios.
- **Linux** (an Ubuntu 24.04 container on Docker Desktop, exfatprogs 1.2.2, with the helper in the
  container): `configure`, `recover` and `prepare`, which are the scenarios that do not write to a
  card's mount point from the harness.
