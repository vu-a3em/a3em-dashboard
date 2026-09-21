/**
 * Reader for `_a3em.test.results`, written at the card root by the hardware self-test
 * that runs at every activation.
 *
 * The app surfaces this the moment a card is connected: it answers "did this unit
 * verify?" before anything else is inspected, and names the subsystem when it did not.
 *
 * Same `KEY = "value"` grammar as `_a3em.cfg` and `_a3em.dev`.
 */

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
  power: { batteryMv: number; temperatureC: number; rtcValid: boolean };
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
      batteryMv: num('BATTERY_MV'),
      temperatureC: num('TEMPERATURE_C'),
      rtcValid: values.get('RTC_VALID') === 'True',
    },
  };
}

function coerceMicResult(value: string | undefined): SelfTestResults['microphone']['result'] {
  return value === 'FAIL' || value === 'PASS_SILENT' ? value : 'PASS';
}

/**
 * One line summarising the test for the connect-time banner.
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
