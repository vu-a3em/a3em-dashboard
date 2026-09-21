import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  IMU_HEADER_BYTES_LEGACY,
  IMU_HEADER_BYTES_MODERN,
  ImuFormatError,
  accelerationMagnitude,
  detectImuHeaderBytes,
  parseImuFile,
} from './imu-file.js';

/**
 * `fixtures/legacy-header.imu` is a real file from a real deployment card
 * (SAM_elephant_10, February 2026), not a synthetic one. It is the ground truth for
 * the 12-byte header layout that firmware wrote before 2026.08.1.
 */
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures');
const legacyBuffer = () => {
  const bytes = readFileSync(resolve(FIXTURES, 'legacy-header.imu'));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

/** Builds a modern-layout file so both paths are covered by construction. */
function makeModernFile(sampleRateHz: number, startSeconds: number, samples: Array<[number, number, number]>) {
  const buffer = new ArrayBuffer(IMU_HEADER_BYTES_MODERN + samples.length * 12);
  const view = new DataView(buffer);
  view.setUint32(0, sampleRateHz, true);
  view.setUint32(4, startSeconds, true);
  samples.forEach(([x, y, z], index) => {
    const offset = IMU_HEADER_BYTES_MODERN + index * 12;
    view.setFloat32(offset, x, true);
    view.setFloat32(offset + 4, y, true);
    view.setFloat32(offset + 8, z, true);
  });
  return buffer;
}

describe('header detection', () => {
  it('never finds both layouts plausible for the same length', () => {
    // The two header sizes differ by 4, which is not a multiple of the 12-byte sample,
    // so detection is unambiguous. This is the property the whole reader rests on.
    for (let length = 0; length < 4096; length++) {
      const modernFits = length >= 8 && (length - 8) % 12 === 0;
      const legacyFits = length >= 12 && (length - 12) % 12 === 0;
      assert.ok(!(modernFits && legacyFits), `length ${length} fits both layouts`);
    }
  });

  it('rejects a length that fits neither layout', () => {
    assert.equal(detectImuHeaderBytes(37), null);
    assert.equal(detectImuHeaderBytes(3), null);
  });
});

describe('real deployment file (legacy 12-byte header)', () => {
  it('is detected as the legacy layout', () => {
    const buffer = legacyBuffer();
    assert.equal(detectImuHeaderBytes(buffer.byteLength), IMU_HEADER_BYTES_LEGACY);
    assert.equal(parseImuFile(buffer).legacyHeader, true);
  });

  it('reads the sample rate and start time the filename implies', () => {
    // The fixture is "2026-02-06 09-09-11.imu" from a 50 Hz IMU deployment.
    const file = parseImuFile(legacyBuffer());
    assert.equal(file.sampleRateHz, 50);
    assert.equal(file.startTime, '2026-02-06T09:09:11.000Z');
  });

  it('yields a whole number of samples', () => {
    const file = parseImuFile(legacyBuffer());
    assert.ok(Number.isInteger(file.sampleCount));
    assert.equal(file.sampleCount, (1548 - IMU_HEADER_BYTES_LEGACY) / 12);
  });

  it('reads gravity on the very first sample', () => {
    // The decisive check. The device was stationary, so every sample should read
    // about 1000 mg. Reading from the wrong offset straddles two samples and the
    // first magnitude comes out far from gravity — which is exactly the bug in
    // processing.py, invisible because later samples still look plausible.
    const file = parseImuFile(legacyBuffer());
    const first = accelerationMagnitude(file.samples[0]);
    assert.ok(
      Math.abs(first - 1000) < 120,
      `first sample magnitude ${first.toFixed(1)} mg is not close to gravity`,
    );
  });

  it('reads gravity across every sample in the file', () => {
    const file = parseImuFile(legacyBuffer());
    for (const [index, sample] of file.samples.entries()) {
      const magnitude = accelerationMagnitude(sample);
      assert.ok(
        magnitude > 800 && magnitude < 1200,
        `sample ${index} magnitude ${magnitude.toFixed(1)} mg is implausible for a stationary device`,
      );
    }
  });

  it('would read nonsense at the modern offset, confirming the layouts differ', () => {
    // Guards against the detection silently becoming a no-op.
    const buffer = legacyBuffer();
    const view = new DataView(buffer);
    const x = view.getFloat32(IMU_HEADER_BYTES_MODERN, true);
    const y = view.getFloat32(IMU_HEADER_BYTES_MODERN + 4, true);
    const z = view.getFloat32(IMU_HEADER_BYTES_MODERN + 8, true);
    const wrong = Math.sqrt(x * x + y * y + z * z);
    assert.ok(wrong < 800 || wrong > 1200, `reading at the wrong offset gave ${wrong} mg, too plausible`);
  });
});

describe('modern 8-byte header', () => {
  const samples: Array<[number, number, number]> = [
    [0, 0, 1000],
    [10, -20, 995],
    [-5, 15, 1002],
  ];

  it('round-trips rate, time, and samples', () => {
    const file = parseImuFile(makeModernFile(100, 1770368424, samples));
    assert.equal(file.legacyHeader, false);
    assert.equal(file.headerBytes, IMU_HEADER_BYTES_MODERN);
    assert.equal(file.sampleRateHz, 100);
    assert.equal(file.startTime, '2026-02-06T09:00:24.000Z');
    assert.equal(file.sampleCount, 3);
    assert.equal(file.samples[0].z, 1000);
    assert.equal(file.samples[2].y, 15);
  });

  it('spaces samples by the sample rate', () => {
    const file = parseImuFile(makeModernFile(50, 0, samples));
    assert.equal(file.samples[0].offsetSeconds, 0);
    assert.equal(file.samples[1].offsetSeconds, 0.02);
  });
});

describe('decimation and errors', () => {
  it('decimates to at most maxSamples', () => {
    const many: Array<[number, number, number]> = Array.from({ length: 3000 }, () => [0, 0, 1000]);
    const file = parseImuFile(makeModernFile(50, 0, many), { maxSamples: 100 });
    assert.equal(file.sampleCount, 3000, 'the true count is still reported');
    assert.ok(file.samples.length <= 100);
  });

  it('throws on a truncated file rather than returning garbage', () => {
    assert.throws(() => parseImuFile(new ArrayBuffer(37)), ImuFormatError);
  });

  it('throws on a zero sample rate', () => {
    assert.throws(() => parseImuFile(makeModernFile(0, 0, [[0, 0, 1000]])), ImuFormatError);
  });
});
