import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { judgeImuFile, judgeWavFile, LOST_VERDICTS, WAV_HEADER_BYTES } from './integrity.js';

/**
 * Fixtures built byte-for-byte as `storage_write_wav_header()` writes them, so these
 * tests fail if the firmware's header layout drifts from what the app expects.
 */
function wavHeader(options: {
  channels?: number;
  sampleRate?: number;
  /** Payload length to declare at offset 40. Defaults to a finalized header. */
  declaredDataSize?: number;
  riffSize?: number;
  payloadBytes: number;
}): Uint8Array {
  const channels = options.channels ?? 1;
  const sampleRate = options.sampleRate ?? 48_000;
  const bytesPerSample = 2;
  const declared = options.declaredDataSize ?? options.payloadBytes;
  const riff = options.riffSize ?? 36 + options.payloadBytes;

  const bytes = new Uint8Array(WAV_HEADER_BYTES);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, riff, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  ascii(36, 'data');
  view.setUint32(40, declared, true);
  return bytes;
}

const MODERN = { correctWavChunkSize: true };
const LEGACY = { correctWavChunkSize: false };

const PAYLOAD = 48_000 * 2 * 10; // ten seconds of mono 48 kHz

describe('judging a WAV recording', () => {
  it('accepts a properly finalized clip', () => {
    const header = wavHeader({ payloadBytes: PAYLOAD });
    const judgement = judgeWavFile(PAYLOAD + WAV_HEADER_BYTES, header, MODERN);
    assert.equal(judgement.verdict, 'ok');
    assert.equal(judgement.detail, null);
  });

  describe('the four-byte overstatement of older firmware', () => {
    // Every WAV written before 2026.08.1 declares four bytes more than it holds,
    // because the header patch counted its own write into the payload total.
    const legacySize = PAYLOAD + WAV_HEADER_BYTES;
    const legacyHeader = wavHeader({ payloadBytes: PAYLOAD, declaredDataSize: PAYLOAD + 4 });

    it('is expected on a legacy card', () => {
      assert.equal(judgeWavFile(legacySize, legacyHeader, LEGACY).verdict, 'ok');
    });

    it('is a genuine fault on a card from firmware that gets it right', () => {
      assert.equal(judgeWavFile(legacySize, legacyHeader, MODERN).verdict, 'truncated');
    });

    it('does not excuse a fifth missing byte even on a legacy card', () => {
      const worse = wavHeader({ payloadBytes: PAYLOAD, declaredDataSize: PAYLOAD + 5 });
      assert.equal(judgeWavFile(legacySize, worse, LEGACY).verdict, 'truncated');
    });
  });

  describe('a clip the device never closed', () => {
    // storage_close_wav_audio() is what fills in both size fields. Lose power before it
    // runs and the placeholders survive: RIFF size 36, data size 16. The audio behind
    // them is untouched, which is the entire point of separating this from truncation.
    it('is recognised by the placeholder the firmware writes at open', () => {
      const header = wavHeader({ payloadBytes: PAYLOAD, declaredDataSize: 16, riffSize: 36 });
      const judgement = judgeWavFile(PAYLOAD + WAV_HEADER_BYTES, header, MODERN);
      assert.equal(judgement.verdict, 'unfinalized');
      assert.equal(judgement.recoverable, true);
    });

    it('is repaired by writing the true lengths the firmware would have written', () => {
      const header = wavHeader({ payloadBytes: PAYLOAD, declaredDataSize: 16, riffSize: 36 });
      const { repair } = judgeWavFile(PAYLOAD + WAV_HEADER_BYTES, header, MODERN);
      assert.deepEqual(repair, { kind: 'wav-header', dataSize: PAYLOAD, riffSize: 36 + PAYLOAD });
    });

    it('is detected on legacy cards too, where the same interruption happens', () => {
      const header = wavHeader({ payloadBytes: PAYLOAD, declaredDataSize: 16, riffSize: 36 });
      assert.equal(judgeWavFile(PAYLOAD + WAV_HEADER_BYTES, header, LEGACY).verdict, 'unfinalized');
    });

    it('is still detected if the placeholder is ever tightened to zero', () => {
      const header = wavHeader({ payloadBytes: PAYLOAD, declaredDataSize: 0, riffSize: 36 });
      assert.equal(judgeWavFile(PAYLOAD + WAV_HEADER_BYTES, header, MODERN).verdict, 'unfinalized');
    });

    it('is not claimed for a file that holds nothing but the placeholder header', () => {
      // Opened, never written to, then interrupted. There is no audio to recover, so
      // calling this repairable would promise something that is not there.
      const header = wavHeader({ payloadBytes: 0, declaredDataSize: 16, riffSize: 36 });
      const judgement = judgeWavFile(WAV_HEADER_BYTES, header, MODERN);
      assert.notEqual(judgement.verdict, 'unfinalized');
      assert.equal(judgement.recoverable, false);
    });
  });

  describe('damage that loses the recording', () => {
    it('reports a zero-length file as empty', () => {
      assert.equal(judgeWavFile(0, null, MODERN).verdict, 'empty');
    });

    it('reports a file shorter than its own header as cut short', () => {
      assert.equal(judgeWavFile(20, new Uint8Array(20), MODERN).verdict, 'truncated');
    });

    it('names an all-zero header as a blank area of the card, not a device fault', () => {
      // A failed flash block reads back as zeros. Blaming the firmware for this would
      // send someone looking in entirely the wrong place.
      const judgement = judgeWavFile(PAYLOAD, new Uint8Array(WAV_HEADER_BYTES), MODERN);
      assert.equal(judgement.verdict, 'blank');
      assert.match(judgement.detail!, /card/);
    });

    it('rejects a file whose RIFF magic is wrong', () => {
      const header = wavHeader({ payloadBytes: PAYLOAD });
      header[0] = 0x58;
      assert.equal(judgeWavFile(PAYLOAD + WAV_HEADER_BYTES, header, MODERN).verdict, 'malformed');
    });

    it('rejects a file whose data chunk marker is damaged', () => {
      const header = wavHeader({ payloadBytes: PAYLOAD });
      header[36] = 0x00;
      assert.equal(judgeWavFile(PAYLOAD + WAV_HEADER_BYTES, header, MODERN).verdict, 'malformed');
    });

    it('treats an absurd declared length as a corrupt field rather than a truncation', () => {
      // 0xFFFFFFFF is not a recording that lost its tail; it is a size field overwritten
      // by something else, and saying "4 GB is missing" would be nonsense.
      const header = wavHeader({ payloadBytes: PAYLOAD, declaredDataSize: 0xffffffff });
      assert.equal(judgeWavFile(PAYLOAD + WAV_HEADER_BYTES, header, MODERN).verdict, 'malformed');
    });

    it('reports how much audio is missing when a clip loses its tail', () => {
      const header = wavHeader({ payloadBytes: PAYLOAD });
      const judgement = judgeWavFile(PAYLOAD + WAV_HEADER_BYTES - 100_000, header, MODERN);
      assert.equal(judgement.verdict, 'truncated');
      assert.match(judgement.detail!, /missing/);
    });

    it('classifies every one of these as lost rather than repairable', () => {
      for (const verdict of ['empty', 'truncated', 'malformed', 'blank', 'unreadable'] as const) {
        assert.ok(LOST_VERDICTS.has(verdict), `${verdict} should count as lost`);
      }
      assert.ok(!LOST_VERDICTS.has('unfinalized'));
      assert.ok(!LOST_VERDICTS.has('ok'));
    });
  });

  it('tolerates a file carrying a few bytes beyond what it declares', () => {
    // Padding at the end costs nothing and is not evidence of damage.
    const header = wavHeader({ payloadBytes: PAYLOAD });
    assert.equal(judgeWavFile(PAYLOAD + WAV_HEADER_BYTES + 512, header, MODERN).verdict, 'ok');
  });
});

describe('judging an IMU recording', () => {
  const sample = 12;

  it('accepts a whole number of readings after the modern 8-byte header', () => {
    assert.equal(judgeImuFile(8 + sample * 500).verdict, 'ok');
  });

  it('accepts a whole number of readings after the legacy 12-byte header', () => {
    assert.equal(judgeImuFile(12 + sample * 500).verdict, 'ok');
  });

  it('reports a file that stops part-way through a reading', () => {
    const judgement = judgeImuFile(8 + sample * 500 + 5);
    assert.equal(judgement.verdict, 'truncated');
    assert.equal(judgement.recoverable, false);
  });

  it('reports an empty file as empty rather than as damaged', () => {
    assert.equal(judgeImuFile(0).verdict, 'empty');
  });
});

describe('which way the firmware guess fails', () => {
  /**
   * `cardFirmwareProfile` answers "legacy" when it cannot tell, and that is only safe
   * because of the asymmetry below. Pinned so a change to either the judge or the
   * fallback surfaces here rather than as condemned recordings on someone's card.
   */
  const wav = (declaredData: number, actualData: number) => {
    const size = 44 + actualData;
    const header = new Uint8Array(44);
    const view = new DataView(header.buffer);
    const tag = (at: number, text: string) => {
      for (let i = 0; i < 4; i++) header[at + i] = text.charCodeAt(i);
    };
    tag(0, 'RIFF');
    view.setUint32(4, size - 8, true);
    tag(8, 'WAVE');
    tag(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true);
    view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    tag(36, 'data');
    view.setUint32(40, declaredData, true);
    return { size, header };
  };

  it('never condemns a good recording when the firmware is misjudged as legacy', () => {
    const clip = wav(32000, 32000); // written by current firmware
    assert.equal(judgeWavFile(clip.size, clip.header, { correctWavChunkSize: false }).verdict, 'ok');
  });

  it('does raise a false alarm the other way, which is why the fallback is legacy', () => {
    const clip = wav(32004, 32000); // written by legacy firmware, four bytes overstated
    assert.equal(judgeWavFile(clip.size, clip.header, { correctWavChunkSize: false }).verdict, 'ok');
    assert.equal(judgeWavFile(clip.size, clip.header, { correctWavChunkSize: true }).verdict, 'truncated');
  });
});
