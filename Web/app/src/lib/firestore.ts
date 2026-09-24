import type { FirebaseApp } from 'firebase/app';
import {
  clearIndexedDbPersistence,
  collection,
  connectFirestoreEmulator,
  deleteDoc,
  doc,
  getDocsFromServer,
  initializeFirestore,
  onSnapshot,
  persistentLocalCache,
  persistentMultipleTabManager,
  setDoc,
  terminate,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';
import { protocolFromRecord, protocolToRecord, type Protocol, type ProtocolRecord } from '@a3em/config-schema';

/**
 * The account database: each person's protocols in Cloud Firestore, at
 * `users/<uid>/protocols/<id>`, where `firebase/firestore.rules` lets only them in.
 *
 * Its own chunk, loaded by `firebase.ts` the first time someone signed in needs it. Sign-in
 * alone is a fraction of the size, and it is all a signed-out visitor ever downloads: finding out
 * whether anyone is signed in here needs no database.
 *
 * Firestore keeps a copy in this browser (IndexedDB), so an account's protocols stay readable,
 * and edits queue, while offline. `clear` removes that copy, which signing out does, so a shared
 * lab computer does not keep someone's library after they leave.
 */

/** An account's library, as the database last reported it. */
export interface RemoteLibrary {
  protocols: Protocol[];
  /** Names of protocols saved by a dashboard built for another schema, which are not shown. */
  otherSchema: string[];
  unreadable: number;
  /** False while what is shown came from this browser's copy, before the server has answered. */
  fromServer: boolean;
  /** True while edits made here have not yet reached the server. */
  pendingWrites: boolean;
}

export interface Store {
  watch(uid: string, onChange: (library: RemoteLibrary) => void, onError: (error: unknown) => void): () => void;
  /** Resolves once the server has the protocol, which offline is not until back online. */
  save(uid: string, protocol: Protocol): Promise<void>;
  remove(uid: string, id: string): Promise<void>;
  /** Deletes every protocol in the account, from the server rather than from this browser's copy. */
  removeAll(uid: string): Promise<void>;
  /** Forgets this browser's copy of the account's data. */
  clear(): Promise<void>;
}

export function createStore(app: FirebaseApp, emulator: boolean): Store {
  let firestore: Firestore | null = null;
  const database = (): Firestore => {
    if (!firestore) {
      firestore = initializeFirestore(app, {
        localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
      });
      if (emulator) connectFirestoreEmulator(firestore, '127.0.0.1', 8080);
    }
    return firestore;
  };
  const protocols = (uid: string) => collection(database(), 'users', uid, 'protocols');

  return {
    watch(uid, onChange, onError) {
      return onSnapshot(
        protocols(uid),
        { includeMetadataChanges: true },
        (snapshot) => {
          const library: RemoteLibrary = {
            protocols: [],
            otherSchema: [],
            unreadable: 0,
            fromServer: !snapshot.metadata.fromCache,
            pendingWrites: snapshot.metadata.hasPendingWrites,
          };
          for (const entry of snapshot.docs) {
            const reading = protocolFromRecord(entry.id, entry.data() as Partial<ProtocolRecord>);
            if (reading.kind === 'protocol') library.protocols.push(reading.protocol);
            else if (reading.kind === 'other-schema') library.otherSchema.push(reading.name);
            else library.unreadable += 1;
          }
          library.protocols.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
          onChange(library);
        },
        onError,
      );
    },

    async save(uid, protocol) {
      await setDoc(doc(protocols(uid), protocol.id), protocolToRecord(protocol));
    },

    async remove(uid, id) {
      await deleteDoc(doc(protocols(uid), id));
    },

    async removeAll(uid) {
      const snapshot = await getDocsFromServer(protocols(uid));
      for (let start = 0; start < snapshot.docs.length; start += 400) {
        const batch = writeBatch(database());
        for (const entry of snapshot.docs.slice(start, start + 400)) batch.delete(entry.ref);
        await batch.commit();
      }
    },

    async clear() {
      // An instance is made even if none was in use: a copy left by an earlier visit is cleared too.
      const current = database();
      firestore = null;
      await terminate(current);
      try {
        await clearIndexedDbPersistence(current);
      } catch {
        // Another tab of the dashboard still has it open. It is cleared the next time the last
        // tab signs out; nothing in it is readable without signing in as this person anyway.
      }
    },
  };
}
