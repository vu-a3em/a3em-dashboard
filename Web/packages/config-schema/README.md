# @a3em/config-schema

The authoritative definition of an A3EM deployment configuration: the `_a3em.cfg`
serializer and parser, every validation rule, and the storage/battery forecast model.

Both the web dashboard and any server-side tooling import this package, so validation
cannot drift between them.

```bash
npm install
npm run build
npm test
```

## Why this exists

The firmware parses `_a3em.cfg` with hand-rolled C. Its behavior around key ordering,
line length, array bounds, and value clamping is load-bearing and mostly undocumented.
This package encodes that behavior once, with the firmware file and line cited at each
constraint, and pins it with tests.

See [`../FIRMWARE-FINDINGS.md`](../FIRMWARE-FINDINGS.md) for what the firmware actually
does and where the desktop dashboard disagrees with it.

## Layout

| File | Holds |
| --- | --- |
| `firmware-constants.ts` | Every limit and enum, each citing its firmware source. **Edit here when firmware changes.** |
| `types.ts` | The in-app config shape. Not a mirror of the file format. |
| `defaults.ts` | Starting values, with the two deliberate departures from firmware defaults documented. |
| `serialize.ts` | Config → `_a3em.cfg`. The firmware contract lives here. |
| `parse.ts` | `_a3em.cfg` → config, reproducing the firmware's own reading, including its truncation behavior. |
| `validate.ts` | All rules, as `error` (blocks writing) or `warning`. |
| `timezone.ts` | Offset resolution via `Intl`. No timezone dependency. |
| `power/measurements.ts` | Power constants from the planner spreadsheet. **Edit here when new measurements arrive.** |
| `power/forecast.ts` | The model. Reads everything from `measurements.ts`. |

## Usage

```ts
import {
  defaultConfig, serializeConfig, parseConfig, validateConfig, forecast,
} from '@a3em/config-schema';

const config = defaultConfig('America/Chicago');
config.deviceLabel = 'BEAR-04';

const issues = validateConfig(config);
if (issues.some((i) => i.severity === 'error')) throw new Error('not writable');

const plan = forecast({ config, sdCardCapacityGb: 128, batteryCapacityMah: 7000 });
console.log(plan.cardFullAt, plan.batteryDays, plan.confidence);

const text = serializeConfig(config); // write this to the card as _a3em.cfg
const { config: readBack, warnings } = parseConfig(text);
```

`forecast()` returns a `confidence` reflecting the weakest measurement feeding it, and a
`caveats` array. Surface both — several inputs are still unmeasured placeholders, and an
estimate presented as fact is worse than no estimate.

## Updating the power model

New bench measurements go in `power/measurements.ts` and nowhere else. Each entry carries
its spreadsheet cell and a confidence tag; changing a value is a one-line edit and the
arithmetic never moves.

`power/forecast.test.ts` pins the model against all ten average-current figures from
`A3EM Deployment Planner.xlsx` plus its storage and battery day counts. **Those tests
will fail when you update a constant — that is intended.** Re-derive the expected values
from the sheet (or delete the row if the sheet is superseded) and say so in the commit.

## Updating for a firmware change

1. Update `firmware-constants.ts` and bump `CONFIG_SCHEMA_VERSION`.
2. Add or reorder keys in `parse.ts`'s `KEY_ORDER` — the prefix-shadowing test will tell
   you if the new order is unsafe on device.
3. Add validation rules for any new limit.
4. Add a migration if existing stored configs need one.
