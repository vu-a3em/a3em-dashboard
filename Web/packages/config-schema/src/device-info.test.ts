import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cardFirmwareProfile,
  DEACTIVATION_REASON_LABELS,
  parseDeviceInfo,
  targetFirmwareProfile,
  UNPLANNED_STOP_REASONS,
  type DeactivationReason,
} from './device-info.js';
import { FIRMWARE_CURRENT, FIRMWARE_LEGACY, FIRMWARE_PROFILES } from './firmware-profile.js';

const MODERN = [
  'FW_VERSION = "2026.08.1+d16593d"',
  'HW_REVISION = "A"',
  'DEVICE_UID = "C3:1A:5A:B9:0C:04"',
  'LAST_TIMESTAMP = "1770368400"',
  '',
].join('\n');

describe('which firmware to reason about', () => {
  /**
   * The distinction that matters: what WROTE the card, versus what a new configuration
   * will RUN on. Conflating them made the integrity check flag every WAV on a legacy
   * card as truncated, because it stopped allowing the four-byte chunk-size bug that
   * older firmware always produced.
   */
  it('reads a card with no device info as legacy', () => {
    // 2026.08.1 writes _a3em.dev at every boot, so its absence is positive evidence
    // that the card predates it — not merely a lack of information.
    assert.equal(cardFirmwareProfile(null).id, FIRMWARE_LEGACY.id);
    assert.equal(cardFirmwareProfile(null).capabilities.correctWavChunkSize, false);
  });

  it('targets current firmware for a card with no device info', () => {
    // An old card going into a current device runs current firmware.
    assert.equal(targetFirmwareProfile(null).id, FIRMWARE_CURRENT.id);
  });

  it('uses the reported version for both once the card carries one', () => {
    const info = parseDeviceInfo(MODERN)!;
    assert.equal(cardFirmwareProfile(info).id, FIRMWARE_CURRENT.id);
    assert.equal(targetFirmwareProfile(info).id, FIRMWARE_CURRENT.id);
  });

  it('expects the chunk-size allowance only on legacy cards', () => {
    assert.equal(cardFirmwareProfile(null).capabilities.correctWavChunkSize, false);
    assert.equal(cardFirmwareProfile(parseDeviceInfo(MODERN)).capabilities.correctWavChunkSize, true);
  });
});

describe('why the device stopped', () => {
  const info = (reason: string) =>
    parseDeviceInfo(`FW_VERSION = "2026.08.2"\nDEVICE_UID = "AA:BB"\nLAST_STOP_REASON = "${reason}"\n`)!;

  it('understands the strings the firmware actually writes', () => {
    // These are reset_reason_name()'s own spellings. A friendlier vocabulary of our own
    // meant every real card coerced to UNKNOWN and reported "stopped for an unrecorded
    // reason" — hiding a reason the device had gone to the trouble of recording.
    assert.equal(info('MAGNET-OFF').lastDeactivationReason, 'MAGNET-OFF');
    assert.equal(info('BATTERY-LOW').lastDeactivationReason, 'BATTERY-LOW');
    assert.equal(info('HARD-FAULT').lastDeactivationReason, 'HARD-FAULT');
    assert.equal(info('PERIPH-TIMEOUT').lastDeactivationReason, 'PERIPH-TIMEOUT');
  });

  it('gives every one of them a plain-language explanation', () => {
    for (const reason of Object.keys(DEACTIVATION_REASON_LABELS)) {
      assert.ok(DEACTIVATION_REASON_LABELS[reason as DeactivationReason].length > 10, reason);
    }
  });

  it('falls back rather than inventing a reason it does not recognise', () => {
    assert.equal(info('SOMETHING-NEW').lastDeactivationReason, 'UNKNOWN');
  });

  it('counts a magnet switch-off and a finished phase as planned endings', () => {
    // Both are how a deployment is supposed to end. Only the rest cost recordings.
    assert.ok(!UNPLANNED_STOP_REASONS.has('MAGNET-OFF'));
    assert.ok(!UNPLANNED_STOP_REASONS.has('PHASE-DONE'));
    assert.ok(UNPLANNED_STOP_REASONS.has('BATTERY-LOW'));
    assert.ok(UNPLANNED_STOP_REASONS.has('HARD-FAULT'));
  });
});

describe('the device file after the 2026.08.2 rename', () => {
  it('reads the current key name', () => {
    const info = parseDeviceInfo(
      'FW_VERSION = "2026.08.2"\nDEVICE_UID = "AA:BB"\nLAST_STOP_REASON = "HARD-FAULT"\n',
    )!;
    assert.equal(info.lastDeactivationReason, 'HARD-FAULT');
  });

  it('reports whether the device recovered from that stop', () => {
    const base = 'FW_VERSION = "2026.08.2"\nDEVICE_UID = "AA:BB"\nLAST_STOP_REASON = "HARD-FAULT"\n';
    assert.equal(parseDeviceInfo(base + 'LAST_STOP_RECOVERED = "True"\n')!.recoveredFromLastStop, true);
    assert.equal(parseDeviceInfo(base + 'LAST_STOP_RECOVERED = "False"\n')!.recoveredFromLastStop, false);
  });

  it('says nothing about recovery on a card that never reported it', () => {
    const info = parseDeviceInfo('FW_VERSION = "2026.08.1"\nDEVICE_UID = "AA:BB"\n')!;
    assert.equal(info.recoveredFromLastStop, null);
  });
});

describe('which firmware wrote a card, with only two profiles', () => {
  const dev = (extra = '') =>
    parseDeviceInfo(`FW_VERSION = "2026.08.24+nogit"\nDEVICE_UID = "AA:BB"\n${extra}`)!;

  it('treats any reported version as the current firmware', () => {
    // Pinning profiles to release numbers meant every new build looked unrecognised and
    // silently fell back to a stale entry. Only firmware that writes a version at all
    // reports one, so the version identifies the build without selecting behaviour.
    assert.equal(dev().firmwareProfile.id, FIRMWARE_CURRENT.id);
    assert.equal(cardFirmwareProfile(dev()).id, FIRMWARE_CURRENT.id);
  });

  it('still records the exact version, which is how a card is traced to a build', () => {
    assert.equal(dev().firmwareVersion, '2026.08.24+nogit');
  });

  it('reads a card with no device file as legacy', () => {
    assert.equal(cardFirmwareProfile(null).id, FIRMWARE_LEGACY.id);
  });

  it('offers exactly two profiles', () => {
    assert.equal(FIRMWARE_PROFILES.length, 2);
  });
});
