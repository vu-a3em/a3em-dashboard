import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { directoryEntryBytes, exfatLayout, marketedCardLayout } from './card-capacity.js';

/**
 * Expected values are what the Python formatter this was ported from, `exfat_image.py` (since
 * retired), computed for the same card at 4 kB clusters. The card helper's formatter
 * (`card-helper/internal/exfat`) produces the same figures, and is where to regenerate them if
 * the geometry ever changes: `exfat.NewLayout(bytes, 4096)`.
 */
describe('the formatter layout', () => {
  const REFERENCE: Array<[number, number, number, number, number]> = [
    // GB, ClusterCount, FatLength, ClusterHeapOffset, clusters in use after formatting
    [32, 7804052, 61032, 63488, 242],
    [128, 31218512, 244136, 247808, 956],
    [1024, 249755008, 1953120, 1955840, 7625],
  ];
  for (const [gb, clusters, fatLength, heapOffset, used] of REFERENCE) {
    it(`matches the formatter for a ${gb} GB card`, () => {
      const layout = marketedCardLayout(gb, 4096);
      assert.equal(layout.clusterCount, clusters);
      assert.equal(layout.fatLengthSectors, fatLength);
      assert.equal(layout.clusterHeapOffsetSectors, heapOffset);
      assert.equal(layout.metadataClusters, used);
      assert.equal(layout.freeBytes, (clusters - used) * 4096);
    });
  }

  it('leaves less free on a card sold as 128 GB than 128 binary gigabytes', () => {
    const free = marketedCardLayout(128, 131072).freeBytes;
    assert.ok(free < 128e9 && free > 127.5e9, `free ${free}`);
    assert.ok(free < 128 * 1024 ** 3);
  });

  it('refuses a cluster size that is not a power of two', () => {
    assert.throws(() => exfatLayout(128e9, 3000));
  });

  it('charges directory entries in 32-byte steps', () => {
    // File entry, stream extension, one name entry for "1767225600.wav".
    assert.equal(directoryEntryBytes(14), 96);
    assert.equal(directoryEntryBytes(16), 128);
  });
});
