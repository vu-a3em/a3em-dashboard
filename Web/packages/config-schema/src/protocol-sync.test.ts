import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultConfig } from './defaults.js';
import { CONFIG_SCHEMA_VERSION } from './firmware-constants.js';
import { createProtocol, updateProtocol, type Protocol } from './protocol.js';
import { joinLibraries, protocolFromRecord, protocolToRecord, PROTOCOL_RECORD_LIMITS } from './protocol-sync.js';

const config = defaultConfig('UTC', new Date('2026-01-01T00:00:00Z'));
const make = (id: string, name = id): Protocol =>
  createProtocol(config, { id, name, description: 'test', now: '2026-01-01T00:00:00.000Z' });

test('a protocol survives the round trip to an account exactly', () => {
  const protocol = updateProtocol(make('p1', 'Owls'), config, '2026-02-01T00:00:00.000Z');
  const record = protocolToRecord(protocol);
  assert.equal(record.schemaVersion, CONFIG_SCHEMA_VERSION);
  assert.equal(record.version, 2);
  assert.equal(record.name, 'Owls');
  const back = protocolFromRecord('p1', record);
  assert.equal(back.kind, 'protocol');
  // Exactly as the browser's own library keeps it: JSON, where an absent value is simply absent.
  assert.deepEqual(back.kind === 'protocol' ? back.protocol : null, JSON.parse(JSON.stringify(protocol)));
});

test('a record from another schema is set aside, not shown and not lost', () => {
  const record = { ...protocolToRecord(make('p1', 'Owls')), schemaVersion: CONFIG_SCHEMA_VERSION + 1 };
  assert.deepEqual(protocolFromRecord('p1', record), { kind: 'other-schema', name: 'Owls' });
});

test('damaged records are refused rather than applied', () => {
  assert.equal(protocolFromRecord('p1', undefined).kind, 'unreadable');
  assert.equal(protocolFromRecord('p1', { ...protocolToRecord(make('p1')), json: '{not json' }).kind, 'unreadable');
  // Stored under one name, claiming another: not trusted.
  assert.equal(protocolFromRecord('p2', protocolToRecord(make('p1'))).kind, 'unreadable');
});

test('an oversized protocol is refused with its name before the database refuses it', () => {
  const huge = { ...make('p1', 'Huge'), description: 'x'.repeat(PROTOCOL_RECORD_LIMITS.jsonBytes) };
  assert.throws(() => protocolToRecord(huge), /Huge/);
});

test('joining uploads what the account lacks or holds older, and keeps what it holds newer', () => {
  const onlyHere = make('a');
  const newerHere = updateProtocol(make('b'), config, '2026-03-01T00:00:00.000Z');
  const newerThere = make('c');
  const same = make('d');
  const remote = [make('b'), updateProtocol(newerThere, config, '2026-03-01T00:00:00.000Z'), same, make('e')];
  const join = joinLibraries([onlyHere, newerHere, newerThere, same], remote);
  assert.deepEqual(join.upload.map((p) => p.id), ['a', 'b']);
  assert.deepEqual(join.alreadyThere.map((p) => p.id), ['c', 'd']);
});

test('built-in protocols are never uploaded', () => {
  const builtIn = { ...make('starter'), builtIn: true };
  assert.deepEqual(joinLibraries([builtIn], []), { upload: [], alreadyThere: [] });
});
