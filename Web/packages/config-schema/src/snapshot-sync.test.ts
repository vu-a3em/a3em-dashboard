import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  AUDIO_DEFAULT_CLIP_LENGTH_SECONDS,
  AUDIO_DEFAULT_SAMPLE_RATE_HZ,
  AUDIO_BUFFER_MAX_SAMPLES,
  AUDIO_BUFFER_MAX_SIZE_BYTES,
  AUDIO_NUM_CHANNELS,
  AUDIO_RECORDING_MODES,
  BATTERY_DEFAULT_LOW_MV,
  CONFIG_FILE_NAME,
  DEVICE_LABEL_FIRMWARE_MAX_LEN,
  AUDIO_MAX_CLIP_LENGTH_SECONDS,
  AUDIO_MAX_SAMPLING_RATE_HZ,
  AUDIO_MIN_CLIP_LENGTH_SECONDS,
  AUDIO_MIN_SAMPLING_RATE_HZ,
  AUDIO_SAMPLE_RATES_HZ,
  DEVICE_LABEL_MAX_LEN,
  IMU_BUFFER_MAX_SAMPLES,
  IMU_DEFAULT_SAMPLE_RATE_HZ,
  IMU_FIFO_SAMPLES,
  IMU_RECORDING_MODES,
  LOG_FILE_NAME,
  MAGNET_DEFAULT_VALIDATION_MS,
  MAX_AUDIO_TRIGGER_TIMES,
  MAX_CFG_LINE_LENGTH,
  MAX_DEPLOYMENT_PHASES,
  MAX_FREQUENCY_HEADROOM_HZ,
  MIC_TYPES,
  MIN_LOG_DATA_INTERVAL_SECONDS,
  SD_CARD_ALLOCATION_UNIT_BYTES,
  WAV_STAGING_BUFFER_SIZE_BYTES,
  NUM_HOURS_PER_AUDIO_DIRECTORY,
  OPUS_DEFAULT_BITRATE,
  OPUS_MAX_BITRATE,
  OPUS_MS_PER_FRAME,
  OPUS_REQUIRED_SAMPLE_RATE_HZ,
  TIME_SCALES,
  TRIGGER_DIGIPOT_STEPS,
} from './firmware-constants.js';
import { ALLOCATION_UNIT_CHOICES_BYTES } from './allocation-unit.js';
import { KEY_ORDER } from './parse.js';
import { loadFirmwareSnapshot, loadPlannerSnapshot } from './snapshots.js';
import { DEACTIVATION_REASON_LABELS } from './device-info.js';
import { FIRMWARE_FAULT_REASONS } from './log-file.js';
import {
  BUFFERS,
  DEFAULTS,
  DEFAULT_MICROPHONE,
  DEFAULT_SD_SPEED_CLASS,
  IMU_CURRENT_MA,
  MAGNET,
  MCU,
  MICROPHONE_CURRENT_MA,
  OPUS_ENCODE_MS_BY_BITRATE,
  SD_CARD,
  SD_SPEED_CLASS_MB_PER_S,
  WAV_PROCESSING_MS_PER_INTERVAL,
} from './power/measurements.js';

/**
 * These tests are the enforcement mechanism for the two external sources of truth.
 *
 * They compare the hand-written TypeScript against JSON snapshots generated from the
 * firmware source and the planner spreadsheet. A failure here does NOT mean the
 * TypeScript is wrong — it means one of the external sources changed and the
 * TypeScript has not caught up yet. The failure message names the constant.
 *
 * Regenerate snapshots with:
 *   python3 tools/extract_firmware_constants.py
 *   python3 tools/extract_power_measurements.py
 */

describe('firmware-constants.ts agrees with the firmware source', () => {
  const snapshot = loadFirmwareSnapshot();
  const define = (name: string): number => {
    const value = snapshot.numericDefines[name];
    assert.ok(value !== undefined, `#define ${name} missing from the firmware snapshot`);
    return value;
  };

  it('tracks the hard array limits', () => {
    assert.equal(MAX_DEPLOYMENT_PHASES, define('MAX_NUM_DEPLOYMENT_PHASES'));
    assert.equal(MAX_AUDIO_TRIGGER_TIMES, define('MAX_AUDIO_TRIGGER_TIMES'));
    assert.equal(MAX_CFG_LINE_LENGTH, define('MAX_CFG_FILE_LINE_LENGTH'));
  });

  it('mirrors the clip-length and sample-rate bounds the firmware clamps against', () => {
    assert.equal(AUDIO_MIN_CLIP_LENGTH_SECONDS, define('AUDIO_MIN_CLIP_LENGTH_SECONDS'));
    assert.equal(AUDIO_MAX_CLIP_LENGTH_SECONDS, define('AUDIO_MAX_CLIP_LENGTH_SECONDS'));
    assert.equal(AUDIO_MIN_SAMPLING_RATE_HZ, define('AUDIO_MIN_SAMPLING_RATE_HZ'));
    assert.equal(AUDIO_MAX_SAMPLING_RATE_HZ, define('AUDIO_MAX_SAMPLING_RATE_HZ'));
  });

  it('offers no sample rate the firmware would clamp', () => {
    for (const rate of AUDIO_SAMPLE_RATES_HZ) {
      assert.ok(
        rate >= AUDIO_MIN_SAMPLING_RATE_HZ && rate <= AUDIO_MAX_SAMPLING_RATE_HZ,
        `${rate} Hz is outside what the device accepts`,
      );
    }
  });

  it('tracks the true device label ceiling', () => {
    assert.equal(DEVICE_LABEL_FIRMWARE_MAX_LEN, define('MAX_DEVICE_LABEL_LEN'));
  });

  it('keeps the product label cap within what the device can hold', () => {
    // 15 is a product decision, not a hardware limit — it may be raised up to the
    // firmware ceiling, but never above it.
    assert.ok(
      DEVICE_LABEL_MAX_LEN <= DEVICE_LABEL_FIRMWARE_MAX_LEN,
      `DEVICE_LABEL_MAX_LEN (${DEVICE_LABEL_MAX_LEN}) exceeds what the device can store ` +
        `(${DEVICE_LABEL_FIRMWARE_MAX_LEN})`,
    );
  });

  it('tracks the audio constants', () => {
    assert.equal(AUDIO_DEFAULT_SAMPLE_RATE_HZ, define('AUDIO_DEFAULT_SAMPLING_RATE_HZ'));
    assert.equal(AUDIO_DEFAULT_CLIP_LENGTH_SECONDS, define('AUDIO_DEFAULT_CLIP_LENGTH_SECONDS'));
    assert.equal(AUDIO_NUM_CHANNELS, define('AUDIO_NUM_CHANNELS'));
    assert.equal(AUDIO_BUFFER_MAX_SAMPLES, define('AUDIO_BUFFER_MAX_SAMPLES'));
    assert.equal(AUDIO_BUFFER_MAX_SIZE_BYTES, define('AUDIO_BUFFER_MAX_SIZE'));
  });

  it('tracks the Opus constants', () => {
    assert.equal(OPUS_REQUIRED_SAMPLE_RATE_HZ, define('OPUS_REQUIRED_SAMPLE_RATE_HZ'));
    assert.equal(OPUS_DEFAULT_BITRATE, define('OPUS_DEFAULT_ENCODING_BITRATE'));
    assert.equal(OPUS_MAX_BITRATE, define('OPUS_MAX_ENCODING_BITRATE'));
    assert.equal(OPUS_MS_PER_FRAME, define('OPUS_MS_PER_FRAME'));
  });

  it('tracks the IMU constants', () => {
    assert.equal(IMU_DEFAULT_SAMPLE_RATE_HZ, define('IMU_DEFAULT_SAMPLING_RATE_HZ'));
    // No longer derived from the audio buffer: the firmware sets it outright so that one
    // buffer spans a whole clip and the IMU flush can ride along with an audio flush.
    assert.equal(IMU_BUFFER_MAX_SAMPLES, define('IMU_BUFFER_MAX_SAMPLES'));
  });

  it('tracks the storage constants that govern card writes', () => {
    assert.equal(WAV_STAGING_BUFFER_SIZE_BYTES, define('WAV_STAGING_BUFFER_SIZE'));
    assert.equal(SD_CARD_ALLOCATION_UNIT_BYTES, define('SD_CARD_ALLOCATION_UNIT_BYTES'));
    // The allocation-unit advice assumes every candidate it offers is a power of two,
    // which exFAT requires, and that the device default is one of them.
    assert.ok(ALLOCATION_UNIT_CHOICES_BYTES.includes(SD_CARD_ALLOCATION_UNIT_BYTES as never));
  });

  it('tracks the device behavior constants', () => {
    assert.equal(BATTERY_DEFAULT_LOW_MV, define('BATTERY_DEFAULT_LOW_LEVEL_MV'));
    assert.equal(MAGNET_DEFAULT_VALIDATION_MS, define('MAGNET_FIELD_DEFAULT_VALIDATION_LENGTH_MS'));
    assert.equal(MIN_LOG_DATA_INTERVAL_SECONDS, define('MIN_LOG_DATA_INTERVAL_SECONDS'));
    assert.equal(NUM_HOURS_PER_AUDIO_DIRECTORY, define('NUM_HOURS_PER_AUDIO_DIRECTORY'));
  });

  it('tracks the file names', () => {
    assert.equal(CONFIG_FILE_NAME, snapshot.stringDefines.CONFIG_FILE_NAME);
    assert.equal(LOG_FILE_NAME, snapshot.stringDefines.LOG_FILE_NAME);
  });

  it('tracks the max-frequency clamp headroom', () => {
    assert.equal(MAX_FREQUENCY_HEADROOM_HZ, snapshot.maxFrequencyHeadroomHz);
  });

  it('tracks the digipot resolution that quantizes the trigger threshold', () => {
    assert.equal(TRIGGER_DIGIPOT_STEPS, snapshot.triggerDigipotSteps);
  });

  it('tracks the IMU FIFO depth used by the power model', () => {
    assert.equal(IMU_FIFO_SAMPLES, loadPlannerSnapshot().calculations.imuFifoSamples);
  });
});

describe('enum values match the firmware, including order', () => {
  const snapshot = loadFirmwareSnapshot();

  it('audio recording modes', () => {
    assert.deepEqual(Object.keys(AUDIO_RECORDING_MODES), snapshot.enums.audio_recording_mode_t);
  });

  it('IMU recording modes', () => {
    assert.deepEqual(Object.keys(IMU_RECORDING_MODES), snapshot.enums.imu_recording_mode_t);
  });

  it('time scales', () => {
    assert.deepEqual(Object.keys(TIME_SCALES), snapshot.enums.time_scale_t);
  });

  it('microphone types', () => {
    // The firmware enum is MIC_ANALOG / MIC_DIGITAL; the .cfg stores ANALOG / DIGITAL.
    assert.deepEqual(
      Object.keys(MIC_TYPES).map((key) => `MIC_${key}`),
      snapshot.enums.audio_mic_type_t,
    );
  });
});

describe('config keys stay in step with parse_line()', () => {
  const snapshot = loadFirmwareSnapshot();

  /**
   * Keys we write for the dashboard's own benefit; `parse_line()` has no branch for
   * any of them, so the device ignores them entirely.
   *
   * PHASED_DEPLOYMENT is the surprising one: the firmware never reads it. Phasing is
   * inferred purely from whether a `[PHASE]` carries its own PHASE_START_TIME and
   * PHASE_END_TIME — absent those, parse_line() leaves the phase seeded with the full
   * deployment span. This is why the serializer must omit phase times on a
   * single-phase deployment and emit them on every phase of a multi-phase one:
   * the boolean is decoration, the times are the mechanism.
   *
   * DST_ADJUSTED records that the serializer split phases for daylight saving, so the
   * parser can rejoin them. The firmware has no use for it: it simply runs the phases.
   */
  const DASHBOARD_ONLY = ['DEVICE_TIMEZONE', 'DST_ADJUSTED', 'PHASE_NAME', 'PHASED_DEPLOYMENT'];

  it('handles every key the firmware handles', () => {
    const missing = snapshot.configKeyOrder.filter((key) => !KEY_ORDER.includes(key as never));
    assert.deepEqual(missing, [], `the firmware parses keys this package ignores: ${missing}`);
  });

  it('adds nothing beyond the documented dashboard-only keys', () => {
    const extra = KEY_ORDER.filter((key) => !snapshot.configKeyOrder.includes(key));
    assert.deepEqual(
      extra.slice().sort(),
      DASHBOARD_ONLY.slice().sort(),
      'a key here is unknown to the firmware and would be silently ignored on device',
    );
  });

  it('preserves the firmware ordering for every shared key', () => {
    // Matching is by prefix in a fixed if/else-if chain, so relative order matters
    // wherever one key is a prefix of another.
    const shared = KEY_ORDER.filter((key) => snapshot.configKeyOrder.includes(key));
    assert.deepEqual(shared, snapshot.configKeyOrder);
  });
});

describe('the log parser stays in step with the firmware event contract', () => {
  const snapshot = loadFirmwareSnapshot();

  /**
   * The EVT codes and field keys exist precisely so the dashboard never has to match on
   * English phrasing. That only holds if the two sides stay in step, so a firmware
   * change to either must fail here rather than silently break log parsing.
   */
  /**
   * Emitted on EVERY event when the clock is valid, so it is checked once here rather
   * than repeated in each entry below.
   */
  const UNIVERSAL_FIELDS = ['t'];

  const CONSUMED_FIELDS: Record<string, string[]> = {
    SOLAR_SCHEDULE: ['windows', 'first_start', 'first_end'],
    // A solar window that ended before it started on that day, and was skipped.
    SOLAR_REVERSED: ['windows'],
    TELEM: [
      // Carries its own timestamp, which is preferred over the line prefix.
      'time',
      'batt_mv', 'temp_c', 'lat', 'lon', 'alt', 'leds', 'vhf', 'sd_free_mb',
      // The firmware counts recoveries rather than raw errors: a write that failed and
      // then succeeded on a reopen is a different event from one that lost data.
      'sd_write_fail', 'sd_reopen', 'sd_remount', 'imu_dropped', 'audio_dropped',
      'audio_buffers', 'dcmp', 'icache_hit_pct',
      // The device's own measurement of the rate it is actually running at.
      'rate_est_hz', 'rate_settled',
    ],
    MIC_HEALTH: ['result', 'rms', 'peak', 'min', 'max', 'mean', 'samples', 'dc_offset'],
    MIC_CHECK: ['type', 'dc_offset', 'nominal', 'tolerance', 'result'],
    BOOT: ['fw', 'resets', 'epoch', 'last_stop'],
    // CORRECTED is the state worth acting on: the file parsed, but the device had to
    // change something to make it usable.
    CONFIG: ['result', 'phases'],
    ACTIVATED: ['activation'],
    DEACTIVATED: ['reason'],
    PHASE_START: ['phase'],
    // Why a recording phase stopped, shown on the review timeline. `code` is the same
    // reason as a raw number, which adds nothing once the name is rendered.
    PHASE_END: ['reason'],
    AUDIO_FILTER: ['type', 'low_hz', 'high_hz'],
    BATTERY_LOW: ['batt_mv', 'cutoff_mv'],
    CLOCK_SYNC: ['source', 'before', 'after'],
    // The results file carries the latest run; these give every run, which is what
    // shows a subsystem degrading between deployments.
    SELF_TEST_START: ['fw'],
    SELF_TEST_END: ['result', 'failed_subsystem'],
    // Every measurement field is displayed generically, so the list is the full set.
    SELF_TEST_DETAIL: [
      'check', 'result', 'phase', 'requested_hz', 'actual_hz', 'samples_per_buffer',
      'buffer_ms', 'rms', 'peak', 'value', 'dc_offset', 'bytes', 'magnitude_mg',
      'silent', 'temp_c', 'samples', 'before', 'after', 'mv', 'c',
    ],
    // Logged when a boot comes up clean after a failure — a blip, not a lost deployment.
    RECOVERED: ['from'],
    // The clock was lost and rebuilt from evidence on the card, which limits how far any
    // timestamp before that point can be trusted.
    CLOCK_RECOVERED: ['source', 'mram', 'dev', 'audio', 'chosen'],
    // Where the firmware crashed and what the processor said about it.
    HARD_FAULT: ['address', 'cfsr', 'teardown'],
    PDM_CLOCK: [
      'requested_hz', 'cko_hz', 'nominal_hz',
      // The measurement shape of the same event.
      'phase', 'measured_rate_hz', 'nominal_rate_hz',
    ],
  };

  /**
   * Fields the firmware emits that the dashboard deliberately does not read.
   *
   * This list is the other half of the ledger. Between it and CONSUMED_FIELDS every
   * field the firmware emits must be accounted for, so a field added on the device
   * fails here until somebody decides what it is for. Silence would otherwise be
   * indistinguishable from "nobody has looked at this yet" — which is exactly how
   * TELEM gained six fields without the dashboard noticing.
   *
   * An entry here is a decision, not a backlog: say why it is ignored.
   */
  const IGNORED_FIELDS: Record<string, string[]> = {
    // Build provenance duplicated from _a3em.dev, which the dashboard reads instead.
    BOOT: [
      'hw', 'built',
      // Raw scratch registers, for a firmware bug report rather than a deployment review.
      'scratch0', 'scratch1',
      // The bootloader bits masked out of scratch0 — same category, one level finer.
      'canary',
    ],
    // The fallback window count, which only repeats what `windows=0` already said.
    SOLAR_SCHEDULE: ['fallback'],
    // The reason as a raw number, behind the name that is already rendered.
    PHASE_END: ['code'],
    // Raw cache counters behind the percentage, which is the only part worth showing.
    TELEM: ['icache_accesses', 'icache_served'],
    // Divider settings behind the achieved rate. Useful in a firmware bug report, not
    // to anyone reviewing a deployment.
    PDM_CLOCK: [
      'source_hz', 'divmclkq', 'mclkdiv', 'sincrate', 'osr',
      // Reference-clock detail behind the measured rate.
      'measured_source_hz', 'nominal_source_hz', 'window_centis',
    ],

  };

  it('emits every event code the parser consumes', () => {
    const missing = Object.keys(CONSUMED_FIELDS).filter((code) => !(code in snapshot.logEvents));
    assert.deepEqual(missing, [], `the parser reads events the firmware no longer emits: ${missing}`);
  });

  it('accounts for every field the firmware emits', () => {
    // The check that catches ADDITIONS. The one below catches removals; without both,
    // a firmware that only ever gains fields drifts away silently.
    const unaccounted: string[] = [];
    for (const [code, emitted] of Object.entries(snapshot.logEvents)) {
      const known = new Set([
        ...UNIVERSAL_FIELDS,
        ...(CONSUMED_FIELDS[code] ?? []),
        ...(IGNORED_FIELDS[code] ?? []),
      ]);
      for (const field of emitted) {
        if (!known.has(field)) unaccounted.push(`${code}.${field}`);
      }
    }
    assert.deepEqual(
      unaccounted,
      [],
      `the firmware emits fields the dashboard has never decided about: ${unaccounted.join(', ')}. ` +
        'Read them in log-file.ts and add them to CONSUMED_FIELDS, or record why they are ignored ' +
        'in IGNORED_FIELDS.',
    );
  });

  it('accounts for every event code the firmware emits', () => {
    const known = new Set([...Object.keys(CONSUMED_FIELDS), ...Object.keys(IGNORED_FIELDS)]);
    const unaccounted = Object.keys(snapshot.logEvents).filter((code) => !known.has(code));
    assert.deepEqual(
      unaccounted,
      [],
      `the firmware emits event codes the dashboard has never decided about: ${unaccounted.join(', ')}`,
    );
  });

  it('emits every field the parser reads', () => {
    for (const [code, fields] of Object.entries(CONSUMED_FIELDS)) {
      const emitted = snapshot.logEvents[code] ?? [];
      const missing = fields.filter((field) => !emitted.includes(field));
      assert.deepEqual(missing, [], `EVT|${code} no longer emits: ${missing.join(', ')}`);
    }
  });

  it('records the self-test events the results reader depends on', () => {
    for (const code of ['SELF_TEST_START', 'SELF_TEST_END', 'SELF_TEST_DETAIL']) {
      assert.ok(code in snapshot.logEvents, `firmware no longer emits EVT|${code}`);
    }
  });
});

describe('measurements.ts agrees with the planner spreadsheet', () => {
  const snapshot = loadPlannerSnapshot();
  const { calculations, magnet } = snapshot;

  it('tracks the buffer geometry', () => {
    assert.equal(BUFFERS.audioDmaSamples.value, calculations.audioDmaBufferSamples);
    assert.equal(BUFFERS.sdAudioCacheBytes.value, calculations.sdAudioCacheBytes);
    assert.equal(BUFFERS.sdImuCacheSamples.value, calculations.sdImuCacheSamples);
    assert.equal(BUFFERS.imuFifoSamples.value, calculations.imuFifoSamples);
  });

  it('tracks the SD card currents and timings', () => {
    assert.equal(SD_CARD.writeCurrentMa.value, calculations.sdWriteCurrentMa);
    assert.equal(SD_CARD.activationCurrentMa.value, calculations.sdActivationCurrentMa);
    assert.equal(SD_CARD.sleepCurrentMa.value, calculations.sdSleepCurrentMa);
    assert.equal(SD_CARD.activationDurationMs.value, calculations.sdActivationDurationMs);
    assert.equal(SD_CARD.fatMaintenanceMs.value, calculations.sdFatMaintenanceMs);
  });

  it('tracks the MCU currents', () => {
    assert.equal(MCU.idleCurrentMa.value, calculations.mcuIdleCurrentMa);
    assert.equal(MCU.activeCurrentMa.value, calculations.mcuActiveCurrentMa);
  });

  it('tracks the magnetometer duty cycle', () => {
    assert.equal(MAGNET.measurementDurationMs.value, magnet.measurementDurationMs);
    assert.equal(MAGNET.measurementCurrentMa.value, magnet.measurementCurrentMa);
    assert.equal(MAGNET.idleCurrentMa.value, magnet.idleCurrentMa);
    assert.equal(MAGNET.sleepCurrentMa.value, magnet.sleepCurrentMa);
    assert.equal(MAGNET.activeWindowMs.value, calculations.magnetActiveWindowMs);
    assert.equal(MAGNET.sleepWindowMs.value, calculations.magnetSleepWindowMs);
  });

  it('tracks the microphone lookup table', () => {
    assert.deepEqual(
      Object.entries(MICROPHONE_CURRENT_MA).map(([name, m]) => [name, m.value]),
      snapshot.microphoneCurrentMa,
    );
  });

  it('tracks the IMU lookup table', () => {
    assert.deepEqual(
      Object.entries(IMU_CURRENT_MA).map(([rate, m]) => [Number(rate), m.value]),
      snapshot.imuCurrentMa,
    );
  });

  it('tracks the SD speed class table', () => {
    assert.deepEqual(Object.entries(SD_SPEED_CLASS_MB_PER_S), snapshot.sdSpeedClassMbPerS);
  });

  it('tracks the Opus encode costs', () => {
    assert.deepEqual(
      OPUS_ENCODE_MS_BY_BITRATE.map((row) => [row.bitrate / 1000, row.encodeMs]),
      snapshot.goldenOpus.map((row) => [row.bitrateKbps, row.encodeMsPerInterval]),
    );
  });

  it('tracks the WAV framing cost', () => {
    for (const row of snapshot.goldenWav) {
      assert.equal(
        WAV_PROCESSING_MS_PER_INTERVAL.value,
        row.processingMsPerInterval,
        `WAV processing cost differs at ${row.sampleRateHz} Hz`,
      );
    }
  });

  it('tracks the deployment defaults', () => {
    assert.equal(DEFAULTS.batteryCapacityMah, snapshot.plannerInputs.batteryCapacityMah);
    assert.equal(DEFAULTS.sdCardCapacityGb, snapshot.plannerInputs.sdCardCapacityGb);
    assert.equal(DEFAULTS.storedClipLengthSeconds, snapshot.plannerInputs.storedClipLengthSeconds);
    assert.equal(DEFAULTS.imuSampleRateHz, snapshot.plannerInputs.imuSampleRateHz);
    assert.equal(DEFAULT_MICROPHONE, snapshot.plannerInputs.microphone);
    assert.equal(DEFAULT_SD_SPEED_CLASS, snapshot.plannerInputs.sdSpeedClass);
  });
});

describe('the stop reasons stay in step with the firmware', () => {
  const snapshot = loadFirmwareSnapshot();

  /**
   * Reset reasons live in two C switch statements, not an enum, so nothing else in this
   * file would notice one being added. CYCLE appeared exactly that way and read as
   * "stopped for an unrecorded reason" on every card until it was spotted by hand.
   */
  it('explains every reason the firmware can report', () => {
    const missing = snapshot.resetReasons.all.filter(
      (reason) => !(reason in DEACTIVATION_REASON_LABELS),
    );
    assert.deepEqual(
      missing,
      [],
      `the firmware reports reasons the dashboard cannot explain: ${missing.join(', ')}. ` +
        'Add them to DEACTIVATION_REASON_LABELS in device-info.ts.',
    );
  });

  it('does not invent reasons the firmware never reports', () => {
    const known = new Set([...snapshot.resetReasons.all, 'UNKNOWN']);
    const invented = Object.keys(DEACTIVATION_REASON_LABELS).filter((r) => !known.has(r));
    assert.deepEqual(invented, [], `explained but never emitted: ${invented.join(', ')}`);
  });

  it('agrees with the firmware about which restarts are failures', () => {
    // A battery reaching its cutoff reads like a fault and is not one: the deployment
    // ended exactly as configured. Taking the firmware's own list avoids that argument.
    assert.deepEqual([...FIRMWARE_FAULT_REASONS].sort(), snapshot.resetReasons.faults);
  });
});

describe('the extractor itself', () => {
  /**
   * A broken extractor and a stale snapshot look identical from outside.
   *
   * `sync:check` only re-runs the extractor and diffs the result against the committed
   * file, so both sides move together: narrow what the extractor asks for, regenerate,
   * and the check still prints "OK: snapshot matches" while the coverage shrinks. The
   * extractor already refuses to emit a partial section — it exits non-zero on any name
   * it cannot resolve — which leaves exactly one way through: editing the request list.
   *
   * These floors are the guard. They are maintained BY HAND and deliberately not derived
   * from anything, so lowering one is a visible edit somebody has to justify, rather than
   * a side effect of regenerating.
   */
  const FLOORS = { numericDefines: 26, stringDefines: 2, enums: 4 } as const;
  const snapshot = loadFirmwareSnapshot();

  it('extracted everything it set out to extract', () => {
    for (const section of ['numericDefines', 'stringDefines', 'enums'] as const) {
      const found: Record<string, unknown> = snapshot[section];
      const missing = snapshot._requested[section].filter((name) => !(name in found));
      assert.deepEqual(
        missing,
        [],
        `the extractor asked for ${section} entries it did not produce: ${missing.join(', ')}`,
      );
    }
  });

  it('never asks the firmware for less than it used to', () => {
    for (const [section, floor] of Object.entries(FLOORS)) {
      const count = Object.keys(snapshot[section as keyof typeof FLOORS]).length;
      assert.ok(
        count >= floor,
        `the snapshot carries ${count} ${section} but this project has relied on at least ` +
          `${floor}. Something was dropped from the extractor's request list. If the removal ` +
          `is deliberate, lower the floor in the same commit and say why.`,
      );
    }
  });

  it('records which firmware files it read, so a moved file is not silently skipped', () => {
    assert.ok(snapshot._sourceFiles.length >= 5, 'the extractor read fewer firmware files than expected');
  });
});

describe('the key-matching order the firmware actually runs', () => {
  /**
   * `parse_line()` is a function this package reimplements, and nothing compared them.
   *
   * The firmware matches by PREFIX down a fixed if/else chain, so which handler a key
   * reaches is decided by ORDER, not by the set of keys. The existing tests check that
   * the set matches and that OUR order is self-consistent — neither would notice the
   * firmware's chain being reordered underneath us. That failure is silent and one-sided:
   * the device starts filing a value under the wrong key while the dashboard keeps
   * reading it correctly, so the card and the deployment disagree with nothing to show
   * for it.
   *
   * So this compares behavior. For every key, work out which handler each chain selects
   * and require the two answers to be the same.
   */
  const snapshot = loadFirmwareSnapshot();

  /** The key an if/else prefix chain reaches first for a given line. */
  const handlerFor = (chain: readonly string[], line: string): string | undefined =>
    chain.find((key) => line.startsWith(key));

  it('resolves every firmware key to the same handler as the device', () => {
    const ours = KEY_ORDER.filter((key) => snapshot.configKeyOrder.includes(key));
    for (const key of snapshot.configKeyOrder) {
      const line = `${key} = "x"`;
      assert.equal(
        handlerFor(ours, line),
        handlerFor(snapshot.configKeyOrder, line),
        `"${key}" reaches a different handler here than it does on the device`,
      );
    }
  });

  it('keeps the firmware chain itself free of shadowed keys', () => {
    // Not a statement about this package: if the FIRMWARE ever orders a short key ahead
    // of a longer one it prefixes, the device misreads its own configuration, and the
    // dashboard agreeing with the file on disk would hide it rather than reveal it.
    for (let i = 0; i < snapshot.configKeyOrder.length; i++) {
      for (let j = i + 1; j < snapshot.configKeyOrder.length; j++) {
        assert.ok(
          !snapshot.configKeyOrder[j].startsWith(snapshot.configKeyOrder[i]),
          `the FIRMWARE tests "${snapshot.configKeyOrder[i]}" before ` +
            `"${snapshot.configKeyOrder[j]}", which it prefixes — the device will match the ` +
            'wrong key. This is a firmware bug, not a dashboard one.',
        );
      }
    }
  });
});

describe('prose that describes the firmware', () => {
  /**
   * Comments and messages here name firmware functions as their authority — `FIRMWARE:`
   * annotations, and user-facing text explaining why a setting behaves as it does. None
   * of it is checked by anything: a renamed or deleted function leaves the sentence
   * intact and still sounding definitive.
   *
   * This does not verify that a claim is TRUE — nothing mechanical can. It verifies the
   * thing the claim points at still exists, which is the cheap half and the half that
   * rots first.
   */
  const snapshot = loadFirmwareSnapshot();
  const known = new Set([...snapshot.firmwareFunctions, ...snapshot.desktopFunctions]);

  /** Names that look like firmware calls but are ours, the SDK's, or the C library's. */
  const NOT_FIRMWARE = new Set([
    'getFile', 'toFixed', 'toISOString', 'toLocaleString', 'formatToParts', 'padStart',
    'requestAnimationFrame', 'createObjectURL', 'revokeObjectURL', 'getBoundingClientRect',
    'querySelector', 'addEventListener', 'removeEventListener', 'setProperty',
  ]);

  const sourceFiles = (): Array<{ path: string; text: string }> => {
    // Relative to dist/, where the compiled tests run: '../src/' is this package's source
    // and '../../../app/src/' is the app's. Pointing at './' would scan dist itself and
    // flag generated .d.ts content.
    const roots = [
      new URL('../src/', import.meta.url),
      new URL('../../../app/src/', import.meta.url),
    ];
    const out: Array<{ path: string; text: string }> = [];
    const walk = (dir: URL) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
        if (entry.isDirectory()) walk(child);
        else if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')) {
          out.push({ path: fileURLToPath(child), text: readFileSync(child, 'utf8') });
        }
      }
    };
    for (const root of roots) {
      try {
        walk(root);
      } catch {
        // The app sources are not present when the package is built alone.
      }
    }
    return out;
  };

  it('names only firmware functions that still exist', () => {
    const stale: string[] = [];
    for (const { path, text } of sourceFiles()) {
      for (const match of text.matchAll(/\b([a-z_][a-z0-9_]{5,})\(\)/g)) {
        const name = match[1];
        if (NOT_FIRMWARE.has(name) || !name.includes('_')) continue;
        // Only snake_case names are firmware; ours are camelCase by convention.
        if (!known.has(name)) {
          const line = text.slice(0, match.index).split('\n').length;
          stale.push(`${path.split('/src/')[1] ?? path}:${line} names ${name}()`);
        }
      }
    }
    assert.deepEqual(
      stale,
      [],
      `these name a firmware function that no longer exists — the sentence around each is ` +
        `describing behavior that may have changed:\n  ${stale.join('\n  ')}`,
    );
  });

  it('reads enough of the codebase to be worth trusting', () => {
    // A guard that silently stops finding files passes forever. This is the extractor
    // self-check applied to the guard itself.
    const files = sourceFiles();
    assert.ok(files.length >= 40, `only scanned ${files.length} source files`);
    const mentions = files.reduce(
      (total, file) => total + [...file.text.matchAll(/\b[a-z_][a-z0-9_]{5,}\(\)/g)].length,
      0,
    );
    assert.ok(mentions >= 20, `only found ${mentions} function mentions to check`);
  });
});

describe('claims that were once wrong and must stay gone', () => {
  /**
   * A ratchet, not a proof.
   *
   * Each entry here was a specific, confident sentence that turned out to be false, and
   * nothing mechanical would have caught any of them — no constant moved, no grammar
   * changed. The only defense against the same sentence coming back is to name it.
   *
   * Add to this when a wrong claim is removed. Do not remove from it.
   */
  const RETIRED: Array<{ pattern: RegExp; why: string }> = [
    {
      pattern: /pre-2026\.08\.1|Legacy \(pre-/,
      why: 'labels pinned to a version that has since moved; the profiles are named, not numbered',
    },
    {
      pattern: /limit \$\{MAX_CFG_LINE_LENGTH\}\)/,
      why: 'the limit on CONTENT is one less than the buffer — an 80-byte line never terminates',
    },
    {
      pattern: /Nothing is read from the card until you choose a recording/,
      why: 'the listen view now opens the first recording by itself',
    },
    {
      pattern: /restarts and self-tests, in order/,
      why: 'missing its Oxford comma; the house style is to use one',
    },
  ];

  it('has not let a retired claim back in', () => {
    const roots = [new URL('../src/', import.meta.url), new URL('../../../app/src/', import.meta.url)];
    const offenders: string[] = [];
    const walk = (dir: URL) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
        if (entry.isDirectory()) walk(child);
        else if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')) {
          const text = readFileSync(child, 'utf8');
          for (const { pattern, why } of RETIRED) {
            if (pattern.test(text)) offenders.push(`${fileURLToPath(child).split('/src/')[1]}: ${why}`);
          }
        }
      }
    };
    for (const root of roots) {
      try {
        walk(root);
      } catch {
        // The app sources are not present when the package is built alone.
      }
    }
    assert.deepEqual(offenders, [], `a claim that was removed for being wrong has come back:\n  ${offenders.join('\n  ')}`);
  });
});
