# Hardware validation: quick check, then a seven-day soak

Two configurations that between them exercise as much of the firmware as a **digital**
microphone allows. Run the quick one first — it takes half an hour and catches the
mistakes that would otherwise waste a week.

Generate them immediately before use:

```bash
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

## Seven-day soak — six phases of 28 hours

Twenty-eight rather than twenty-four so that phase boundaries land at a different hour each
time, which puts phase changes, four-hour directory rollovers, and midnight in each other's way
instead of neatly aligned.

| Phase | Proves |
| --- | --- |
| M1 continuous | The longest simple path: rollover, naming, IMU pairing, clock drift over a day |
| M2 silence gate | Whether the gate actually reduces what is stored, over a realistic span |
| M3 opus+motion | Opus across many files; the mostly-asleep power baseline |
| M4 dawn/dusk | The full **12** listening windows — the exact capacity of the array |
| M5 imu volume | 300-second clips at 8 kHz with the IMU at its fastest: throughput stress |
| M6 inexact rate | Achieved-rate labelling held for a full day |

Procedure is the same, except the LEDs go dark after 10 minutes (`LEDS_ACTIVE_SECONDS = 600`)
so they are not an attractant, and deactivation is refused for the first hour
(`FORBID_DEACTIVATION_SECONDS = 3600`) so a stray magnet cannot end the run early.

Leave it somewhere with **some** ambient sound. A silent room makes the silence-gated phases
(M2, M4, M6) indistinguishable from a device that simply failed to record.

## What the soak measures beyond pass/fail

The log writes a `TELEM` line every five minutes carrying `batt_mv`. Seven days of that is the
first real check of the power model, which currently rates itself `extrapolated` and forecasts
2.05 mA average. Four of its constants have never been measured. Comparing the actual drain
against the forecast is worth as much as the functional result — bring the card back and the
comparison is mechanical.

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
3. WAV headers: sample rate per phase, and specifically **31914 Hz** in M6.
4. `.imu` headers: the rate in each file against the phase, and no rate the sensor cannot
   produce — this is the fix from finding 14.
5. Silence-gated phases storing measurably less than their ungated equivalents — finding 11.
6. `MIC_HEALTH` verdicts, dropped-buffer and write-failure counters in `TELEM`.
7. Battery curve against the forecast.
