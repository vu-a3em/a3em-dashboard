import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  binFrequencyHz,
  computeSpectrogram,
  energyCeilingHz,
  frequencyBin,
  suggestedFftSize,
  type Spectrogram,
} from './spectrogram.js';

const RATE = 8000;

/** A sine at `hz`, amplitude as a fraction of full scale. */
function tone(hz: number, seconds: number, amplitude = 1, rate = RATE): Int16Array {
  const samples = new Int16Array(Math.floor(seconds * rate));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 32767 * amplitude);
  }
  return samples;
}

/** The bin holding the most energy in a given column. */
function loudestBin(spectrogram: Spectrogram, column: number): number {
  let best = 0;
  for (let bin = 1; bin < spectrogram.bins; bin++) {
    if (spectrogram.data[column * spectrogram.bins + bin] > spectrogram.data[column * spectrogram.bins + best]) {
      best = bin;
    }
  }
  return best;
}

const OPTIONS = { sampleRateHz: RATE, fftSize: 1024, columns: 100 };

describe('computing a spectrogram', () => {
  it('produces the requested shape', () => {
    const spectrogram = computeSpectrogram(tone(1000, 2), OPTIONS);
    assert.equal(spectrogram.columns, 100);
    assert.equal(spectrogram.bins, 512);
    assert.equal(spectrogram.data.length, 100 * 512);
    assert.equal(spectrogram.frequencyStepHz, RATE / 1024);
  });

  it('puts a tone in the bin for its frequency', () => {
    const spectrogram = computeSpectrogram(tone(1000, 2), OPTIONS);
    const bin = loudestBin(spectrogram, 50);
    assert.ok(
      Math.abs(binFrequencyHz(bin, spectrogram) - 1000) < spectrogram.frequencyStepHz * 1.5,
      `expected ~1000 Hz, got ${binFrequencyHz(bin, spectrogram)}`,
    );
  });

  it('finds a 20 Hz rumble, which is the whole reason this exists', () => {
    // The signal A3EM is deployed to capture. On a waveform it is indistinguishable
    // from noise; it must be unmistakable here.
    const spectrogram = computeSpectrogram(tone(20, 4, 0.05), { ...OPTIONS, fftSize: 1024 });
    const bin = loudestBin(spectrogram, 50);
    assert.ok(
      Math.abs(binFrequencyHz(bin, spectrogram) - 20) < spectrogram.frequencyStepHz * 2,
      `expected ~20 Hz, got ${binFrequencyHz(bin, spectrogram)}`,
    );
  });

  it('reads a full-scale tone as roughly zero decibels', () => {
    // The normalization that makes the numbers mean something: 0 dB is as loud as this
    // format can represent, so everything else reads as a real distance below it.
    const spectrogram = computeSpectrogram(tone(1000, 2), OPTIONS);
    assert.ok(Math.abs(spectrogram.peakDb) < 1.5, `peak was ${spectrogram.peakDb} dB`);
  });

  it('reads a quarter-amplitude tone about 12 dB lower', () => {
    const loud = computeSpectrogram(tone(1000, 2, 1), OPTIONS);
    const quiet = computeSpectrogram(tone(1000, 2, 0.25), OPTIONS);
    assert.ok(Math.abs(loud.peakDb - quiet.peakDb - 12.04) < 1);
  });

  it('separates two tones present at once', () => {
    const both = tone(500, 2);
    const upper = tone(2000, 2, 0.9);
    for (let i = 0; i < both.length; i++) both[i] = (both[i] + upper[i]) / 2;

    const spectrogram = computeSpectrogram(both, OPTIONS);
    const column = 50;
    const at = (hz: number) => spectrogram.data[column * spectrogram.bins + frequencyBin(hz, spectrogram)];
    // Both peaks stand well clear of a frequency holding nothing.
    assert.ok(at(500) > at(1200) + 20);
    assert.ok(at(2000) > at(1200) + 20);
  });

  it('reports silence at the floor rather than as negative infinity', () => {
    const spectrogram = computeSpectrogram(new Int16Array(8000), OPTIONS);
    assert.equal(spectrogram.peakDb, spectrogram.floorDb);
    assert.ok(spectrogram.data.every((value) => value === spectrogram.floorDb));
  });

  it('places a tone in time, not only in frequency', () => {
    // Silence, then a tone for the second half. The picture must show that.
    const samples = new Int16Array(RATE * 2);
    const burst = tone(1500, 1);
    samples.set(burst, RATE);

    const spectrogram = computeSpectrogram(samples, OPTIONS);
    const bin = frequencyBin(1500, spectrogram);
    const early = spectrogram.data[10 * spectrogram.bins + bin];
    const late = spectrogram.data[80 * spectrogram.bins + bin];
    assert.ok(late > early + 40, `early ${early} dB, late ${late} dB`);
  });

  it('keeps a brief event when the clip is far longer than the display is wide', () => {
    // Ten seconds into forty columns means each column spans far more than one window.
    // Taking a single window per column would miss a short call entirely.
    const samples = new Int16Array(RATE * 10);
    samples.set(tone(1500, 0.1), RATE * 5);

    const spectrogram = computeSpectrogram(samples, { sampleRateHz: RATE, fftSize: 1024, columns: 40 });
    assert.ok(spectrogram.peakDb > spectrogram.floorDb + 40, 'the burst should be visible somewhere');
  });

  describe('refusing to produce nonsense', () => {
    it('returns an empty picture for an empty clip', () => {
      const spectrogram = computeSpectrogram(new Int16Array(0), OPTIONS);
      assert.equal(spectrogram.peakDb, spectrogram.floorDb);
    });

    it('returns an empty picture for an FFT size that is not a power of two', () => {
      const spectrogram = computeSpectrogram(tone(1000, 1), { ...OPTIONS, fftSize: 1000 });
      assert.equal(spectrogram.peakDb, spectrogram.floorDb);
    });

    it('handles a clip shorter than one window', () => {
      const spectrogram = computeSpectrogram(tone(1000, 0.01), OPTIONS);
      assert.equal(spectrogram.data.length, 100 * 512);
    });
  });
});

describe('choosing a window size', () => {
  it('resolves finely enough at 8 kHz to separate a rumble from DC', () => {
    const size = suggestedFftSize(8000);
    assert.ok(8000 / size < 10, `${8000 / size} Hz bins is too coarse for a 20 Hz call`);
  });

  it('gives a full-band view the same amount of detail at any sample rate', () => {
    // Rows shown, not hertz per bin, is what the invariant is about: a full-band picture
    // should look equally detailed whether the clip is 8 kHz or 48 kHz.
    const rows = (rate: number) => rate / 2 / (rate / suggestedFftSize(rate));
    assert.equal(rows(8000), rows(48000));
  });
});

describe('choosing what to show first', () => {
  it('reports a low ceiling for a recording whose energy is all near the bottom', () => {
    // The elephant case. Opening this at full bandwidth shows a black rectangle.
    const spectrogram = computeSpectrogram(tone(30, 4), OPTIONS);
    assert.ok(energyCeilingHz(spectrogram) < 200, `got ${energyCeilingHz(spectrogram)} Hz`);
  });

  it('reports a high ceiling for a recording that uses the whole band', () => {
    const wideband = new Int16Array(RATE * 2);
    for (let i = 0; i < wideband.length; i++) wideband[i] = Math.round((Math.random() * 2 - 1) * 8000);
    assert.ok(energyCeilingHz(computeSpectrogram(wideband, OPTIONS)) > RATE / 4);
  });

  it('does not let a wide quiet region outvote a narrow loud one', () => {
    // Averaging in decibels would do exactly that, because the empty band is enormous
    // and only moderately quiet, while the signal is narrow and very loud.
    const spectrogram = computeSpectrogram(tone(100, 4), OPTIONS);
    assert.ok(energyCeilingHz(spectrogram) < 400);
  });

  it('survives silence without claiming a band', () => {
    assert.ok(energyCeilingHz(computeSpectrogram(new Int16Array(8000), OPTIONS)) > 0);
  });
});

describe('sizing the window to the band being shown', () => {
  it('resolves a narrow band far more finely than the full one', () => {
    // Cropping alone leaves 33 rows stretched over the display, which looks like detail
    // and is not. This is what makes zooming actually show something.
    const full = suggestedFftSize(8000, 4000);
    const zoomed = suggestedFftSize(8000, 250);
    assert.ok(zoomed > full * 4, `${full} vs ${zoomed}`);
    assert.ok(250 / (8000 / zoomed) > 200, 'a 250 Hz view should have hundreds of rows');
  });

  it('stays within bounds that keep it worth computing', () => {
    for (const rate of [8000, 16000, 48000]) {
      for (const band of [10, 100, 1000, 24000]) {
        const size = suggestedFftSize(rate, band);
        assert.ok(size >= 1024 && size <= 8192, `${rate}/${band} gave ${size}`);
        assert.equal(size & (size - 1), 0, 'must be a power of two');
      }
    }
  });
});
