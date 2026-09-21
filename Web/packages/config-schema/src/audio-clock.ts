import {
  AUDADC_SOURCE_CLOCK_HZ,
  AUDADC_TIMER_COUNT_MAX,
  PDM_ALT_SINCRATE,
  PDM_MAX_CKO_HZ,
  PDM_MAX_DIVMCLKQ,
  PDM_MAX_MCLKDIV,
  PDM_MAX_SINCRATE,
  PDM_MIN_CKO_HZ,
  PDM_MIN_DIVMCLKQ,
  PDM_MIN_SINCRATE,
  PDM_NOMINAL_CLOCK_HZ,
  PDM_RATE_TOLERANCE_PERMILLE,
} from './firmware-constants.js';
import type { MicType } from './firmware-constants.js';

/**
 * The sample rate the hardware will actually produce, as opposed to the one requested.
 *
 * Neither microphone path can hit an arbitrary rate. The analog converter divides a
 * 12 MHz clock through an integer counter; the digital microphone divides a 24 MHz clock
 * twice, once to clock the microphone and once to decimate its bitstream. Where the
 * arithmetic does not come out even, the firmware takes the closest reachable rate,
 * writes THAT into the WAV header, and carries on.
 *
 * Nothing is lost by this — the recordings are correctly labelled — but the label is not
 * the number that was asked for, and finding that out after a field season is worse than
 * being told before the card is written.
 *
 * Both functions mirror `configure_repeat_trigger_timer()` and the PDM divider search in
 * audio.c exactly, including their integer truncation. Reproducing the rounding is the
 * whole point: an idealised calculation would disagree with the device in precisely the
 * cases worth warning about.
 */

export interface AchievableRate {
  requestedHz: number;
  actualHz: number;
  exact: boolean;
  /** Signed fractional error, so +0.0027 means the device runs 0.27% fast. */
  errorFraction: number;
  /** Null when no divider combination reaches the requested rate at all. */
  reachable: boolean;
}

/** What the analog converter's repeat-trigger timer can produce. */
export function analogSampleRate(requestedHz: number): AchievableRate {
  if (!Number.isFinite(requestedHz) || requestedHz <= 0) {
    return { requestedHz, actualHz: 0, exact: false, errorFraction: 0, reachable: false };
  }

  // The /4 divider is tried first because its one-tick offset cancels exactly. It only
  // applies while the resulting count fits the timer's 10-bit compare register, which
  // rules it out for the lowest rates -- 8 kHz needs a count of 1500 against a limit
  // of 1023, so 8 kHz falls through to the coarser path below.
  const div4Count = Math.floor(AUDADC_SOURCE_CLOCK_HZ / requestedHz);
  if (div4Count >= 3 && div4Count - 2 <= AUDADC_TIMER_COUNT_MAX) {
    return describe(requestedHz, Math.floor(AUDADC_SOURCE_CLOCK_HZ / div4Count));
  }

  // The /8 divider carries a half-tick offset that cannot be cancelled, so the achieved
  // rate is 12 MHz / (2n + 3) -- an odd divisor, which most requested rates miss.
  const raw = Math.round(AUDADC_SOURCE_CLOCK_HZ / 2 / requestedHz - 1.5);
  const countMax = Math.max(1, Math.min(AUDADC_TIMER_COUNT_MAX, raw));
  return describe(requestedHz, Math.floor(AUDADC_SOURCE_CLOCK_HZ / (2 * countMax + 3)));
}

/**
 * What the digital microphone's clock tree can produce.
 *
 * Two dividers reduce a 24 MHz source to the clock handed to the microphone, and a third
 * decimates its bitstream. Where several combinations land close enough to the request,
 * the firmware takes the one with the FASTEST microphone clock rather than the smallest
 * error — a faster clock oversamples more, which is worth more than a few hertz of
 * accuracy. Reproducing that preference matters: picking the nearest rate instead would
 * disagree with the device on exactly the rates worth warning about.
 */
export function digitalSampleRate(requestedHz: number): AchievableRate {
  if (!Number.isFinite(requestedHz) || requestedHz <= 0) {
    return { requestedHz, actualHz: 0, exact: false, errorFraction: 0, reachable: false };
  }

  const tolerance = Math.floor((requestedHz * PDM_RATE_TOLERANCE_PERMILLE) / 1000);
  let best: { achieved: number; error: number; clockHz: number } | null = null;

  for (let divmclkq = PDM_MIN_DIVMCLKQ; divmclkq <= PDM_MAX_DIVMCLKQ; divmclkq++) {
    for (let mclkdiv = 1; mclkdiv <= PDM_MAX_MCLKDIV; mclkdiv++) {
      const clockHz = Math.floor(PDM_NOMINAL_CLOCK_HZ / ((divmclkq + 1) * (mclkdiv + 1)));
      if (clockHz < PDM_MIN_CKO_HZ || clockHz > PDM_MAX_CKO_HZ) continue;

      for (let sincrate = PDM_MIN_SINCRATE; sincrate <= PDM_ALT_SINCRATE; sincrate++) {
        // Between the normal ceiling and the alternate rate nothing else is legal.
        if (sincrate > PDM_MAX_SINCRATE && sincrate !== PDM_ALT_SINCRATE) continue;

        const achieved = Math.floor(clockHz / (2 * sincrate));
        const error = Math.abs(achieved - requestedHz);

        let better: boolean;
        if (!best) {
          better = true;
        } else {
          const inTolerance = error <= tolerance;
          const bestInTolerance = best.error <= tolerance;
          if (inTolerance !== bestInTolerance) better = inTolerance;
          else if (inTolerance) better = clockHz > best.clockHz;
          else better = error < best.error;
        }
        if (better) best = { achieved, error, clockHz };
      }
    }
  }

  if (!best) return { requestedHz, actualHz: 0, exact: false, errorFraction: 0, reachable: false };
  return describe(requestedHz, best.achieved);
}

/** The rate for whichever microphone the deployment uses. */
export function achievableSampleRate(requestedHz: number, micType: MicType): AchievableRate {
  return micType === 'DIGITAL' ? digitalSampleRate(requestedHz) : analogSampleRate(requestedHz);
}

/**
 * Every offered rate the chosen microphone cannot produce exactly.
 *
 * Used to mark the options in the editor, so the trade-off is visible while choosing
 * rather than discovered in a warning afterwards.
 */
export function inexactRates(rates: readonly number[], micType: MicType): Map<number, AchievableRate> {
  const inexact = new Map<number, AchievableRate>();
  for (const rate of rates) {
    const result = achievableSampleRate(rate, micType);
    if (!result.exact) inexact.set(rate, result);
  }
  return inexact;
}

function describe(requestedHz: number, actualHz: number): AchievableRate {
  return {
    requestedHz,
    actualHz,
    exact: actualHz === requestedHz,
    errorFraction: requestedHz > 0 ? (actualHz - requestedHz) / requestedHz : 0,
    reachable: actualHz > 0,
  };
}
