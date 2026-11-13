/**
 * Reader for `_a3em.test.results`, written at the card root by the hardware self-test
 * that runs at every activation.
 *
 * The app surfaces this the moment a card is connected: it answers "did this unit
 * verify?" before anything else is inspected, and names the subsystem when it did not.
 *
 * Same `KEY = "value"` grammar as the configuration file and `_a3em.dev`.
 */

import { batteryMillivolts, parsePowerSource, type PowerSource } from './device-info.js';
import {
  SELF_TEST_BATTERY_MAX_MV,
  SELF_TEST_BATTERY_MIN_MV,
  SELF_TEST_TEMPERATURE_MAX_C,
  SELF_TEST_TEMPERATURE_MIN_C,
} from './firmware-constants.js';

export const SELF_TEST_RESULTS_FILE_NAME = '_a3em.test.results';
export const SELF_TEST_CLIP_FILE_NAME = '_a3em.test.wav';

/** Matches `self_test_result_t`. The value is also the red-LED blink count. */
export type SelfTestSubsystem = 'NONE' | 'MICROPHONE' | 'STORAGE' | 'IMU' | 'POWER_OR_CLOCK';

const SUBSYSTEM_BY_CODE: Record<number, SelfTestSubsystem> = {
  0: 'NONE',
  1: 'MICROPHONE',
  2: 'STORAGE',
  3: 'IMU',
  4: 'POWER_OR_CLOCK',
};

/** What to tell the user, and what to do about it. */
export const SUBSYSTEM_GUIDANCE: Record<SelfTestSubsystem, string> = {
  NONE: 'All hardware checks passed.',
  MICROPHONE:
    'The microphone did not produce a usable signal. Check the microphone wiring and ' +
    'its connector before deploying — this is the most common cause of a lost recording.',
  STORAGE:
    'The SD card did not survive a write-and-read-back test. Reseat the card and run ' +
    'the check again.',
  IMU: 'The motion sensor did not report a plausible reading. Motion data will be unusable.',
  POWER_OR_CLOCK:
    'The battery reading or the real-time clock was out of range. A stopped clock ' +
    'invalidates every timestamp on the card.',
};

export interface SelfTestResults {
  firmwareVersion: string;
  deviceLabel: string;
  /** ISO instant the test ran. */
  testedAt: string | null;
  activationNumber: number;

  passed: boolean;
  failedSubsystem: SelfTestSubsystem;

  microphone: {
    type: 'ANALOG' | 'DIGITAL';
    /** PASS_SILENT means the path works but the room was quiet — not a fault. */
    result: 'PASS' | 'PASS_SILENT' | 'FAIL';
    /**
     * Signal level and largest excursion, both measured about the window's mean, so an
     * offset the device has not removed does not count as sound.
     */
    rms: number;
    /**
     * How many samples the RMS figure was taken over.
     *
     * RMS is subsampled while min, max, and the constant-output check see every sample,
     * so this is the population behind that one number — a small count means the figure
     * is noisier than the others beside it.
     */
    rmsSamples: number;
    peak: number;
    min: number;
    max: number;
    mean: number;
    samples: number;
    dcOffset: number;
    constantOutput: boolean;
  };
  storage: { result: 'PASS' | 'FAIL'; bytesVerified: number; freeMb: number };
  imu: { result: 'PASS' | 'FAIL'; magnitudeMg: number };
  power: {
    /** What the device was running from during the test. Null when the file does not say. */
    source: PowerSource | null;
    /** Null when there is no reading: the battery is not measured on external power. */
    batteryMv: number | null;
    temperatureC: number;
    rtcValid: boolean;
  };
}

export function parseSelfTestResults(text: string): SelfTestResults | null {
  const values = new Map<string, string>();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const quoted = line.slice(eq + 1).trim();
    if (!quoted.startsWith('"') || !quoted.endsWith('"') || quoted.length < 2) continue;
    values.set(line.slice(0, eq).trim(), quoted.slice(1, -1));
  }

  const overall = values.get('OVERALL');
  if (!overall) return null;

  const num = (key: string) => Number(values.get(key) ?? '0');
  const powerSource = parsePowerSource(values.get('POWER_SOURCE'));
  const testedAtSeconds = num('TEST_TIMESTAMP');

  return {
    firmwareVersion: values.get('FW_VERSION') ?? 'unknown',
    deviceLabel: values.get('DEVICE_LABEL') ?? '',
    testedAt: testedAtSeconds > 0 ? new Date(testedAtSeconds * 1000).toISOString() : null,
    activationNumber: num('ACTIVATION_NUMBER'),
    passed: overall === 'PASS',
    failedSubsystem: SUBSYSTEM_BY_CODE[num('FAILED_SUBSYSTEM')] ?? 'NONE',
    microphone: {
      type: values.get('MIC_TYPE') === 'DIGITAL' ? 'DIGITAL' : 'ANALOG',
      result: coerceMicResult(values.get('MIC_RESULT')),
      rms: num('MIC_RMS'),
      rmsSamples: num('MIC_RMS_SAMPLES'),
      peak: num('MIC_PEAK'),
      min: num('MIC_MIN'),
      max: num('MIC_MAX'),
      mean: num('MIC_MEAN'),
      samples: num('MIC_SAMPLES'),
      dcOffset: num('MIC_DC_OFFSET'),
      constantOutput: values.get('MIC_CONSTANT_OUTPUT') === 'True',
    },
    storage: {
      result: values.get('SD_RESULT') === 'PASS' ? 'PASS' : 'FAIL',
      bytesVerified: num('SD_BYTES_VERIFIED'),
      freeMb: num('SD_FREE_MB'),
    },
    imu: {
      result: values.get('IMU_RESULT') === 'PASS' ? 'PASS' : 'FAIL',
      magnitudeMg: num('IMU_MAGNITUDE_MG'),
    },
    power: {
      source: powerSource,
      batteryMv: batteryMillivolts(values.get('BATTERY_MV'), powerSource),
      temperatureC: num('TEMPERATURE_C'),
      rtcValid: values.get('RTC_VALID') === 'True',
    },
  };
}

function coerceMicResult(value: string | undefined): SelfTestResults['microphone']['result'] {
  return value === 'FAIL' || value === 'PASS_SILENT' ? value : 'PASS';
}

export interface PowerCheckVerdict {
  /** The check's verdict, or null when the results file does not settle it. */
  result: 'PASS' | 'FAIL' | null;
  /** What failed, in terms of what was measured. Empty unless the check failed. */
  problems: string[];
}

/**
 * The verdict of the self-test's power and clock check.
 *
 * Unlike the other checks it has no result key of its own. The file names only the FIRST
 * failing subsystem, and power is judged last, so after another subsystem fails its verdict
 * is not written anywhere. A failure can still be proved from the readings: a battery voltage
 * or temperature outside the range the test accepts fails the check whatever else happened.
 * The third part, that the clock advanced across the test, is not recorded at all, so a
 * failure with both readings in range can only have been the clock.
 */
export function powerCheckVerdict(results: SelfTestResults): PowerCheckVerdict {
  const { source, batteryMv, temperatureC } = results.power;
  const problems: string[] = [];
  // The battery is not judged on external power, where it is not measured.
  if (source !== 'EXTERNAL') {
    if (batteryMv === null) {
      problems.push('the battery could not be measured');
    } else if (batteryMv < SELF_TEST_BATTERY_MIN_MV || batteryMv > SELF_TEST_BATTERY_MAX_MV) {
      problems.push(
        `the battery read ${(batteryMv / 1000).toFixed(2)} V, outside the ` +
          `${SELF_TEST_BATTERY_MIN_MV / 1000}–${SELF_TEST_BATTERY_MAX_MV / 1000} V the test accepts`,
      );
    }
  }
  if (temperatureC < SELF_TEST_TEMPERATURE_MIN_C || temperatureC > SELF_TEST_TEMPERATURE_MAX_C) {
    problems.push(
      `the temperature read ${temperatureC.toFixed(1)} °C, outside the ` +
        `${SELF_TEST_TEMPERATURE_MIN_C} to ${SELF_TEST_TEMPERATURE_MAX_C} °C the test accepts`,
    );
  }

  if (results.failedSubsystem === 'POWER_OR_CLOCK') {
    return { result: 'FAIL', problems: problems.length ? problems : ['the clock did not advance during the test'] };
  }
  if (results.passed) return { result: 'PASS', problems: [] };
  return problems.length ? { result: 'FAIL', problems } : { result: null, problems: [] };
}

/**
 * One line summarizing the test for the connect-time banner.
 *
 * A silent pass is called out explicitly rather than shown as a plain pass: the
 * electrical path worked but nothing was heard, which is expected on a quiet bench and
 * suspicious in a location that should have ambient sound.
 */
export function summarizeSelfTest(results: SelfTestResults): string {
  if (!results.passed) {
    return SUBSYSTEM_GUIDANCE[results.failedSubsystem];
  }
  if (results.microphone.result === 'PASS_SILENT') {
    return 'All checks passed, but the microphone heard nothing during the test. Confirm the microphone port is not blocked.';
  }
  return 'All hardware checks passed.';
}
