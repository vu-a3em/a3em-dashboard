// The database rules, against the Firestore emulator. Run from Web/: npm run test:rules
//
// Every record written here is made by the same function the dashboard uses, so a change to
// what the dashboard stores that the rules would refuse fails here, not in someone's browser.
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, test } from 'node:test';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc } from 'firebase/firestore';
import { createProtocol, defaultConfig, protocolToRecord, PROTOCOL_RECORD_LIMITS } from '@a3em/config-schema';

let env;
before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-a3em',
    firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 8080 },
  });
});
after(() => env.cleanup());
beforeEach(() => env.clearFirestore());

const record = (id = 'p1', name = 'Owls') =>
  protocolToRecord(createProtocol(defaultConfig('UTC'), { id, name, description: 'test', now: new Date().toISOString() }));
const as = (uid) => env.authenticatedContext(uid).firestore();
const mine = (uid, id = 'p1') => doc(as(uid), 'users', uid, 'protocols', id);

test('a person can save, list, read, change and delete their own protocols', async () => {
  await assertSucceeds(setDoc(mine('alice'), record()));
  await assertSucceeds(getDoc(mine('alice')));
  await assertSucceeds(getDocs(collection(as('alice'), 'users', 'alice', 'protocols')));
  await assertSucceeds(setDoc(mine('alice'), { ...record(), version: 2, name: 'Owls, revised' }));
  await assertSucceeds(deleteDoc(mine('alice')));
});

test('nobody else can see or touch them', async () => {
  await env.withSecurityRulesDisabled((context) => setDoc(doc(context.firestore(), 'users', 'alice', 'protocols', 'p1'), record()));
  const bob = as('bob');
  await assertFails(getDoc(doc(bob, 'users', 'alice', 'protocols', 'p1')));
  await assertFails(getDocs(collection(bob, 'users', 'alice', 'protocols')));
  await assertFails(setDoc(doc(bob, 'users', 'alice', 'protocols', 'p1'), record()));
  await assertFails(deleteDoc(doc(bob, 'users', 'alice', 'protocols', 'p1')));
  const anonymous = env.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(anonymous, 'users', 'alice', 'protocols', 'p1')));
  await assertFails(setDoc(doc(anonymous, 'users', 'alice', 'protocols', 'p2'), record('p2')));
});

test('only protocol records, of a sensible size, are accepted', async () => {
  const good = record();
  await assertFails(setDoc(mine('alice'), { ...good, extra: 'field' }));
  const { json, ...missing } = good;
  await assertFails(setDoc(mine('alice'), missing));
  await assertFails(setDoc(mine('alice'), { ...good, version: 0 }));
  await assertFails(setDoc(mine('alice'), { ...good, version: '1' }));
  await assertFails(setDoc(mine('alice'), { ...good, name: 'x'.repeat(PROTOCOL_RECORD_LIMITS.nameLength + 1) }));
  await assertFails(setDoc(mine('alice'), { ...good, json: 'x'.repeat(PROTOCOL_RECORD_LIMITS.jsonBytes + 1) }));
  await assertFails(setDoc(mine('alice', 'x'.repeat(PROTOCOL_RECORD_LIMITS.idLength + 1)), good));
  await assertSucceeds(setDoc(mine('alice'), { ...good, json: json }));
});

test('nothing outside a person’s protocols can be read or written', async () => {
  const alice = as('alice');
  await assertFails(setDoc(doc(alice, 'users', 'alice'), { note: 'profile' }));
  await assertFails(setDoc(doc(alice, 'users', 'alice', 'other', 'x'), { a: 1 }));
  await assertFails(setDoc(doc(alice, 'shared', 'x'), { a: 1 }));
  await assertFails(getDocs(collection(alice, 'users')));
});
