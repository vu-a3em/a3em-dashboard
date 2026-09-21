import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_THRESHOLD_DBFS,
  MIN_THRESHOLD_DBFS,
  MIN_WIPER,
  achievableThresholds,
  dbStepAtWiper,
  dbfsToLevel,
  dbfsToStoredFraction,
  describeThreshold,
  effectiveLevel,
  fractionToWiper,
  levelToAdcCodes,
  levelToDbfs,
  quantizeFraction,
  storedFractionToDbfs,
  wiperToStoredFraction,
} from './audio-threshold.js';
import { ADC_CODE_MAX, TRIGGER_DIGIPOT_STEPS } from './firmware-constants.js';

describe('dBFS conversion', () => {
  it('puts full scale at 0 dBFS', () => {
    assert.equal(levelToDbfs(1), 0);
    assert.equal(MAX_THRESHOLD_DBFS, 0);
  });

  it('puts a quarter of full scale at about -12 dBFS', () => {
    assert.ok(Math.abs(levelToDbfs(0.25) - -12.0411998) < 1e-6);
  });

  it('round-trips a level through dB', () => {
    for (const level of [0.01, 0.1, 0.25, 0.5, 0.9, 1]) {
      assert.ok(Math.abs(dbfsToLevel(levelToDbfs(level)) - level) < 1e-12);
    }
  });

  it('treats silence as negative infinity', () => {
    assert.equal(levelToDbfs(0), -Infinity);
    assert.equal(dbfsToLevel(-Infinity), 0);
  });

  it('never reports a level above full scale', () => {
    assert.equal(levelToDbfs(2), 0);
    assert.equal(dbfsToLevel(6), 1);
  });
});

describe('ADC mapping', () => {
  it('maps full scale to the top 12-bit code', () => {
    assert.equal(levelToAdcCodes(1), ADC_CODE_MAX);
  });

  it('maps a quarter of full scale to a quarter of the codes', () => {
    assert.equal(levelToAdcCodes(0.25), Math.round(0.25 * 2047));
  });
});

describe('digipot quantization', () => {
  /**
   * The comparator reference comes from an 8-bit digipot and the firmware
   * TRUNCATES into it:
   *     uint8_t wiper_value = (uint8_t)(255 * percent);
   */
  it('matches the firmware truncating cast', () => {
    assert.equal(fractionToWiper(1), TRIGGER_DIGIPOT_STEPS);
    assert.equal(fractionToWiper(0.25), 63); // 63.75 truncates down, not to 64
    assert.equal(fractionToWiper(0.5), 127); // 127.5 truncates down
  });

  it('truncates anything below one step to a disarmed wiper', () => {
    assert.equal(fractionToWiper(1 / TRIGGER_DIGIPOT_STEPS - 1e-9), 0);
    assert.equal(fractionToWiper(0.001), 0);
  });

  it('reports the level the device actually applies', () => {
    // A stored 0.25 truncates to wiper 63, so the real level is 63/255, not 0.25.
    assert.equal(effectiveLevel(0.25), 63 / TRIGGER_DIGIPOT_STEPS);
  });

  it('stores a value that survives the truncating cast', () => {
    // Naively storing wiper/255 risks float error truncating to wiper-1, so
    // wiperToStoredFraction sits in the middle of the band instead.
    for (let wiper = MIN_WIPER; wiper <= TRIGGER_DIGIPOT_STEPS; wiper++) {
      assert.equal(
        fractionToWiper(wiperToStoredFraction(wiper)),
        wiper,
        `wiper ${wiper} did not survive the round trip`,
      );
    }
  });

  it('snaps idempotently', () => {
    const snapped = quantizeFraction(0.3);
    assert.equal(quantizeFraction(snapped), snapped);
    assert.equal(fractionToWiper(snapped), fractionToWiper(0.3));
  });

  it('offers exactly 255 usable settings', () => {
    const all = achievableThresholds();
    assert.equal(all.length, TRIGGER_DIGIPOT_STEPS);
    assert.equal(all[0].wiper, MIN_WIPER);
    assert.equal(all.at(-1)!.dbfs, 0);
  });

  it('survives a full round trip through dB', () => {
    for (const { wiper, dbfs } of achievableThresholds()) {
      assert.equal(fractionToWiper(dbfsToStoredFraction(dbfs)), wiper);
    }
  });
});

describe('dB resolution is wildly uneven', () => {
  /**
   * This is why the UI must step in wipers rather than in dB: the same single
   * hardware step is worth ~0.03 dB near full scale and ~6 dB at the quiet end.
   */
  it('bottoms out around -48 dBFS', () => {
    assert.ok(Math.abs(MIN_THRESHOLD_DBFS - -48.1308) < 1e-3);
  });

  it('steps by about 6 dB at the quietest setting', () => {
    assert.ok(dbStepAtWiper(1) > 5, `expected > 5 dB, got ${dbStepAtWiper(1)}`);
  });

  it('steps by a small fraction of a dB near full scale', () => {
    assert.ok(dbStepAtWiper(TRIGGER_DIGIPOT_STEPS) < 0.05);
  });
});

describe('describeThreshold', () => {
  it('reports the level the device uses, not the level requested', () => {
    const described = describeThreshold(0.25);
    assert.equal(described.wiper, 63);
    assert.equal(described.level, 63 / TRIGGER_DIGIPOT_STEPS);
    assert.ok(Math.abs(described.dbfs - storedFractionToDbfs(0.25)) < 1e-12);
  });

  it('shows no decimals where a step is coarser than 1 dB', () => {
    assert.equal(describeThreshold(wiperToStoredFraction(1)).label, `${MIN_THRESHOLD_DBFS.toFixed(0)} dBFS`);
  });

  it('shows one decimal where the hardware can resolve it', () => {
    assert.match(describeThreshold(0.25).label, /^-12\.1 dBFS$/);
  });

  it('flags a disarmed trigger', () => {
    const described = describeThreshold(0.001);
    assert.equal(described.armsTrigger, false);
    assert.equal(described.label, 'disarmed');
  });
});

describe('the top of the threshold range', () => {
  it('stores a valid fraction at the loudest setting', () => {
    // The slider runs to wiper 255. Computing (255 + 0.5) / 255 inline gives 1.002, which
    // is not a fraction of full scale and was rejected as a readiness error — so the
    // loudest setting the control offered could not be used.
    const stored = wiperToStoredFraction(255);
    assert.ok(stored > 0 && stored <= 1, `${stored} must be a fraction of full scale`);
    assert.equal(fractionToWiper(stored), 255);
  });

  it('round-trips every wiper the slider can produce', () => {
    for (let wiper = MIN_WIPER; wiper <= 255; wiper++) {
      const stored = wiperToStoredFraction(wiper);
      assert.ok(stored > 0 && stored <= 1, `wiper ${wiper} stored ${stored}`);
      assert.equal(fractionToWiper(stored), wiper, `wiper ${wiper} did not round-trip`);
    }
  });
});
