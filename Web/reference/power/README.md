# Power measurements

This directory is the source of truth for how much charge an A3EM draws. It replaces
`../A3EM Deployment Planner.xlsx`, whose values survive here only as each quantity's `prior`,
kept for comparison until a measurement replaces it.

| File | What it holds | Who writes it |
|---|---|---|
| `measurements.json` | Every quantity the forecaster uses, and every measurement of it | Quantities: once, from the firmware's step table. Measurements: `tools/power/power_ingest.py` only |
| `components.json` | The cards, microphones and cells a measurement can name | By hand, before measuring a new part |
| `batteries/*.json` | Cell profiles digitized from the manufacturer's datasheets | By hand, from the datasheet named inside |
| `captures/` | The windows, 10 ms trace and `_power.results` behind every measurement | `power_ingest.py` |
| `PROCEDURE.md` | How to take the measurements | By hand |

## How the forecast is built from these

A deployment's charge is a sum over what the device does:

```
Q = sum over states (current x time in state) + sum over events (charge per event x number of events)
```

This splits the problem into three layers, each of which can be checked on its own.

1. **Physics, measured.** Each quantity in `measurements.json` is one step of the power
   characterization firmware (`a3em-firmware/tests/peripherals/test_power.c`):
   - A **state** is a mean current in µA, such as `SLEEP_FLOOR` or `MIC_CAPTURE_16K`.
   - An **event** is a charge in µC over its baseline state, such as one 512 KiB card session or
     one second of Opus encoding.
   - A **cycle** is an event measured by switching a state on and off.
   - A **limit** is a supply voltage, such as the lowest one the board works at under its
     heaviest load.

   Card sessions are measured at four sizes, so session charge can be fitted as
   `fixed + per-byte × bytes`.
2. **Behaviour, derived.** A configuration determines how long the device spends in each state
   and how many of each event it pays for. This layer is pure logic mirroring the firmware, with
   no measurements in it.
3. **The cell.** Capacity depends on load current and temperature, and the cell is used up when
   its loaded voltage falls to the board's minimum operating voltage (`BROWNOUT_HEAVY`).
   Datasheet curves are in `batteries/`; the battery suite measures the loaded voltage directly.
   The configured `BATTERY_LOW_MV` cutoff is deliberately not part of the forecast.

The forecast reports a range, not a single number. Each quantity has measurements across
temperatures and parts, and the forecaster carries that spread through to the result.

## Lockstep with the firmware

Quantities are keyed by step name and by the marker code that step sends. The step table is
extracted into `../firmware-snapshot.json` (`powerSteps`). The config-schema test
`power/catalogue.test.ts` fails if the two disagree in any of these ways:

- a step is added, renamed or renumbered;
- a step is moved to another suite;
- a step is rebased onto a different baseline.

It also fails if a measurement does not say which card, microphone or cell it was taken with,
when its quantity depends on one.

To change a step: edit `test_power.c`, run `python3 tools/extract_firmware_constants.py`, then
make the matching edit to the quantity here.

## Measurements

Each measurement records:

- its value, plus the raw window statistics and firmware counters the value was derived from;
- the temperature label and the die temperature;
- the parts fitted;
- the supply mode;
- the firmware build;
- SHA-256 hashes of the capture and results files, which are archived under `captures/`.

An event's value names the exact baseline measurements it was derived against. A value whose
baseline has not been measured yet is held as `pending`. `power_ingest.py recompute` fills
pending values in later, and re-derives every other value from the raw statistics.
`power_ingest.py status` shows which quantity-temperature cells are still empty.

Nothing in `measurements` should be edited by hand. If a capture is bad, remove its
measurements together with its folder under `captures/`, and say why in the commit message.
