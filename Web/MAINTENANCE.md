# Keeping the web app in step with firmware and the power model

Two things outside this repo define how the web app must behave: the **firmware
source** and the **deployment planner spreadsheet**. Both change over time, and
hand-transcribed copies of them rot silently — the dashboard keeps writing cards the
device reads differently than intended, and nobody finds out until a field season is
gone.

So neither is transcribed by hand and left to drift. Each is reduced to a **diffable
JSON snapshot**, and tests assert the TypeScript still agrees with the snapshot.

```
   a3em-firmware/src/**.c,h  ──┐
                               ├─► extract_*.py ─► reference/*-snapshot.json ─► tests
   reference/A3EM Deployment  ──┘                        (in git, readable)      │
   Planner.xlsx                                                                  │
                                                                                 ▼
                                          packages/config-schema/src/*.ts  (hand-written)
```

You never edit the snapshots. You edit the source, regenerate, and the tests tell you
exactly what needs changing in TypeScript.

---

## Where things go

| What | Where | Who edits it |
| --- | --- | --- |
| Firmware checkout | `../a3em-firmware` — a sibling of `a3em-dashboard` | firmware team, in its own repo |
| Planner spreadsheet | `Web/reference/A3EM Deployment Planner.xlsx` | you, in place |
| Generated snapshots | `Web/reference/*-snapshot.json` | nobody — generated, committed |
| Firmware constants | `packages/config-schema/src/firmware-constants.ts` | you, guided by test failures |
| Power measurements | `packages/config-schema/src/power/measurements.ts` | you, guided by test failures |

**The spreadsheet lives in this repo.** That is the answer to "where should the
spreadsheet be placed": `Web/reference/A3EM Deployment Planner.xlsx`. It is versioned
alongside the code that depends on it, so a checkout of any commit contains the exact
spreadsheet that commit's model was derived from. A copy of the current revision is
already there.

**The firmware stays in its own repo.** It is not vendored here. The default expected
location is `../a3em-firmware` relative to `a3em-dashboard`, which is how your working
tree is already laid out, so the tools find it with no configuration. Override with
`--firmware PATH` or `A3EM_FIRMWARE_PATH` if yours differs.

---

## Updating the power model

You are **not** expected to hand-edit the TypeScript from scratch, and the web app is
**not** silently recomputed from the spreadsheet at build time. The loop is:

1. **Update the spreadsheet in place** at `Web/reference/A3EM Deployment Planner.xlsx`.
   Add the measurement, fix a formula, whatever — work the way you already work.

2. **Regenerate the snapshot.**
   ```bash
   cd Web/packages/config-schema
   npm run sync:planner
   ```
   `git diff Web/reference/planner-snapshot.json` now shows, in plain text, every
   number that moved. This is the main thing the snapshot buys you: an .xlsx diff is
   unreadable, a JSON diff is not.

3. **Run the tests.**
   ```bash
   npm test
   ```
   Failures come in two flavours, and they mean different things:

   - **`measurements.ts agrees with the planner spreadsheet`** fails → a *constant*
     changed. Copy the new value into `power/measurements.ts` and update its
     `confidence` tag if it was promoted from `estimated` to `measured`. That is the
     whole edit.

   - **`recordingCurrentMa` / `storage and battery life`** fails → the spreadsheet's
     *computed outputs* changed. Those tests read their expectations from the
     snapshot, so if they fail after step 1 it means a **formula** changed, not just
     an input, and `power/forecast.ts` needs the same change. This is the case that
     needs real attention.

4. **Commit the spreadsheet, the snapshot, and the TypeScript together.**

The only file that holds power constants is `power/measurements.ts` — one entry per
spreadsheet cell, each carrying its cell reference and a confidence tag. The arithmetic
in `forecast.ts` reads everything from it and never hardcodes a number.

### If you would rather I did the update

Point me at the new spreadsheet and I will run the loop and report what changed. The
tooling exists so that either of us can do it and get the same result.

### What the spreadsheet does not cover

The sheet models **continuous recording only**. Duty cycles, LEDs, and the VHF beacon
are extensions in `forecast.ts`, and their constants sit in a clearly marked
`EXTRAPOLATED` block at the bottom of `measurements.ts`. If you add a sheet for the
armed-but-idle state, tell me and I will extend the extractor to pull it in rather than
leaving those as placeholders.

---

## Updating for a firmware change

Same shape, one extra consideration: some firmware changes alter *behavior* rather
than a constant, and those need a **capability profile** rather than an edit in place —
because a card written for new firmware may still end up in an old device.

1. **Pull the firmware.** No copying into this repo.

2. **Regenerate the snapshot.**
   ```bash
   cd Web/packages/config-schema
   npm run sync:firmware
   ```
   `git diff Web/reference/firmware-snapshot.json` shows what moved. The snapshot
   tracks:
   - every numeric and string `#define` the app depends on
   - the four config enums, **including member order**
   - **every config key `parse_line()` handles, in the order it tests them** — this is
     the highest-value one, since matching is by prefix and order is load-bearing
   - the `MAX_FREQUENCY` clamp headroom
   - the digipot resolution that quantizes the audio trigger
   - the field labels in the periodic device-details log block

3. **Run the tests** and follow the failures. Each names a constant.

4. **If a limit changed**, edit `firmware-constants.ts` and bump
   `CONFIG_SCHEMA_VERSION`.

5. **If a config key was added, removed, or reordered**, update `KEY_ORDER` in
   `parse.ts`. Two tests guard this: one asserts the shared keys stay in the firmware's
   own order, and one asserts no key is a prefix of a later key — which would make the
   firmware match the wrong branch.

6. **If a behavior changed**, add a profile in `firmware-profile.ts` instead of
   changing the default. See below.

### Why behavior changes need a profile, not an edit

The clip-cap fix is the worked example. `AUDIO_MAX_CLIPS_NUMBER = 0` currently means
"never arm the trigger"; from 2026.08 it means "unlimited". Those are opposite
outcomes, and both kinds of device will be in the field simultaneously.

So `firmware-profile.ts` carries one entry per release with a flag per corrected
behavior. `validateConfig()` and `forecast()` both take a profile and **default to the
legacy one** — assuming a device lacks the fixes is the safe direction to be wrong in.
Each device record in the app stores its firmware version, and the editor resolves the
profile from that.

To add a release: append a profile, set only the flags that release actually fixes,
leave older profiles untouched.

---

## Continuous integration

```bash
cd Web
npm run ci     # manifest check, helper isolation, lint, schema ci, helper tests, app build
```

### Lint

`npm run lint` runs ESLint over the workspace, configured in `Web/eslint.config.js`. It is
a bug-catching pass, not a style guide: nothing in it reformats code or has an opinion
about naming, because a check that reports spacing is one people learn to ignore.

The rule that earns its place is `react-hooks/rules-of-hooks`. A `useMemo` placed below a
component's early return once ran only on some renders, so finishing a card scan changed
the hook count mid-life and React unmounted the Review card page to a blank screen —
no type error, no failing test, and a reproduction that depended on which tab you started
the scan from. ESLint reports it on the line that causes it.

`react-hooks/exhaustive-deps` is a warning rather than an error, because an incomplete
dependency array is sometimes the intent. Where it is, say so with a disable comment
giving the reason; there is one in `CardOverview.tsx` to copy the shape from.

```bash
cd Web/packages/config-schema
npm run ci     # sync:check, then build + test
```

`sync:check` regenerates both snapshots in memory and fails if either differs from
what is committed. That catches the specific failure mode where someone updates the
spreadsheet or pulls new firmware and forgets to regenerate — CI fails with a message
naming the command to run.

CI needs the firmware checkout present. On a runner, set `A3EM_FIRMWARE_PATH` after
checking out `a3em-firmware` alongside this repo. If the firmware is not available in a
given CI context, run `npm test` alone: the snapshot-comparison tests still work,
because the snapshots are committed. You lose only the "is the snapshot current?"
check, which the firmware repo's own CI could equally own.

---

## Quick reference

```bash
cd Web/packages/config-schema

npm run sync            # regenerate both snapshots from firmware + spreadsheet
npm run sync:firmware   # firmware only
npm run sync:planner    # spreadsheet only
npm run sync:check      # fail if either snapshot is stale (CI)
npm test                # build + run everything
npm run ci              # sync:check then test

# non-standard locations
python3 ../../tools/extract_firmware_constants.py --firmware ~/src/a3em-firmware
python3 ../../tools/extract_power_measurements.py --xlsx ~/Downloads/planner-v3.xlsx
```

Both tools are stdlib-only Python 3 — no install step, nothing to keep upgraded.
