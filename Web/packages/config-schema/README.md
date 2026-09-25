# @a3em/config-schema

Everything the dashboard knows about an A3EM recorder and its SD card, with no interface: the
configuration file's format and every rule for it, the storage and battery forecast, what a card
needs to be ready, and readers for what a recorder writes. The dashboard and the scripts in
[`tools`](../../tools) use it, so a rule is written once and read the same everywhere. The card
helper, in Go, repeats the one rule it must enforce on its own, what a format request may ask for,
and a shared test fails if the two disagree.

```sh
npm test      # from Web/: builds the package and runs its tests
```

## Why it exists

The firmware reads its configuration file, `_conf.a3m`, with hand-written C, and its behavior around key order, line
length, array bounds, and clamping matters and is mostly undocumented. This package encodes it
once, citing the firmware file and symbol behind each constraint, and pins it with tests that are
checked against the firmware source itself.

## Layout

**The configuration**

| File | Holds |
| --- | --- |
| `firmware-constants.ts` | Every limit and enumeration, each citing its firmware source. **Edit here when the firmware changes.** |
| `firmware-profile.ts` | The two firmware generations a card can come from, and what differs between them. |
| `types.ts`, `defaults.ts` | The configuration as the dashboard holds it, and its starting values. |
| `serialize.ts` | Configuration → the configuration file, the exact text the firmware parses. |
| `parse.ts` | The configuration file → configuration, reading it the way the firmware does. |
| `validate.ts` | Every rule, as an `error`, which blocks writing, or a `warning`. |
| `schedule.ts`, `solar.ts`, `timezone.ts` | Recording periods, sunrise and sunset (a mirror of the firmware's own calculation), and time zones through `Intl`, with no time zone dependency. |
| `audio-clock.ts`, `audio-threshold.ts`, `silence-band.ts` | The sample rates the microphone clocks can actually reach, the amplitude trigger in decibels, and the band the silence filter really judges. |
| `summaries.ts` | One-line summaries of the settings. |
| `protocol.ts`, `protocol-sync.ts` | Saved protocols, the starters, and how a browser's protocols join an account's. |

**The forecast and the card**

| File | Holds |
| --- | --- |
| `power/measurements.ts` | Power and storage measurements from the planner spreadsheet, each with its cell and a confidence. **Edit here when new measurements arrive.** |
| `power/forecast.ts` | The model: storage, battery, and when each runs out. Reads everything from `measurements.ts`. |
| `allocation-unit.ts`, `card-capacity.ts` | The cluster size a deployment should use, and how much of a card is left for recordings. |
| `card-format.ts` | What the firmware requires of a card's filesystem, and the checks on a format request. |
| `card-readiness.ts` | Whether a card is ready to deploy, from what the card helper reports, and the least that preparing it needs. |

**Reading a card**

| File | Holds |
| --- | --- |
| `card-layout.ts` | What is on a card, under both naming schemes. |
| `device-info.ts`, `self-test.ts`, `log-file.ts` | Readers for `_a3em.dev`, `_a3em.test.results`, and `a3em.log`, in both formats. |
| `audio-clip.ts`, `spectrogram.ts`, `imu-file.ts` | A clip's format, levels, and spectrogram, and `.imu` files in both header layouts. |
| `integrity.ts`, `recovery.ts` | Whether a recording is sound, and how much of what lies past a file's recorded end belongs to it. |
| `coverage.ts`, `geo.ts` | When a deployment recorded against when it was meant to, and where it was. |

**Keeping it honest**

| File | Holds |
| --- | --- |
| `snapshots.ts` | Loads the snapshots of the firmware and the spreadsheet in `reference/`, for the tests. Nothing in the dashboard reads them. |
| `open-items.ts` | Everything still unmeasured or unresolved, so a placeholder never quietly becomes load-bearing. `npm run open-items` lists it. |

## Usage

```ts
import { defaultConfig, forecast, parseConfig, serializeConfig, validateConfig } from '@a3em/config-schema';

const config = defaultConfig('America/Chicago');
config.deviceLabel = 'BEAR_04';

const issues = validateConfig(config);
if (issues.some((issue) => issue.severity === 'error')) throw new Error('not writable');

const plan = forecast({ config, sdCardCapacityGb: 128, batteryCapacityMah: 7000 });
console.log(plan.cardFullAt, plan.batteryDays, plan.confidence, plan.caveats);

const text = serializeConfig(config); // written to the card as CONFIG_FILE_NAME, _conf.a3m
const { config: readBack, warnings } = parseConfig(text);
```

`forecast()` returns a `confidence`, the weakest of the measurements behind it, and `caveats`.
Show both: some inputs are still estimates, and an estimate presented as fact is worse than none.

## Updating the power model

New bench measurements go into the planner spreadsheet, `reference/A3EM Deployment Planner.xlsx`,
and into `power/measurements.ts`. `npm run sync` (from `Web/`) regenerates
`reference/planner-snapshot.json` from the spreadsheet. The tests then check that
`measurements.ts` agrees with it, and that the forecast reproduces the spreadsheet's own computed
figures, which they read from the snapshot: they fail only when the model and the spreadsheet
disagree.

## Updating for a firmware change

1. Update `firmware-constants.ts`, and run `npm run sync` from `Web/` so the firmware snapshot
   matches. The tests compare the constants, the configuration keys, the log events, and the stop
   reasons with the firmware source.
2. Add or reorder keys in `parse.ts`'s `KEY_ORDER`. A test fails if the order would let one key
   be read as another on the device.
3. Add validation rules for any new limit.
4. Bump `CONFIG_SCHEMA_VERSION` only for a change that saved drafts and protocols cannot be read
   under: those saved under another version are no longer loaded.
