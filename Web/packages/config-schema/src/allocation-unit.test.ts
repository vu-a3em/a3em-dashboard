import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOCATION_UNIT_CHOICES_BYTES,
  allocationUnitOptions,
  clipFootprint,
  formatAllocationUnit,
  formatCommandFor,
  recommendAllocationUnit,
  slackBytes,
  SLACK_BUDGET_FRACTION,
} from './allocation-unit.js';
import { defaultConfig } from './defaults.js';
import type { DeploymentConfig, PhaseConfig } from './types.js';

const CARD_128GB = 127_884_333_056;

const BASE = defaultConfig();

function phase(overrides: Partial<PhaseConfig> = {}): PhaseConfig {
  return { ...BASE.phases[0]!, ...overrides };
}

function configWith(...phases: PhaseConfig[]): DeploymentConfig {
  return { ...BASE, phases };
}

// The reference deployment: 87 hours, 16 kHz mono WAV, 60 s clips, IMU at 50 Hz synced to
// audio. Its card holds 5213 .wav averaging 1,919,190 bytes and 5212 .imu averaging 36,109.
const REFERENCE = phase({
  audioSampleRateHz: 16000,
  audioClipLengthSeconds: 60,
  useOpusEncoding: false,
  imuRecordingMode: 'AUDIO',
  imuSampleRateHz: 50,
});

test('clip footprint matches the files a real deployment produced', () => {
  const f = clipFootprint(REFERENCE);
  // 44-byte header + 16000 * 2 * 60. Measured mean was 1,919,190; clips run marginally
  // short because the firmware labels them with its measured sample rate.
  assert.equal(f.audioBytes, 1_920_044);
  assert.ok(Math.abs(f.audioBytes - 1_919_190) / 1_919_190 < 0.001);
  // 12-byte header + 50 * 12 * 60, against a measured mean of 36,109.
  assert.equal(f.imuBytes, 36_012);
  assert.ok(Math.abs(f.imuBytes - 36_109) / 36_109 < 0.005);
});

test('slack is the unused tail of the last cluster', () => {
  assert.equal(slackBytes(4096, 4096), 0, 'an exact fit wastes nothing');
  assert.equal(slackBytes(4097, 4096), 4095);
  assert.equal(slackBytes(36_012, 32_768), 29_524, 'just over a boundary wastes almost a whole cluster');
  assert.equal(slackBytes(0, 32_768), 0, 'a file that does not exist has no tail');
});

test('the reference deployment is advised to use 32 kB', () => {
  const advice = recommendAllocationUnit({
    config: configWith(REFERENCE),
    cardCapacityBytes: CARD_128GB,
  });
  assert.equal(advice.recommendedBytes, 32_768);
  assert.equal(formatAllocationUnit(advice.recommendedBytes), '32 kB');
});

test('32 kB is the knee: it stays in budget and 64 kB does not', () => {
  const options = allocationUnitOptions([{ footprint: clipFootprint(REFERENCE), weight: 1 }], CARD_128GB);
  const at = (bytes: number) => options.find((o) => o.bytes === bytes)!;

  // Measured on the reference card: 2.19% at 32 kB, 3.87% at 64 kB.
  assert.ok(at(32_768).slackFraction < SLACK_BUDGET_FRACTION);
  assert.ok(at(65_536).slackFraction > SLACK_BUDGET_FRACTION);
  assert.ok(Math.abs(at(32_768).slackFraction - 0.0219) < 0.002);
  assert.ok(Math.abs(at(65_536).slackFraction - 0.0387) < 0.003);
});

test('transaction counts reproduce what the card actually does', () => {
  const options = allocationUnitOptions([{ footprint: clipFootprint(REFERENCE), weight: 1 }], CARD_128GB);
  const at = (bytes: number) => options.find((o) => o.bytes === bytes)!;

  // 1,920,044 / 4096 = 469 audio, 36,012 / 4096 = 9 IMU.
  assert.equal(at(4096).writeTransactionsPerClip, 478);
  assert.equal(at(32_768).writeTransactionsPerClip, 61);
  // Eight times fewer transactions for a fortieth of the card.
  assert.ok(at(4096).writeTransactionsPerClip / at(32_768).writeTransactionsPerClip > 7.5);
});

test('past the staging buffer, larger clusters buy nothing and are not recommended', () => {
  const options = allocationUnitOptions([{ footprint: clipFootprint(REFERENCE), weight: 1 }], CARD_128GB);
  const at = (bytes: number) => options.find((o) => o.bytes === bytes)!;
  // 1.92 MB in 512 kB flushes is four writes, which no cluster size can improve on.
  assert.equal(at(524_288).writeTransactionsPerClip, at(262_144).writeTransactionsPerClip - 4);
  assert.equal(at(524_288).writeTransactionsPerClip, 5);
  // And the tie-break toward the smaller unit keeps the recommendation off them entirely.
  assert.ok(!at(524_288).recommended);
  assert.ok(!at(262_144).recommended);
});

test('exactly one unit is ever recommended', () => {
  for (const clipSeconds of [1, 5, 10, 30, 60, 300]) {
    for (const rate of [8000, 16000, 48000]) {
      const options = allocationUnitOptions(
        [{ footprint: clipFootprint(phase({ audioSampleRateHz: rate, audioClipLengthSeconds: clipSeconds })), weight: 1 }],
        CARD_128GB,
      );
      const recommended = options.filter((o) => o.recommended);
      assert.equal(recommended.length, 1, `${rate} Hz / ${clipSeconds}s recommended ${recommended.length}`);
    }
  }
});

test('short clips are advised toward smaller units', () => {
  const short = recommendAllocationUnit({
    config: configWith(phase({ audioClipLengthSeconds: 5, audioSampleRateHz: 8000, imuRecordingMode: 'NONE' })),
    cardCapacityBytes: CARD_128GB,
  });
  const long = recommendAllocationUnit({
    config: configWith(phase({ audioClipLengthSeconds: 300, audioSampleRateHz: 48000, imuRecordingMode: 'NONE' })),
    cardCapacityBytes: CARD_128GB,
  });
  assert.ok(
    short.recommendedBytes < long.recommendedBytes,
    `expected 5 s clips (${short.recommendedBytes}) below 300 s clips (${long.recommendedBytes})`,
  );
});

test('a deployment whose files are smaller than any cluster still gets an answer', () => {
  const advice = recommendAllocationUnit({
    // One second at the minimum Opus bitrate is 625 bytes, so even the smallest cluster is
    // mostly slack and no candidate can come in under budget.
    config: configWith(
      phase({
        audioClipLengthSeconds: 1,
        useOpusEncoding: true,
        opusBitrate: 5000,
        imuRecordingMode: 'NONE',
      }),
    ),
    cardCapacityBytes: CARD_128GB,
  });
  assert.ok(advice.options.every((o) => !o.withinSlackBudget), 'no option should fit the budget here');
  assert.equal(advice.recommendedBytes, ALLOCATION_UNIT_CHOICES_BYTES[0], 'fall back to the smallest');
  assert.ok(advice.recommended.recommended);
});

test('a file that fits one cluster with little slack is worth the larger cluster', () => {
  // 1 s of 8 kHz WAV is 16,044 bytes: it lands inside a single 16 kB cluster with 340
  // bytes to spare, which is both the fewest possible transactions and almost no waste.
  const advice = recommendAllocationUnit({
    config: configWith(phase({ audioClipLengthSeconds: 1, audioSampleRateHz: 8000, imuRecordingMode: 'NONE' })),
    cardCapacityBytes: CARD_128GB,
  });
  assert.equal(advice.recommendedBytes, 16_384);
  assert.equal(advice.recommended.writeTransactionsPerClip, 1);
  assert.ok(advice.recommended.slackFraction < 0.025);
});

test('Opus is sized from its bitrate and staged through the smaller buffer', () => {
  const opus = clipFootprint(
    phase({ useOpusEncoding: true, opusBitrate: 32000, audioClipLengthSeconds: 60, imuRecordingMode: 'NONE' }),
  );
  assert.equal(opus.audioBytes, 240_000);
  assert.equal(opus.audioFlushBytes, 65_536);

  const wav = clipFootprint(phase({ useOpusEncoding: false, audioClipLengthSeconds: 60 }));
  assert.ok(opus.audioBytes < wav.audioBytes / 5, 'Opus should be far smaller than WAV');
});

test('phases are weighted by how many clips they contribute', () => {
  const big = clipFootprint(phase({ audioClipLengthSeconds: 300, audioSampleRateHz: 48000 }));
  const small = clipFootprint(phase({ audioClipLengthSeconds: 5, audioSampleRateHz: 8000 }));

  const mostlyBig = allocationUnitOptions([{ footprint: big, weight: 99 }, { footprint: small, weight: 1 }], CARD_128GB);
  const mostlySmall = allocationUnitOptions([{ footprint: big, weight: 1 }, { footprint: small, weight: 99 }], CARD_128GB);

  const pick = (o: ReturnType<typeof allocationUnitOptions>) => o.find((x) => x.recommended)!.bytes;
  assert.ok(pick(mostlyBig) > pick(mostlySmall), 'a deployment dominated by big clips should tolerate bigger clusters');
});

test('a phase that records nothing does not skew the weighting', () => {
  const silent = phase({ audioClipLengthSeconds: 0, imuRecordingMode: 'NONE' });
  const withSilent = recommendAllocationUnit({
    config: configWith(REFERENCE, silent),
    clipsPerPhase: [100, 0],
    cardCapacityBytes: CARD_128GB,
  });
  const alone = recommendAllocationUnit({ config: configWith(REFERENCE), cardCapacityBytes: CARD_128GB });
  assert.equal(withSilent.recommendedBytes, alone.recommendedBytes);
});

test('verdict compares the card against the recommendation', () => {
  const forCard = (actualUnitBytes: number | null) =>
    recommendAllocationUnit({ config: configWith(REFERENCE), cardCapacityBytes: CARD_128GB, actualUnitBytes });

  assert.equal(forCard(null).verdict, 'unknown');
  assert.equal(forCard(32_768).verdict, 'good');
  // Within one doubling either way is not worth erasing a card over.
  assert.equal(forCard(16_384).verdict, 'good');
  assert.equal(forCard(65_536).verdict, 'good');
  assert.equal(forCard(4096).verdict, 'fragmented');
  assert.equal(forCard(524_288).verdict, 'wasteful');
});

test('summaries say what to do and never promise capacity back for a fragmented card', () => {
  const forCard = (actualUnitBytes: number | null) =>
    recommendAllocationUnit({ config: configWith(REFERENCE), cardCapacityBytes: CARD_128GB, actualUnitBytes }).summary;

  assert.match(forCard(null), /Format as exFAT with a 32 kB block size/);
  assert.match(forCard(32_768), /suits this deployment/);
  assert.match(forCard(4096), /more card writes/);
  assert.doesNotMatch(forCard(4096), /wastes/);
  assert.match(forCard(524_288), /wastes/);
  assert.match(forCard(524_288), /Reformat at 32 kB/);
});

test('an unmodelled cluster size still yields a verdict', () => {
  // exFAT permits sizes we do not offer; a card carrying one should not crash the advice.
  const advice = recommendAllocationUnit({
    config: configWith(REFERENCE),
    cardCapacityBytes: CARD_128GB,
    actualUnitBytes: 1024 * 1024,
  });
  assert.equal(advice.actual, null);
  assert.equal(advice.verdict, 'wasteful');
  assert.match(advice.summary, /Reformat at 32 kB/);
});

test('format helpers render what a user would type', () => {
  assert.equal(formatAllocationUnit(4096), '4 kB');
  assert.equal(formatAllocationUnit(32_768), '32 kB');
  assert.equal(formatAllocationUnit(1024 * 1024), '1 MB');
  assert.equal(formatCommandFor(32_768, '/dev/disk4s1'), 'newfs_exfat -R -b 32768 /dev/disk4s1');
});

test('the format command carries -R, without which it silently does nothing', () => {
  // Verified on Darwin 25.6: given a device already formatted exFAT at a different
  // cluster size, `newfs_exfat -b <size>` prints "Cluster size differs from command line
  // argument; skipping reformat" and **exits 0**. The command this function emits is the
  // one an operator pastes into a terminal, and without -R it is a no-op on exactly the
  // cards the recommendation exists to fix.
  assert.match(formatCommandFor(65_536), /(?:^|\s)-R(?:\s|$)/);
});
