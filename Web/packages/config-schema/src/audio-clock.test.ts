import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  achievableSampleRate,
  analogSampleRate,
  digitalSampleRate,
  inexactRates,
} from './audio-clock.js';
import { AUDIO_SAMPLE_RATES_HZ } from './firmware-constants.js';

describe('what the analog converter can actually produce', () => {
  it('hits the mid and upper rates exactly', () => {
    // 12 MHz divides evenly by all of these through the /4 path.
    for (const rate of [16000, 24000, 32000, 48000]) {
      assert.equal(analogSampleRate(rate).actualHz, rate, `${rate} Hz should be exact`);
      assert.equal(analogSampleRate(rate).exact, true);
    }
  });

  it('cannot produce 8 kHz exactly, because the timer register is too small', () => {
    // 8 kHz needs a /4 count of 1500 against a 10-bit limit of 1023, so it falls to the
    // /8 path, whose divisor is always odd. This is the rate the elephant deployments
    // use, so it is the one most worth knowing about.
    const result = analogSampleRate(8000);
    assert.equal(result.exact, false);
    assert.equal(result.actualHz, 7994);
    assert.ok(Math.abs(result.errorFraction) < 0.001, 'the error is under a tenth of a percent');
    assert.ok(result.errorFraction < 0, 'it runs slow, not fast');
  });

  it('reports the direction of the error, not just its size', () => {
    // Which way it misses matters: a clip runs long or short accordingly.
    assert.ok(analogSampleRate(8000).errorFraction < 0);
  });
});

describe('what the digital microphone can actually produce', () => {
  it('hits most offered rates exactly', () => {
    for (const rate of [8000, 16000, 24000, 48000]) {
      assert.equal(digitalSampleRate(rate).exact, true, `${rate} Hz should be exact`);
    }
  });

  it('cannot produce 32 kHz exactly', () => {
    // No divider and decimation pair lands on 32000 from a 24 MHz clock.
    const result = digitalSampleRate(32000);
    assert.equal(result.exact, false);
    assert.equal(result.actualHz, 31914);
    assert.ok(result.errorFraction < 0, 'it runs slow');
    assert.ok(Math.abs(result.errorFraction) < 0.005, 'by about a quarter of a percent');
  });

  it('differs from the analog path, so the microphone choice changes the answer', () => {
    // 8 kHz is exact on digital and not on analog; 32 kHz is the other way round. A
    // single "supported rates" list would be wrong for one of the two microphones.
    assert.equal(digitalSampleRate(8000).exact, true);
    assert.equal(analogSampleRate(8000).exact, false);
    assert.equal(analogSampleRate(32000).exact, true);
    assert.equal(digitalSampleRate(32000).exact, false);
  });
});

describe('choosing by microphone type', () => {
  it('routes to the path the deployment will actually use', () => {
    assert.equal(achievableSampleRate(8000, 'ANALOG').actualHz, analogSampleRate(8000).actualHz);
    assert.equal(achievableSampleRate(8000, 'DIGITAL').actualHz, digitalSampleRate(8000).actualHz);
  });

  it('lists exactly the offered rates that are inexact, per microphone', () => {
    assert.deepEqual([...inexactRates(AUDIO_SAMPLE_RATES_HZ, 'ANALOG').keys()], [8000]);
    assert.deepEqual([...inexactRates(AUDIO_SAMPLE_RATES_HZ, 'DIGITAL').keys()], [32000]);
  });
});

describe('refusing to produce nonsense', () => {
  it('reports an unusable request as unreachable rather than guessing', () => {
    for (const bad of [0, -1, Number.NaN]) {
      assert.equal(analogSampleRate(bad).reachable, false);
      assert.equal(digitalSampleRate(bad).reachable, false);
    }
  });

  it('always lands somewhere for a plausible request, even when not exactly', () => {
    // The clock tree always has SOME combination; the question is only how far off it
    // is. A request far outside the usable band still reports what it would produce
    // rather than claiming the device would refuse.
    const far = digitalSampleRate(10);
    assert.equal(far.reachable, true);
    assert.ok(!far.exact);
    assert.ok(far.actualHz > 0);
  });
});
