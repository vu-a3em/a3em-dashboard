import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildPlayableWav,
  judgeClip,
  measureLevels,
  readSamples,
  readWavFormat,
  waveformEnvelope,
} from './audio-clip.js';

/** Builds a clip exactly as `storage_write_wav_header()` does, plus samples. */
function wav(samples: Int16Array, options: { declaredDataBytes?: number; riffSize?: number; sampleRate?: number } = {}) {
  const sampleRate = options.sampleRate ?? 8000;
  const payload = samples.length * 2;
  const bytes = new Uint8Array(44 + payload);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, options.riffSize ?? 36 + payload, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, options.declaredDataBytes ?? payload, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true);
  return bytes;
}

/** A quiet clip shaped like the real card: 12-bit converter, so steps of 16. */
const realistic = Int16Array.from({ length: 8000 }, (_, i) => Math.round(Math.sin(i / 20) * 15) * 16);

describe('reading a clip', () => {
  it('reads the format the firmware writes', () => {
    const format = readWavFormat(wav(realistic))!;
    assert.equal(format.channels, 1);
    assert.equal(format.sampleRateHz, 8000);
    assert.equal(format.bitsPerSample, 16);
    assert.equal(format.dataOffset, 44);
    assert.equal(format.durationSeconds, 1);
  });

  it('reports what is present separately from what is claimed', () => {
    // The two differ on every legacy recording and on every interrupted one, and the
    // difference is the whole reason playback needs correcting.
    const format = readWavFormat(wav(realistic, { declaredDataBytes: 16000 + 4 }))!;
    assert.equal(format.declaredDataBytes, 16004);
    assert.equal(format.actualDataBytes, 16000);
  });

  it('reads samples according to what is there, not what is declared', () => {
    const samples = readSamples(wav(realistic, { declaredDataBytes: 999999 }), readWavFormat(wav(realistic))!);
    assert.equal(samples.length, realistic.length);
    assert.equal(samples[100], realistic[100]);
  });

  it('rejects anything that is not a WAV', () => {
    assert.equal(readWavFormat(new Uint8Array(44)), null);
    assert.equal(readWavFormat(new Uint8Array(10)), null);
  });
});

describe('measuring levels', () => {
  it('reports peak and RMS against full scale', () => {
    const levels = measureLevels(Int16Array.from([0, 16384, -16384, 0]));
    assert.equal(levels.peak, 16384);
    assert.ok(Math.abs(levels.peakDbfs - -6.02) < 0.01);
  });

  it('measures the converter step rather than assuming it', () => {
    // A3EM audio is 12-bit written into 16-bit samples, so values step in 16s. Measuring
    // it turns a fixed assumption into a check on the microphone path.
    const levels = measureLevels(realistic);
    assert.equal(levels.quantizationStep, 16);
    assert.equal(levels.effectiveBits, 12);
  });

  it('reports full resolution when every level is in use', () => {
    const levels = measureLevels(Int16Array.from([1, 2, 3, 5, 7]));
    assert.equal(levels.quantizationStep, 1);
    assert.equal(levels.effectiveBits, 16);
  });

  it('reports DC offset, which a healthy signal keeps near zero', () => {
    assert.equal(measureLevels(Int16Array.from([1000, 1000, 1000, 1000])).dcOffset, 1000);
    assert.equal(measureLevels(Int16Array.from([-500, 500, -500, 500])).dcOffset, 0);
  });

  it('counts samples driven into the rails', () => {
    assert.equal(measureLevels(Int16Array.from([32767, -32768, 0])).clippedSamples, 2);
  });

  it('handles an empty clip without dividing by zero', () => {
    const levels = measureLevels(new Int16Array(0));
    assert.equal(levels.peakDbfs, -Infinity);
    assert.equal(levels.flatline, true);
  });
});

describe('judging what the levels mean', () => {
  it('separates a dead microphone from a quiet site', () => {
    // The distinction that matters most: silence because nothing was happening, versus
    // silence because the microphone was never connected. These look identical on a
    // waveform and completely different in what they cost a field season.
    const dead = judgeClip(measureLevels(new Int16Array(8000)));
    assert.equal(dead.health, 'dead');
    assert.match(dead.detail, /not a quiet site/);

    const quiet = judgeClip(measureLevels(Int16Array.from({ length: 8000 }, (_, i) => (i % 2 ? 16 : -16))));
    assert.equal(quiet.health, 'quiet');
  });

  it('flags a stuck signal even when it is not zero', () => {
    // A rail-stuck analog path reads as a constant, not as silence.
    assert.equal(judgeClip(measureLevels(Int16Array.from({ length: 100 }, () => 4096))).health, 'dead');
  });

  it('flags clipping', () => {
    const clipping = Int16Array.from({ length: 1000 }, (_, i) => (i < 50 ? 32767 : 1000));
    assert.equal(judgeClip(measureLevels(clipping)).health, 'clipping');
  });

  it('accepts a real recording from the reference card as healthy', () => {
    // Peaks around -27 dBFS on a quiet 8 kHz deployment must not be reported as a fault.
    const levels = measureLevels(Int16Array.from({ length: 8000 }, (_, i) => Math.round(Math.sin(i / 7) * 84) * 16));
    assert.equal(judgeClip(levels).health, 'ok');
  });
});

describe('drawing a waveform', () => {
  it('keeps both extremes of every bucket', () => {
    // Plotting every nth sample would drop a single-sample transient entirely, which is
    // exactly the event worth seeing on a monitoring recording.
    const samples = new Int16Array(1000);
    samples[500] = 30000;
    const envelope = waveformEnvelope(samples, 10);
    assert.equal(envelope.length, 10);
    assert.equal(envelope[5].max, 30000);
  });

  it('covers the whole clip', () => {
    const samples = Int16Array.from({ length: 999 }, (_, i) => i);
    const envelope = waveformEnvelope(samples, 100);
    assert.equal(envelope.length, 100);
    assert.equal(envelope[99].max, 998);
  });

  it('returns nothing for an empty clip', () => {
    assert.deepEqual(waveformEnvelope(new Int16Array(0), 50), []);
  });
});

describe('preparing a clip for playback', () => {
  it('leaves a correct file untouched', () => {
    const bytes = wav(realistic);
    assert.equal(buildPlayableWav(bytes), bytes);
  });

  it('corrects the four-byte overstatement of legacy firmware', () => {
    const corrected = buildPlayableWav(wav(realistic, { declaredDataBytes: 16000 + 4 }))!;
    assert.equal(readWavFormat(corrected)!.declaredDataBytes, 16000);
  });

  it('makes an interrupted clip play at its true length', () => {
    // The placeholder written at open is 16 bytes, so a player reads eight samples of a
    // recording that may be minutes long. This is what makes those files usable again.
    const interrupted = wav(realistic, { declaredDataBytes: 16, riffSize: 36 });
    const corrected = buildPlayableWav(interrupted)!;
    const format = readWavFormat(corrected)!;

    assert.equal(format.declaredDataBytes, 16000);
    assert.equal(format.durationSeconds, 1);
  });

  it('never alters the original bytes', () => {
    const original = wav(realistic, { declaredDataBytes: 16, riffSize: 36 });
    const snapshot = original.slice();
    buildPlayableWav(original);
    assert.deepEqual(original, snapshot);
  });

  it('gives up on a file with no audio in it', () => {
    assert.equal(buildPlayableWav(wav(new Int16Array(0))), null);
  });
});
