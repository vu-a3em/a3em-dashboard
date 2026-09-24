import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { defaultConfig, defaultPhase } from './defaults.js';
import { serializeConfig } from './serialize.js';
import { fromZonedInput } from './timezone.js';
import type { DeploymentConfig } from './types.js';

/**
 * What this package writes, against what the tool it replaces writes.
 *
 * `Python/dashboard` and this package produce the same `_a3em.cfg`, and where they
 * disagree one of them is wrong about what reaches the device. Those disagreements used
 * to live only in a findings document, which cannot tell you when it has gone stale —
 * the Python tool could be fixed tomorrow and the document would carry on describing a
 * defect that no longer exists.
 *
 * So each one is pinned. Two flavors:
 *
 *   AGREES   — both tools produce the same line. A failure means one of them moved.
 *   DIVERGES — they differ, and the difference is recorded with its reason. A failure
 *              here is GOOD NEWS: somebody fixed the Python tool, and the finding that
 *              described the gap can be retired.
 *
 * The ledger is closed at both ends: a divergence that is not listed fails too, so a new
 * disagreement cannot appear unnoticed.
 */

interface ParitySnapshot {
  writtenAt: string;
  writtenAtLater: string;
  lines: string[];
  linesWrittenLater: string[];
  deployment: Record<string, string | number | boolean>;
  phase: Record<string, string | number | string[]>;
}

const snapshot: ParitySnapshot = JSON.parse(
  readFileSync(new URL('../../../reference/desktop-parity.json', import.meta.url), 'utf8'),
);

/** The same deployment the Python tool was driven with, expressed for this package. */
function parityConfig(): DeploymentConfig {
  const d = snapshot.deployment as Record<string, string & number>;
  const p = snapshot.phase as Record<string, string & number>;
  const timezone = String(d.device_timezone);
  return {
    ...defaultConfig(timezone),
    deviceLabel: String(d.device_label),
    timezone,
    setRtcAtMagnetDetect: d.set_rtc_at_magnet_detect === 'True',
    startTime: fromZonedInput(`${d.deployment_start_date}T${d.deployment_start_time}`, timezone),
    endTime: fromZonedInput(`${d.deployment_end_date}T${d.deployment_end_time}`, timezone),
    gpsAvailable: d.gps_available === 'True',
    awakeOnMagnet: d.awake_on_magnet === 'True',
    ledsEnabled: d.leds_enabled === 'True',
    ledsActiveSeconds: Number(d.leds_active_seconds),
    micType: 'DIGITAL',
    micAmplificationDb: Number(d.mic_amplification_level_db),
    batteryLowMv: Number(d.battery_low_mv),
    magnetValidationMs: Number(d.magnetic_field_validation_length_ms),
    forbidDeactivationSeconds: Number(d.forbid_deactivation_seconds),
    vhfMode: 'NEVER',
    vhfStartTime: fromZonedInput(`${d.vhf_start_date}T${d.vhf_start_time}`, timezone),
    isPhased: false,
    phases: [
      {
        ...defaultPhase(String(p.name)),
        audioRecordingMode: 'CONTINUOUS',
        audioSampleRateHz: Number(p.audio_sampling_rate),
        audioClipLengthSeconds: Number(p.audio_clip_length),
        maxAudioClips: Number(p.max_audio_clips),
        maxClipsTimeScale: 'HOURS',
        audioTriggerThreshold: Number(p.audio_trigger_threshold),
        audioTriggerInterval: Number(p.audio_trigger_interval),
        audioTriggerIntervalTimeScale: 'MINUTES',
        imuRecordingMode: 'AUDIO',
        imuSampleRateHz: Number(p.imu_sampling_rate),
        imuTriggerThresholdMg: Number(p.imu_trigger_threshold),
        silenceThreshold: Number(p.silence_threshold),
        minFrequencyHz: Number(p.min_frequency),
        maxFrequencyHz: Number(p.max_frequency),
        useOpusEncoding: false,
        opusBitrate: Number(p.opus_bitrate),
      },
    ],
  };
}

const toMap = (lines: string[]): Map<string, string> =>
  new Map(
    lines
      .filter((line) => line.includes(' = '))
      .map((line) => [line.slice(0, line.indexOf(' =')), line.slice(line.indexOf('= ') + 2)]),
  );

/**
 * Keys the two tools do not agree on.
 *
 * EMPTY, and that is the finding. Every divergence this suite was built to pin has been
 * closed by fixing the desktop tool: it now takes its UTC offset at the deployment rather
 * than at the moment of writing, omits the keys the device ignores, writes FILTER_TYPE so
 * a deployment cannot inherit the previous one's filter, and formats numbers the same way.
 *
 * Leave the machinery in place. The ledger below fails on any NEW disagreement, which is
 * what stops the two drifting apart again — and an entry here would once more mean "one of
 * these two tools is wrong about what reaches the device".
 */
const DIVERGENCES: Record<string, { theirs: string | null; ours: string | null; why: string }> = {};

describe('parity with the desktop dashboard', () => {
  const theirs = toMap(snapshot.lines);
  const ours = toMap(serializeConfig(parityConfig()).split('\n'));
  const everyKey = [...new Set([...theirs.keys(), ...ours.keys()])].sort();

  it('AGREES on every key not recorded as a divergence', () => {
    const broken: string[] = [];
    for (const key of everyKey) {
      if (key in DIVERGENCES) continue;
      if (theirs.get(key) !== ours.get(key)) {
        broken.push(`${key}: desktop ${theirs.get(key)} vs ours ${ours.get(key)}`);
      }
    }
    assert.deepEqual(broken, [], `these agreed before and no longer do:\n  ${broken.join('\n  ')}`);
  });

  it('DIVERGES exactly as recorded, and nowhere else', () => {
    const unexpected: string[] = [];
    const healed: string[] = [];
    for (const [key, expected] of Object.entries(DIVERGENCES)) {
      const t = theirs.get(key) ?? null;
      const o = ours.get(key) ?? null;
      if (t === o) {
        healed.push(`${key} — the two tools now agree. ${expected.why}`);
      } else if (t !== expected.theirs || o !== expected.ours) {
        unexpected.push(`${key}: expected desktop ${expected.theirs} / ours ${expected.ours}, got ${t} / ${o}`);
      }
    }
    assert.deepEqual(
      healed,
      [],
      'GOOD NEWS — a recorded divergence has closed. Someone changed one of the two tools. ' +
        `Remove the entry from DIVERGENCES and retire the matching finding:\n  ${healed.join('\n  ')}`,
    );
    assert.deepEqual(unexpected, [], `a recorded divergence changed shape:\n  ${unexpected.join('\n  ')}`);
  });

  it('lists a reason for every divergence, and says what an omission relies on', () => {
    for (const [key, entry] of Object.entries(DIVERGENCES)) {
      assert.ok(entry.why.length > 30, `${key} needs a real reason, not a label`);
      if (entry.ours === null) {
        assert.match(
          entry.why,
          /ignored|omitted|disabled|only consulted|IS the/,
          `${key} is omitted by this package — its reason must say what makes dropping it safe`,
        );
      }
    }
  });

  it('writes the same file whenever it is run', () => {
    /*
      This used to assert the opposite.

      The desktop tool derived DEVICE_UTC_OFFSET from `datetime.now()`, so the same
      deployment got +10 written in September and +11 written in December — and only one
      of those could be right for a January deployment. Now that it reads the offset at the
      deployment start, the write date must not change anything at all.

      Generated at two instants either side of a Sydney daylight-saving change, so a
      regression to write-time behavior shows up here rather than in the field.
    */
    const later = toMap(snapshot.linesWrittenLater);
    for (const key of new Set([...theirs.keys(), ...later.keys()])) {
      assert.equal(
        theirs.get(key),
        later.get(key),
        `${key} depends on when the file was written — the desktop tool has regressed to ` +
          'taking a value from the clock instead of from the deployment',
      );
    }
  });

  it('agrees on the offset the deployment actually runs in', () => {
    // January in Sydney is AEDT, +11 hours. Both tools must say so regardless of season.
    assert.equal(theirs.get('DEVICE_UTC_OFFSET'), '"39600"');
    assert.equal(ours.get('DEVICE_UTC_OFFSET'), '"39600"');
    assert.equal(theirs.get('DEVICE_UTC_OFFSET_HOUR'), ours.get('DEVICE_UTC_OFFSET_HOUR'));
  });

  it('has converged — every key the desktop tool writes, this package writes identically', () => {
    const everything = [...new Set([...theirs.keys(), ...ours.keys()])].sort();
    const differing = everything.filter((key) => theirs.get(key) !== ours.get(key));
    assert.deepEqual(differing, [], `the two tools disagree on: ${differing.join(', ')}`);
    assert.ok(everything.length >= 25, `only ${everything.length} keys were compared`);
  });
});
