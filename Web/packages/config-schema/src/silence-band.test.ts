import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { silenceBand, silenceFftLength } from './silence-band.js';
import { AUDIO_SAMPLE_RATES_HZ, maxFrequencyCeilingHz } from './firmware-constants.js';

describe('the FFT length the firmware picks', () => {
  it('keeps the bin width inside the band silence.c aims for', () => {
    // The comment in silence.c states 7.81-11.72 Hz. Every offered rate must land there,
    // because a wider bin would blur the low edge further than the UI admits.
    for (const rate of AUDIO_SAMPLE_RATES_HZ) {
      const width = rate / silenceFftLength(rate);
      assert.ok(width >= 7.81 && width <= 11.72, `${rate} Hz gives ${width} Hz bins`);
    }
  });

  it('never exceeds the buffer silence.c allocates', () => {
    for (const rate of AUDIO_SAMPLE_RATES_HZ) {
      assert.ok(silenceFftLength(rate) <= 4096);
    }
  });
});

describe('the band the device actually judges', () => {
  it('reports the bins the old 250 Hz default selected', () => {
    // The default that used to ship. Recorded here because it is the reason the default
    // moved: at 8 kHz it put the low edge at 250 Hz, above every rumble harmonic below it.
    const band = silenceBand(8000, 250, maxFrequencyCeilingHz(8000));
    assert.equal(band.minBin, 32);
    assert.equal(band.maxBin, 486);
    assert.equal(band.actualMinHz, 250);
    assert.ok(Math.abs(band.actualMaxHz - 3796.875) < 0.001);
  });

  it('lands the low edge within half a bin either side of the request', () => {
    // Not a consistent direction, which is why the UI states the number rather than a rule:
    // at 48 kHz, 250 Hz judges from 246.1 Hz but 100 Hz judges from 105.5 Hz.
    const below = silenceBand(48000, 250, maxFrequencyCeilingHz(48000));
    assert.equal(below.minBin, 21);
    assert.ok(Math.abs(below.actualMinHz - 246.09375) < 0.001);

    const above = silenceBand(48000, 100, maxFrequencyCeilingHz(48000));
    assert.equal(above.minBin, 9);
    assert.ok(Math.abs(above.actualMinHz - 105.46875) < 0.001);

    /*
      The bound the two cases illustrate, checked across the whole range.

      Only above bin 1, because bin 1 is a floor rather than a rounding: there is no bin 0
      to fall back to (it is DC), so a request below 7.8 Hz lands on 7.8 Hz however far
      below it started. That case is its own test rather than an exception buried here.
    */
    for (const rate of AUDIO_SAMPLE_RATES_HZ) {
      const ceiling = maxFrequencyCeilingHz(rate);
      for (let requested = 1; requested < ceiling; requested += 53) {
        const band = silenceBand(rate, requested, ceiling);
        if (band.minBin === 1) continue;
        const drift = Math.abs(band.actualMinHz - requested);
        assert.ok(
          drift <= band.binWidthHz / 2 + 0.001,
          `${rate} Hz asked ${requested}, judged ${band.actualMinHz}`,
        );
      }
    }
  });

  it('reaches the rumble harmonics at the new 20 Hz setting', () => {
    // What the low-frequency protocol asks for. The fundamental (8-34 Hz) is partly below
    // the first bin center, but the ~50 and ~100 Hz formants are comfortably inside.
    const band = silenceBand(8000, 20, maxFrequencyCeilingHz(8000));
    assert.ok(band.usable);
    assert.ok(band.actualMinHz <= 50, `low edge ${band.actualMinHz} Hz must sit under the formants`);
  });

  it('cannot judge below the first bin center, whatever is asked for', () => {
    // Bin 0 is DC and is never summed, so 0 Hz and 1 Hz are the same request.
    for (const requested of [0, 1, 5]) {
      const band = silenceBand(8000, requested, maxFrequencyCeilingHz(8000));
      assert.equal(band.minBin, 1);
      assert.ok(Math.abs(band.actualMinHz - 7.8125) < 0.001);
    }
  });

  it('substitutes the ceiling for a zero high edge, as runtime_config.c does', () => {
    const zero = silenceBand(16000, 100, 0);
    const explicit = silenceBand(16000, 100, maxFrequencyCeilingHz(16000));
    assert.deepEqual(zero, explicit);
  });

  it('refuses an inverted range rather than guessing', () => {
    assert.equal(silenceBand(16000, 5000, 1000).usable, false);
    assert.equal(silenceBand(16000, 1000, 1000).usable, false);
  });

  it('always selects at least one bin for any range the validator accepts', () => {
    /*
      The firmware's `min_bin > max_bin` branch is unreachable, and this is the check that
      says so. It matters because that branch disables the filter silently — every clip
      would be kept, which is safe but is not what was asked for. If a future change to the
      bin arithmetic ever makes it reachable, this fails rather than shipping quietly.
    */
    for (const rate of AUDIO_SAMPLE_RATES_HZ) {
      const ceiling = maxFrequencyCeilingHz(rate);
      for (let min = 0; min < ceiling; min += 97) {
        for (let max = min + 1; max <= ceiling; max += 383) {
          const band = silenceBand(rate, min, max);
          assert.ok(band.usable, `${rate} Hz [${min}, ${max}] selected no bins`);
          assert.ok(band.minBin <= band.maxBin);
        }
      }
    }
  });
});
