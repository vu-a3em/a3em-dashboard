import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { acceptImuRecovery, acceptLogTail, CARD_SECTOR_BYTES } from './recovery.js';

const text = (value: string) => new TextEncoder().encode(value);
const lines = (from: number, count: number, note = 'ok') =>
  Array.from({ length: count }, (_, index) => `EVT|TICK|t=${from + index},${note}\n`).join('');

/** What a card holds after a recorded length, aligned to the file: `count` sectors' worth of `content`, continuing. */
function after(recordedBytes: number, content: string, count: number): Uint8Array {
  const length = CARD_SECTOR_BYTES - (recordedBytes % CARD_SECTOR_BYTES) + (count - 1) * CARD_SECTOR_BYTES;
  const out = new Uint8Array(length);
  out.set(text(content).subarray(0, length));
  return out;
}

/** Where the n-th sector after a recorded length starts, in what follows it. */
const sector = (recordedBytes: number, n: number) => (n === 0 ? 0 : CARD_SECTOR_BYTES - (recordedBytes % CARD_SECTOR_BYTES) + (n - 1) * CARD_SECTOR_BYTES);

describe('a log’s tail past its recorded end', () => {
  const before = text(lines(1788000000, 20));

  it('keeps the text written after the last sync, whole sectors of it', () => {
    const accepted = acceptLogTail({ recordedBytes: 1000, before, data: after(1000, lines(1788000100, 100, 'late'), 3) });
    assert.ok(accepted);
    assert.equal(accepted.bytes.length, sector(1000, 3));
    assert.ok(accepted.lines > 10);
  });

  it('stops at the first sector that is not text', () => {
    const data = after(1000, lines(1788000100, 100, 'late'), 3);
    data.fill(0, sector(1000, 1) + 100); // the second sector ends in zeros
    const accepted = acceptLogTail({ recordedBytes: 1000, before, data });
    assert.equal(accepted?.bytes.length, sector(1000, 1));
  });

  it('keeps nothing when what follows the recorded end is not text at all', () => {
    const data = new Uint8Array(3000);
    assert.equal(acceptLogTail({ recordedBytes: 1000, before, data }), null);
  });

  it('cuts at the sector holding a line dated before the log’s last event: an earlier log’s leftovers', () => {
    const data = after(1000, lines(1788000100, 100, 'late'), 4);
    // From the third sector on, an older deployment's log, as formatting left it.
    data.set(text(lines(1700000000, 100, 'an older deployment')).subarray(0, data.length - sector(1000, 2)), sector(1000, 2));
    const accepted = acceptLogTail({ recordedBytes: 1000, before, data });
    assert.equal(accepted?.bytes.length, sector(1000, 2));
    assert.ok(!new TextDecoder().decode(accepted.bytes).includes('older'));
  });

  it('keeps nothing when the very first line goes back in time', () => {
    assert.equal(acceptLogTail({ recordedBytes: 1000, before, data: after(1000, lines(1700000000, 100, 'an older deployment'), 2) }), null);
  });
});

describe('an IMU file cut short', () => {
  const nameTime = 1788037220;
  function recording(samples: Array<[number, number, number]>, options: { rate?: number; start?: number; bytes?: number } = {}) {
    const data = new Uint8Array(options.bytes ?? 8192);
    const view = new DataView(data.buffer);
    view.setUint32(0, options.rate ?? 50, true);
    view.setUint32(4, options.start ?? nameTime + 1, true);
    samples.forEach(([x, y, z], index) => {
      view.setFloat32(8 + index * 12, x, true);
      view.setFloat32(12 + index * 12, y, true);
      view.setFloat32(16 + index * 12, z, true);
    });
    return data;
  }
  const still = (count: number): Array<[number, number, number]> => Array.from({ length: count }, (_, i) => [3 + (i % 5), -12, 998 + (i % 3)]);

  it('keeps the header and the samples a sensor could report, to the sector before the first that is not', () => {
    // 400 samples then nothing: the zeros begin mid-sector 9 of the file.
    const accepted = acceptImuRecovery({ nameTime, data: recording(still(400)), clipSeconds: null });
    assert.ok(accepted);
    const zerosAt = 8 + 400 * 12;
    const boundary = Math.floor(zerosAt / CARD_SECTOR_BYTES) * CARD_SECTOR_BYTES;
    assert.equal(accepted.samples, Math.floor((boundary - 8) / 12));
    assert.equal(accepted.sampleRateHz, 50);
    assert.equal(accepted.bytes.length, 8 + accepted.samples * 12);
  });

  it('is no longer than its clip', () => {
    const accepted = acceptImuRecovery({ nameTime, data: recording(still(600)), clipSeconds: 10 });
    assert.equal(accepted?.samples, 500);
  });

  it('keeps nothing of space that reads as no sensor would: the 525 g leftovers of a real card', () => {
    const data = recording([]);
    for (let offset = 8; offset < data.length; offset += 2) data.set([0x00, 0x49], offset);
    assert.equal(acceptImuRecovery({ nameTime, data, clipSeconds: null }), null);
  });

  it('keeps nothing when the header is not the file’s', () => {
    assert.equal(acceptImuRecovery({ nameTime, data: recording(still(400), { rate: 12 }), clipSeconds: null }), null);
    assert.equal(acceptImuRecovery({ nameTime, data: recording(still(400), { start: nameTime - 5 }), clipSeconds: null }), null);
    assert.equal(acceptImuRecovery({ nameTime, data: recording(still(400), { start: nameTime + 3600 }), clipSeconds: null }), null);
  });

  it('stops where audio data follows it', () => {
    const data = recording(still(700), { bytes: 12288 });
    // Quiet 16-bit audio after sample 300, which reads as vanishingly small floats.
    for (let offset = 8 + 300 * 12; offset < data.length; offset += 2) data.set([0x03, 0x00], offset);
    const accepted = acceptImuRecovery({ nameTime, data, clipSeconds: null });
    const boundary = Math.floor((8 + 300 * 12) / CARD_SECTOR_BYTES) * CARD_SECTOR_BYTES;
    assert.equal(accepted?.samples, Math.floor((boundary - 8) / 12));
  });
});
