import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeMessage, MessageReader, MessageTooLargeError, MAX_MESSAGE_BYTES } from './protocol.js';

/**
 * Framing.
 *
 * The failure worth testing for is the one that only appears under load: a length prefix
 * or a body split across two `data` events. Treating each event as a message works
 * perfectly in development and corrupts the stream in the field.
 */

test('a message round-trips', () => {
  const reader = new MessageReader();
  const messages = reader.push(encodeMessage({ id: '1', op: 'hello' }));
  assert.deepEqual(messages, [{ id: '1', op: 'hello' }]);
});

test('several messages in one chunk all arrive', () => {
  const reader = new MessageReader();
  const chunk = Buffer.concat([
    encodeMessage({ id: '1', op: 'hello' }),
    encodeMessage({ id: '2', op: 'listDevices' }),
  ]);
  assert.deepEqual(reader.push(chunk), [
    { id: '1', op: 'hello' },
    { id: '2', op: 'listDevices' },
  ]);
});

test('a message split mid-body is reassembled', () => {
  const reader = new MessageReader();
  const encoded = encodeMessage({ id: '1', op: 'listDevices' });
  assert.deepEqual(reader.push(encoded.subarray(0, 7)), []);
  assert.deepEqual(reader.push(encoded.subarray(7)), [{ id: '1', op: 'listDevices' }]);
});

test('a message split inside its length prefix is reassembled', () => {
  const reader = new MessageReader();
  const encoded = encodeMessage({ id: '1', op: 'hello' });
  assert.deepEqual(reader.push(encoded.subarray(0, 2)), []);
  assert.deepEqual(reader.push(encoded.subarray(2)), [{ id: '1', op: 'hello' }]);
});

test('a byte-at-a-time stream still yields exactly one message', () => {
  const reader = new MessageReader();
  const encoded = encodeMessage({ id: '1', op: 'hello' });
  const seen: unknown[] = [];
  for (const byte of encoded) seen.push(...reader.push(Buffer.from([byte])));
  assert.deepEqual(seen, [{ id: '1', op: 'hello' }]);
});

test('a response over the 1 MB limit is refused rather than truncated', () => {
  // Chrome caps host-to-extension messages at 1 MB. Silently truncating would hand the
  // page malformed JSON; failing loudly is what keeps card listings paged.
  assert.throws(
    () => encodeMessage({ id: '1', blob: 'x'.repeat(MAX_MESSAGE_BYTES) }),
    MessageTooLargeError,
  );
});

test('an absurd length prefix is rejected instead of allocating against it', () => {
  const reader = new MessageReader();
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(0xffffffff, 0);
  assert.throws(() => reader.push(header), /not framed correctly/);
});
