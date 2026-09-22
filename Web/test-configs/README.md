# Hardware validation: pre-flight checks, then a seven-day soak

Configurations that between them exercise as much of the firmware as a **digital**
microphone allows. Run the short ones first — they take about ninety minutes together and
catch the mistakes that would otherwise waste a week.

Generate them immediately before use:

```bash
node tools/make-test-config.mjs wd    --tz America/New_York
node tools/make-test-config.mjs quick --tz America/New_York --card 128 --battery 2400
node tools/make-test-config.mjs soak  --tz America/New_York --card 128 --battery 2400
```

Dates are **not** baked in. Every phase boundary is an absolute instant and every listening
window is a time of day, so a file generated last week describes a deployment that has already
happened. The generator defaults the start to the next five-minute boundary at least 10 minutes
out (30 for the soak), which is the time you have to write the card and swipe the magnet. It
prints the forecast, the validation result, and the expected file counts; check those before
committing the card.

## What this cannot test

A digital microphone rules out the entire amplitude-triggered path, because the trigger is an
analog comparator with no PDM equivalent. That leaves these untested, and they are not minor:

| Untested | Why |
| --- | --- |
| `AUDIO_RECORDING_MODE = AMPLITUDE` | needs the analog comparator |
| `AUDIO_EXTEND_CLIP` | amplitude mode only — **this is new and has never run on hardware** |
| `AUDIO_TRIGGER_THRESHOLD` | amplitude mode only |
| `AUDIO_MAX_CLIPS_NUMBER` / `_TIME_SCALE` | amplitude mode only |
| Analog PGA gain `[0, 45] dB` | the digital path uses the PDM ladder instead |
| `BATTERY_LOW_MV` actually firing | would need a cell drained to the cutoff |
| `GPS_AVAILABLE = True` | needs a real fix |

The extend-clip feature is the one that matters here: it was written this cycle, it is
amplitude-only by design, and **this test will not exercise a single line of it**. It needs a
separate run on the analog hardware you have already tested with.

## Watchdog pre-flight — 55 minutes, run this first

The first soak lost three of its six phases to a watchdog that fired before the device's own
heartbeat could feed it, and **the quick check below cleared it beforehand**. That is not bad
luck: the longest sleep anywhere in the quick check is Q3's one-minute interval, and the
watchdog was 120 seconds. No short test had ever slept long enough to see the bug.

This configuration exists to sleep past the timeout, which is now 480 seconds. It covers both
wait paths, because the interval branch and the scheduled branch arm the timer differently:

| Phase | Sleep per cycle | Expect |
| --- | --- | --- |
| W1 interval sleep | 870 s | 3 clips, 3 `.imu` of about 940 kB each at 800 Hz |
| W2 scheduled sleep | 600 s then 480 s | 2 clips of 60 s, 2 `.imu` at 400 Hz |

```bash
node tools/make-test-config.mjs wd --tz America/New_York
```

**Pass is all three of these, and any one failing means stop:**

1. **No `Watch Dog Timer Reset`** anywhere in `a3em.log`, and no `ERROR: Previous run was
   terminated by the watchdog`. Under the old firmware W1 would reset roughly every 182 s.
2. **No zero-byte `.imu` files.** All five should carry real data. A zero-byte file means the
   directory entry was never updated, which is the second defect the soak exposed.
3. **A continuous log.** Timestamps should run unbroken from start to finish. Under the old
   firmware the log froze at its last synced size and each boot overwrote the same region.

Fifty-five minutes here is worth a week. If all three hold, the fixes are real.

## Quick check — 30 minutes, six phases of five

| Phase | Proves | Watch for |
| --- | --- | --- |
| Q1 baseline | Continuous WAV, IMU paired to audio | 30 clips, a `.imu` beside each |
| Q2 silence+band | Silence gate and band-pass filter | **fewer** than 30 clips; talk, then stay quiet |
| Q3 interval+motion | Interval sleep, motion-triggered IMU | 5 clips; `.imu` only after you move the device |
| Q4 scheduled | Listening windows, low-pass, 8 kHz | 21 clips, in two bursts with a gap between |
| Q5 opus | Opus encoding at its forced 48 kHz | 15 `.opus` files, roughly 78 kB each |
| Q6 inexact rate | A rate the PDM clock cannot hit | WAV headers saying **31914 Hz**, not 32000 |

Procedure:

1. Format the card exFAT. Copy the generated `quick_a3em.cfg` to the card root as **`_a3em.cfg`**.
2. Swipe the magnet and hold it for at least 3 seconds (`MAGNET_FIELD_VALIDATION_MS = 3000`).
   The LEDs stay live for the whole test, so you should see activity.
3. During Q2, make noise for the first minute and then keep the room quiet. The point is to see
   the file count differ from Q1's.
4. During Q3, pick the device up and move it a few times. Motion-triggered IMU only writes when
   it detects movement above 100 mg.
5. Let it run to the end. The VHF beacon fires at the deployment end — confirm it with a
   receiver if you have one to hand.
6. Pull the card.

If the counts are in the right ballpark and the log has no `ERROR` lines, go on to the soak.

## Closing the gaps — 10 minutes, after the quick check

Two quick runs closed most of it. The second reached the deployment end and proved the VHF
beacon, the close-out, the LED expiry, and the post-deployment idle state; it also showed the
silence gate's mechanism in interval mode, where phase 6 captured exactly one buffer per
occurrence and wrote nothing. What no run has shown is the gate saying **yes** outside
continuous mode — opening a file when a buffer is not silent.

```bash
node tools/make-test-config.mjs gaps --tz America/Chicago
```

Two five-minute phases, both needing real noise. Talk for the first half of each and go quiet
for the second; clips clustering in the noisy halves settles it. A silent room proves nothing,
because a gate that rejects everything looks identical.

G2 is the one that matters for the soak: **`M4 dawn/dusk` is 28 hours resting on
SCHEDULED + silence, which has never executed.** G1 is the same shared code reached by the
other branch, and is cheap insurance.

## Seven-day soak — reordered and rebalanced

The first run ended at day 5.56 with its last phase never executed, and the phases that did run
were wrecked by the watchdog. So the week is no longer split evenly. M1 and M2 are the paths a
previous run already proved — 56 hours, 1674 valid clips, zero resets — and are cut to a sanity
check. The time goes to the four that have never completed, and the order puts them first.

| Phase | Hours | Starts | Proves |
| --- | --- | --- | --- |
| M1 continuous | 8 | day 0 | Sanity check: rollover, naming, IMU pairing |
| M2 silence gate | 8 | day 0.33 | The suppression control — a quiet room should store almost nothing |
| M3 inexact rate | 24 | day 0.67 | **Never once executed.** Achieved-rate labelling for a full day |
| M4 imu volume | 40 | day 1.67 | The best test of both fixes: 1800 s sleeps, 300 s clips, 800 Hz IMU |
| M5 dawn/dusk | 48 | day 3.33 | The full **12** listening windows, across two whole days |
| M6 opus+motion | 40 | day 5.33 | Opus over many files, plus the ACTIVITY IMU path |

Phases are renumbered by execution order so the card's directories read in the order they were
written. Mapping to the previous run: **M3 = old M6, M4 = old M5, M5 = old M4, M6 = old M3.**

Procedure is the same, except the LEDs go dark after 10 minutes (`LEDS_ACTIVE_SECONDS = 600`)
so they are not an attractant, and deactivation is refused for the first hour
(`FORBID_DEACTIVATION_SECONDS = 3600`) so a stray magnet cannot end the run early.

A deliberate choice this time: thresholds and placement are unchanged from the first run, so
the silence-gated phases (M2, M5, M6) will mostly prove correct **suppression** rather than
pass-through, and M6's ACTIVITY path will log no motion at all — 150 mg is a firm tap, and a
still room is single-digit mg. That keeps the before/after comparison clean, at the cost of
leaving the gate's positive case to the `gaps` configuration, which is what it is for.

## What the soak does not measure

It does **not** measure power. The first run read a flat 3301-3321 mV for 5.56 days because it
was on external supply, but a battery would not have settled it either: the chemistry holds a
nearly flat voltage until it is almost exhausted, so `batt_mv` against time is the wrong
instrument for validating the 2.05 mA forecast. That measurement needs its own deliberate test
and is not a reason to lengthen or repeat this one.

It also cannot reach amplitude-triggered recording or extend-clip at all — see the table above.

## When the run finishes

Mount the card read-only and run the integrity checker, which applies the same judgements the
app does:

```bash
node tools/check-card.mjs /Volumes/A3EM --modern
```

Then hand me the mounted path. What I will check, in order:

1. `_a3em.dev` at the root, and `a3em.log` free of `ERROR` and of `Configuration file contained
   problems that were corrected`.
2. File counts per phase against the generator's expected table, and directory structure
   `LABEL/Activation_NNNN/<day>/<4h-bucket>/<epoch>.wav`.
3. WAV headers: sample rate per phase, and specifically **31914 Hz** in M3.
4. `.imu` headers: the rate in each file against the phase, and no rate the sensor cannot
   produce — this is the fix from finding 14.
5. Silence-gated phases storing measurably less than their ungated equivalents — finding 11.
6. `MIC_HEALTH` verdicts, dropped-buffer and write-failure counters in `TELEM`.

And the three the first soak forced, which are now the headline checks:

7. **Zero watchdog resets.** `grep -c 'Watch Dog Timer Reset'` across every log should be 0.
   The first run had at least 686, and that number was a floor. Finding 17.
8. **Zero zero-byte `.imu` files.** The first run lost 168 of 169 in one phase — about 21 hours
   of 800 Hz data — because the file was never closed. M4 is the phase that would show it
   again. Finding 18.
9. **Unbroken logs.** Each four-hour bucket's `a3em.log` should span the whole bucket. The first
   run kept roughly 17.8 minutes of each and silently overwrote the rest. Finding 19.
