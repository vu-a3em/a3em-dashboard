import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyProtocol,
  createProtocol,
  DEPLOYMENT_SPECIFIC_KEYS,
  matchesProtocol,
  STARTER_PROTOCOLS,
  updateProtocol,
} from './protocol.js';
import { defaultConfig, defaultPhase } from './defaults.js';
import { validateConfig } from './validate.js';
import { DEFAULT_FIRMWARE_PROFILE } from './firmware-profile.js';
import { serializeConfig } from './serialize.js';
import { parseConfig } from './parse.js';
import { AUDIO_SAMPLE_RATES_HZ } from './firmware-constants.js';
import type { DeploymentConfig } from './types.js';

const NOW = '2026-08-07T12:00:00.000Z';

function deployment(overrides: Partial<DeploymentConfig> = {}): DeploymentConfig {
  return {
    ...defaultConfig('America/Chicago', new Date('2026-04-01T00:00:00.000Z')),
    deviceLabel: 'BEAR-01',
    // A filled-in deployment, position included. A solar schedule needs one the way any
    // deployment needs a label: without it the device cannot compute sunrise and would run
    // its fallback windows every day, so `validateConfig` treats a missing position as an
    // error rather than letting a card go out that silently ignores its own schedule.
    latitude: 40.5,
    longitude: -105.1,
    ...overrides,
  };
}

describe('capturing a protocol', () => {
  it('keeps the recording settings', () => {
    const config = deployment({ micType: 'DIGITAL', batteryLowMv: 3400 });
    const protocol = createProtocol(config, { id: 'p1', name: 'Test', description: '', now: NOW });

    assert.equal(protocol.settings.micType, 'DIGITAL');
    assert.equal(protocol.settings.batteryLowMv, 3400);
    assert.equal(protocol.version, 1);
  });

  it('stores nothing that belongs to one deployment', () => {
    // Carrying a previous deployment's dates onto a new one is the exact mistake
    // protocols exist to prevent, so this is the property that matters most here.
    const protocol = createProtocol(deployment(), { id: 'p1', name: 'T', description: '', now: NOW });
    for (const key of DEPLOYMENT_SPECIFIC_KEYS) {
      assert.ok(!(key in protocol.settings), `${key} must not be stored in a protocol`);
    }
  });

  it('strips absolute phase boundaries, keeping only their proportions', () => {
    const config = deployment({
      startTime: '2026-04-01T00:00:00.000Z',
      endTime: '2026-04-11T00:00:00.000Z',
      isPhased: true,
      phases: [
        { ...defaultPhase('First'), startTime: '2026-04-01T00:00:00.000Z', endTime: '2026-04-06T00:00:00.000Z' },
        { ...defaultPhase('Second'), startTime: '2026-04-06T00:00:00.000Z', endTime: '2026-04-11T00:00:00.000Z' },
      ],
    });
    const protocol = createProtocol(config, { id: 'p1', name: 'T', description: '', now: NOW });

    assert.equal(protocol.settings.phases[0].startTime, undefined);
    assert.deepEqual(protocol.phaseSpans, [
      { startFraction: 0, endFraction: 0.5 },
      { startFraction: 0.5, endFraction: 1 },
    ]);
  });

  it('bumps the version on every save, so a deployment can name the one it used', () => {
    const first = createProtocol(deployment(), { id: 'p1', name: 'T', description: '', now: NOW });
    const second = updateProtocol(first, deployment({ batteryLowMv: 3300 }), NOW);
    assert.equal(second.version, 2);
    assert.equal(second.settings.batteryLowMv, 3300);
  });
});

describe('applying a protocol', () => {
  const source = deployment({ micType: 'DIGITAL', ledsEnabled: false });
  const protocol = createProtocol(source, { id: 'p1', name: 'T', description: '', now: NOW });

  it('brings the recording settings across', () => {
    const applied = applyProtocol(deployment(), protocol);
    assert.equal(applied.micType, 'DIGITAL');
    assert.equal(applied.ledsEnabled, false);
  });

  it('leaves the label, dates, and timezone exactly as entered', () => {
    const target = deployment({
      deviceLabel: 'RIVER-07',
      startTime: '2026-09-01T00:00:00.000Z',
      endTime: '2026-10-01T00:00:00.000Z',
      timezone: 'Africa/Bangui',
    });
    const applied = applyProtocol(target, protocol);

    assert.equal(applied.deviceLabel, 'RIVER-07');
    assert.equal(applied.startTime, '2026-09-01T00:00:00.000Z');
    assert.equal(applied.endTime, '2026-10-01T00:00:00.000Z');
    assert.equal(applied.timezone, 'Africa/Bangui');
  });

  it('rebases phase boundaries onto the new dates', () => {
    // A half-and-half split captured over ten days in April must land as half and half
    // over a thirty-day deployment in September, not drag April's dates along.
    const phased = createProtocol(
      deployment({
        startTime: '2026-04-01T00:00:00.000Z',
        endTime: '2026-04-11T00:00:00.000Z',
        isPhased: true,
        phases: [
          { ...defaultPhase('A'), startTime: '2026-04-01T00:00:00.000Z', endTime: '2026-04-06T00:00:00.000Z' },
          { ...defaultPhase('B'), startTime: '2026-04-06T00:00:00.000Z', endTime: '2026-04-11T00:00:00.000Z' },
        ],
      }),
      { id: 'p2', name: 'Phased', description: '', now: NOW },
    );

    const applied = applyProtocol(
      deployment({ startTime: '2026-09-01T00:00:00.000Z', endTime: '2026-10-01T00:00:00.000Z' }),
      phased,
    );

    assert.equal(applied.phases[0].startTime, '2026-09-01T00:00:00.000Z');
    assert.equal(applied.phases[0].endTime, '2026-09-16T00:00:00.000Z');
    assert.equal(applied.phases[1].endTime, '2026-10-01T00:00:00.000Z');
  });

  it('recomputes the VHF start from the new end date rather than carrying the old one', () => {
    const endOfDeployment = createProtocol(deployment({ vhfMode: 'END' }), {
      id: 'p3',
      name: 'T',
      description: '',
      now: NOW,
    });
    const applied = applyProtocol(deployment({ endTime: '2026-12-25T00:00:00.000Z' }), endOfDeployment);
    assert.equal(applied.vhfStartTime, '2026-12-25T00:00:00.000Z');
  });
});

describe('noticing that a deployment has drifted from its protocol', () => {
  const protocol = createProtocol(deployment(), { id: 'p1', name: 'T', description: '', now: NOW });

  it('reports a match when nothing recording-related changed', () => {
    assert.equal(matchesProtocol(deployment(), protocol), true);
  });

  it('ignores the fields a protocol never stored', () => {
    const moved = deployment({
      deviceLabel: 'OTHER-99',
      startTime: '2027-01-01T00:00:00.000Z',
      timezone: 'UTC',
    });
    assert.equal(matchesProtocol(moved, protocol), true);
  });

  it('is unaffected by the order a config\'s fields happen to be in', () => {
    // A config read back off a card by parseConfig is built in a different key order
    // than one from the editor. Comparing them by raw JSON would report every
    // card-loaded configuration as drifted from the protocol that produced it.
    const shuffled = Object.fromEntries(
      Object.entries(deployment()).sort(([a], [b]) => (a < b ? 1 : -1)),
    ) as DeploymentConfig;
    assert.equal(matchesProtocol(shuffled, protocol), true);
  });

  it('survives a round trip through apply, for every starter', () => {
    // Applying a protocol and immediately reporting drift would make the "unsaved
    // changes" hint meaningless the moment anyone used it.
    for (const starterProtocol of STARTER_PROTOCOLS) {
      const applied = applyProtocol(deployment(), starterProtocol);
      assert.equal(matchesProtocol(applied, starterProtocol), true, starterProtocol.name);
    }
  });

  it('reports drift once a recording setting changes', () => {
    assert.equal(matchesProtocol(deployment({ micAmplificationDb: 20 }), protocol), false);
    assert.equal(
      matchesProtocol(deployment({ phases: [{ ...defaultPhase(), audioSampleRateHz: 48000 }] }), protocol),
      false,
    );
  });
});

describe('the starter protocols', () => {
  const NAMES = STARTER_PROTOCOLS.map((protocol) => protocol.name);

  it('each produce a configuration the firmware accepts', () => {
    // A starter that fails validation is worse than no starter at all: it hands a new
    // user a broken configuration and tells them it is a known-good starting point.
    for (const protocol of STARTER_PROTOCOLS) {
      const applied = applyProtocol(deployment(), protocol);
      const errors = validateConfig(applied, DEFAULT_FIRMWARE_PROFILE).filter(
        (issue) => issue.severity === 'error',
      );
      assert.deepEqual(errors, [], `${protocol.name}: ${errors.map((e) => e.message).join('; ')}`);
    }
  });

  it('each serialize to a config file without error', () => {
    for (const protocol of STARTER_PROTOCOLS) {
      const text = serializeConfig(applyProtocol(deployment(), protocol));
      assert.match(text, /DEVICE_LABEL/);
    }
  });

  it('have unique ids and names', () => {
    assert.equal(new Set(STARTER_PROTOCOLS.map((p) => p.id)).size, STARTER_PROTOCOLS.length);
    assert.equal(new Set(NAMES).size, STARTER_PROTOCOLS.length);
  });

  it('are all marked built-in', () => {
    assert.ok(STARTER_PROTOCOLS.every((protocol) => protocol.builtIn));
  });

  it('promise nothing above what the hardware can record', () => {
    // The design plan called for a "continuous ultrasonic" starter. The maximum sample
    // rate is 48 kHz, so nothing above 24 kHz can be captured and no such protocol can
    // honestly exist. This guards against one being added later by mistake.
    const ceiling = Math.max(...AUDIO_SAMPLE_RATES_HZ);
    for (const protocol of STARTER_PROTOCOLS) {
      for (const phase of protocol.settings.phases) {
        assert.ok(
          phase.audioSampleRateHz <= ceiling,
          `${protocol.name} asks for ${phase.audioSampleRateHz} Hz`,
        );
      }
      assert.doesNotMatch(protocol.name + protocol.description, /ultrasoni|bat\b/i);
    }
  });

  it('carry a description saying what each is for', () => {
    for (const protocol of STARTER_PROTOCOLS) {
      assert.ok(protocol.description.length > 40, `${protocol.name} needs a real description`);
    }
  });
});

describe('sun-anchored recording windows', () => {
  const dawnDusk = STARTER_PROTOCOLS.find((p) => p.settings.phases[0].audioScheduleType === 'SOLAR')!;

  it('ships one protocol that uses them', () => {
    assert.ok(dawnDusk, 'the dawn and dusk protocol should use a solar schedule');
    assert.equal(dawnDusk.settings.phases[0].audioSolarWindows.length, 2);
  });

  it('carries fixed windows too, as the fallback the device needs', () => {
    /*
      Above the Arctic circle there is no sunrise for most of the summer, and the firmware
      falls back to these. A solar protocol that shipped without them would leave a caribou
      deployment recording nothing at all for weeks.
    */
    assert.ok(dawnDusk.settings.phases[0].audioTriggerTimes.length > 0);
  });

  it('survives being applied without any position', () => {
    // Nothing is resolved here any more — the schedule is the anchors themselves, and the
    // device works out the times — so a position is not needed to apply a protocol at all.
    const applied = applyProtocol(deployment(), dawnDusk);
    assert.equal(applied.phases[0].audioScheduleType, 'SOLAR');
    assert.deepEqual(applied.phases[0].audioSolarWindows, dawnDusk.settings.phases[0].audioSolarWindows);
    assert.equal(matchesProtocol(applied, dawnDusk), true);
  });

  it('round-trips the solar schedule through a config file', () => {
    const applied = applyProtocol(
      { ...deployment(), deviceLabel: 'SUN', latitude: -1.2921, longitude: 36.8219 },
      dawnDusk,
    );
    const text = serializeConfig(applied);
    assert.match(text, /^AUDIO_TRIGGER_SCHEDULE_TYPE = "SOLAR"$/m);
    assert.match(text, /^AUDIO_SOLAR_SCHEDULE = "DAWN,0,SUNRISE,5400"$/m);
    assert.match(text, /^DEPLOYMENT_LATITUDE = "-1.29210"$/m);

    const reparsed = parseConfig(text).config!;
    assert.deepEqual(reparsed.phases[0].audioSolarWindows, applied.phases[0].audioSolarWindows);
    assert.equal(reparsed.latitude, -1.2921);
    assert.equal(reparsed.longitude, 36.8219);
  });

  it('omits the position entirely when none was given', () => {
    // runtime_config.c only arms `position_available` when both keys are present, so writing
    // a placeholder would claim a site in the Gulf of Guinea for every deployment.
    const text = serializeConfig({ ...deployment(), deviceLabel: 'NOPOS', latitude: null, longitude: null });
    assert.doesNotMatch(text, /DEPLOYMENT_LATITUDE/);
    assert.doesNotMatch(text, /DEPLOYMENT_LONGITUDE/);
  });
});
