import { ADC_CODE_MAX, TRIGGER_DIGIPOT_STEPS } from './firmware-constants.js';

/**
 * Converting the amplitude trigger between the fraction the firmware stores and
 * the decibels an ecologist can reason about.
 *
 * `AUDIO_TRIGGER_THRESHOLD` in the config is a fraction of full scale in 0..1.
 * The desktop dashboard labeled it "dB" and passed the raw number straight
 * through, so anyone who typed a real dB value got nonsense.
 *
 * Three hardware facts shape what the UI can honestly offer:
 *
 *  1. Full scale is a 12-bit signed ADC — amplitude runs to 2047 codes.
 *
 *  2. The threshold is applied by an ANALOG comparator, not in the digital domain.
 *     `audio_analog_init()` hands the fraction to
 *     `comparator_init(false, 0, percent, true)`, which calls
 *     `digipot_set_percent_output(percent)`.
 *
 *  3. That digipot is 8-bit and the firmware TRUNCATES into it:
 *         uint8_t wiper_value = (uint8_t)(255 * percent);
 *     So only 255 usable levels exist, evenly spaced in voltage — which makes them
 *     very unevenly spaced in dB. One step is worth ~0.03 dB near full scale and
 *     ~6 dB at the quiet end.
 *
 * Consequence for the UI: a threshold control must step in wipers, not in dB, and
 * display the level the device will ACTUALLY use. Quantization is not an error
 * condition — it is how the hardware works, and every stored value has it. The only
 * genuine fault is a value that truncates to wiper 0, which disarms the trigger.
 */

/** The level the device actually applies for a stored fraction, as a fraction. */
export function effectiveLevel(storedFraction: number): number {
  return fractionToWiper(storedFraction) / TRIGGER_DIGIPOT_STEPS;
}

/** The digipot wiper the firmware will compute. Truncating, matching the C cast. */
export function fractionToWiper(storedFraction: number): number {
  const clamped = Math.min(1, Math.max(0, storedFraction));
  return Math.min(TRIGGER_DIGIPOT_STEPS, Math.trunc(TRIGGER_DIGIPOT_STEPS * clamped));
}

/**
 * A fraction to STORE so the firmware's truncating cast lands on `wiper`.
 *
 * Sits at the middle of the wiper's input band, which makes it immune to floating
 * point drift through serialization and back.
 */
export function wiperToStoredFraction(wiper: number): number {
  const clamped = Math.min(TRIGGER_DIGIPOT_STEPS, Math.max(1, Math.round(wiper)));
  if (clamped >= TRIGGER_DIGIPOT_STEPS) return 1;
  return (clamped + 0.5) / TRIGGER_DIGIPOT_STEPS;
}

/** Snaps a fraction to a storable value that reliably reproduces the nearest level. */
export function quantizeFraction(storedFraction: number): number {
  return wiperToStoredFraction(fractionToWiper(storedFraction));
}

/** Lowest wiper that actually arms the comparator. */
export const MIN_WIPER = 1;

/** dBFS at the quietest usable level (wiper 1). About -48.1 dBFS. */
export const MIN_THRESHOLD_DBFS = levelToDbfs(MIN_WIPER / TRIGGER_DIGIPOT_STEPS);

/** dBFS at full scale (wiper 255). Exactly 0. */
export const MAX_THRESHOLD_DBFS = 0;

/** A level as a fraction of full scale → dB relative to full scale. Always <= 0. */
export function levelToDbfs(level: number): number {
  if (level <= 0) return -Infinity;
  return 20 * Math.log10(Math.min(1, level));
}

/** dB relative to full scale → level as a fraction of full scale. */
export function dbfsToLevel(dbfs: number): number {
  if (dbfs === -Infinity) return 0;
  return Math.min(1, 10 ** (Math.min(0, dbfs) / 20));
}

/** dBFS the device will actually trigger at, for a stored fraction. */
export function storedFractionToDbfs(storedFraction: number): number {
  return levelToDbfs(effectiveLevel(storedFraction));
}

/** A stored fraction that gets as close as the hardware allows to a target dBFS. */
export function dbfsToStoredFraction(dbfs: number): number {
  const wiper = Math.round(dbfsToLevel(dbfs) * TRIGGER_DIGIPOT_STEPS);
  return wiperToStoredFraction(Math.max(MIN_WIPER, wiper));
}

/** Peak amplitude in ADC codes at which the trigger fires. */
export function levelToAdcCodes(level: number): number {
  return Math.round(Math.min(1, Math.max(0, level)) * ADC_CODE_MAX);
}

/**
 * dB distance to the next wiper up. Use it to set a control's displayed precision
 * and to tell the user when a finer adjustment is not physically available.
 */
export function dbStepAtWiper(wiper: number): number {
  const w = Math.min(TRIGGER_DIGIPOT_STEPS, Math.max(MIN_WIPER, Math.round(wiper)));
  const lower = w >= TRIGGER_DIGIPOT_STEPS ? w - 1 : w;
  return Math.abs(
    levelToDbfs((lower + 1) / TRIGGER_DIGIPOT_STEPS) - levelToDbfs(lower / TRIGGER_DIGIPOT_STEPS),
  );
}

/** Every usable threshold, quietest first. Build the control's steps from this. */
export function achievableThresholds(): Array<{
  wiper: number;
  storedFraction: number;
  level: number;
  dbfs: number;
}> {
  const out = [];
  for (let wiper = MIN_WIPER; wiper <= TRIGGER_DIGIPOT_STEPS; wiper++) {
    const level = wiper / TRIGGER_DIGIPOT_STEPS;
    out.push({ wiper, storedFraction: wiperToStoredFraction(wiper), level, dbfs: levelToDbfs(level) });
  }
  return out;
}

/**
 * Everything the UI needs to render a threshold honestly: the level the device will
 * use, its dB equivalent, and how coarse the next adjustment is.
 */
export function describeThreshold(storedFraction: number): {
  wiper: number;
  storedFraction: number;
  level: number;
  dbfs: number;
  adcCodes: number;
  stepDb: number;
  label: string;
  armsTrigger: boolean;
} {
  const wiper = fractionToWiper(storedFraction);
  const level = wiper / TRIGGER_DIGIPOT_STEPS;
  const dbfs = levelToDbfs(level);
  const stepDb = dbStepAtWiper(wiper);
  const decimals = stepDb >= 1 ? 0 : 1;
  return {
    wiper,
    storedFraction,
    level,
    dbfs,
    adcCodes: levelToAdcCodes(level),
    stepDb,
    label: wiper >= MIN_WIPER ? `${dbfs.toFixed(decimals)} dBFS` : 'disarmed',
    armsTrigger: wiper >= MIN_WIPER,
  };
}
