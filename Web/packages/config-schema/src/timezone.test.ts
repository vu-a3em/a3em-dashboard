import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fromZonedInput, toZonedInput } from './timezone.js';

describe('datetime-local fields in the deployment zone', () => {
  it('reads a wall-clock time as the deployment zone, not the browser zone', () => {
    // The reported bug: Africa/Nairobi + "Feb 06 2026, 03:00 AM" wrote 1770368400, which
    // is 03:00 in America/Chicago — the machine's zone — and 12:00 in Nairobi.
    const instant = fromZonedInput('2026-02-06T03:00', 'Africa/Nairobi');
    assert.equal(instant, '2026-02-06T00:00:00.000Z');
    assert.equal(Date.parse(instant) / 1000, 1770336000);
    assert.notEqual(Date.parse(instant) / 1000, 1770368400);
  });

  it('round-trips through the input and back', () => {
    for (const zone of ['Africa/Nairobi', 'America/Chicago', 'Asia/Kolkata', 'UTC']) {
      const shown = toZonedInput('2026-02-06T00:00:00.000Z', zone);
      assert.equal(fromZonedInput(shown, zone), '2026-02-06T00:00:00.000Z');
    }
  });

  it('shows an instant as the zone reads it', () => {
    assert.equal(toZonedInput('2026-02-06T00:00:00.000Z', 'Africa/Nairobi'), '2026-02-06T03:00');
    assert.equal(toZonedInput('2026-02-06T00:00:00.000Z', 'America/Chicago'), '2026-02-05T18:00');
    // A half-hour zone, which a naive whole-hour offset would get wrong.
    assert.equal(toZonedInput('2026-02-06T00:00:00.000Z', 'Asia/Kolkata'), '2026-02-06T05:30');
  });

  it('resolves times either side of a daylight-saving change', () => {
    // US DST began 2026-03-08. 01:30 is before it, 03:30 after, and the offset differs.
    assert.equal(fromZonedInput('2026-03-08T01:30', 'America/Chicago'), '2026-03-08T07:30:00.000Z');
    assert.equal(fromZonedInput('2026-03-08T03:30', 'America/Chicago'), '2026-03-08T08:30:00.000Z');
  });
})
