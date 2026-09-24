import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  connectAuthEmulator,
  deleteUser,
  getAuth,
  GithubAuthProvider,
  GoogleAuthProvider,
  onAuthStateChanged,
  OAuthProvider,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  signInWithCredential,
  signInWithPopup,
  signOut as firebaseSignOut,
  type Auth,
  type AuthProvider,
  type User,
} from 'firebase/auth';
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
import type { FirebaseWebConfig, SignInProvider } from './accountConfig';

/**
 * Everything that talks to Firebase, in one module the rest of the app loads only when this
 * deployment offers accounts. Nothing on the card path imports it.
 *
 * There is no server of our own. Sign-in is Firebase Authentication, in a popup rather than a
 * redirect: the dashboard is not served from Firebase Hosting, and a redirect sign-in breaks in
 * browsers that block third-party storage. Protocols are kept in Cloud Firestore under
 * `users/<uid>/protocols/<id>`, and `firebase/firestore.rules` is what stops one person reading
 * another's.
 *
 * Firestore keeps a copy in this browser (IndexedDB), so an account's protocols stay readable,
 * and edits queue, while offline. Signing out clears that copy, so a shared lab computer does
 * not keep someone's library after they leave.
 */

export interface AccountUser {
  uid: string;
  email: string | null;
  name: string | null;
  provider: SignInProvider | 'other';
}

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

export interface Connection {
  onUser(listener: (user: AccountUser | null) => void): () => void;
  /** Must be called straight from a click: the popup is opened before anything is awaited. */
  signIn(provider: SignInProvider): Promise<void>;
  signOut(): Promise<void>;
  /** Also straight from a click: it asks the person to sign in once more first. */
  deleteAccount(): Promise<void>;
  watchProtocols(uid: string, onChange: (library: RemoteLibrary) => void, onError: (error: unknown) => void): () => void;
  /** Resolves once the server has the protocol, which offline is not until back online. */
  saveProtocol(uid: string, protocol: Protocol): Promise<void>;
  deleteProtocol(uid: string, id: string): Promise<void>;
}

/** Set only in builds made to run against the local emulators (`VITE_FIREBASE_EMULATOR=1`). */
export const EMULATOR = import.meta.env.VITE_FIREBASE_EMULATOR === '1';

const EMULATOR_CONFIG: FirebaseWebConfig = {
  apiKey: 'demo-key',
  authDomain: 'demo-a3em.firebaseapp.com',
  projectId: 'demo-a3em',
  appId: 'demo-app',
};

let connection: Connection | null = null;

/** The one connection for this page. Safe to call more than once. */
export function connect(config: FirebaseWebConfig | null): Connection | null {
  if (connection) return connection;
  const settings = EMULATOR ? EMULATOR_CONFIG : config;
  if (!settings) return null;

  const app: FirebaseApp = initializeApp(settings);
  const auth: Auth = getAuth(app);
  if (EMULATOR) connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });

  let firestore: Firestore | null = null;
  const database = (): Firestore => {
    if (!firestore) {
      firestore = initializeFirestore(app, {
        localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
      });
      if (EMULATOR) connectFirestoreEmulator(firestore, '127.0.0.1', 8080);
    }
    return firestore;
  };

  /** Forgets this browser's copy of the account's data. */
  const clearLocalCopy = async () => {
    const current = firestore;
    firestore = null;
    if (!current) return;
    await terminate(current);
    try {
      await clearIndexedDbPersistence(current);
    } catch {
      // Another tab of the dashboard still has it open. It is cleared the next time the last
      // tab signs out; nothing in it is readable without signing in as this person anyway.
    }
  };

  const protocols = (uid: string) => collection(database(), 'users', uid, 'protocols');

  connection = {
    onUser(listener) {
      return onAuthStateChanged(auth, (user) => listener(user ? describeUser(user) : null));
    },

    async signIn(provider) {
      if (EMULATOR) {
        await signInWithCredential(auth, emulatorCredential());
        return;
      }
      await signInWithPopup(auth, providerFor(provider));
    },

    async signOut() {
      await firebaseSignOut(auth);
      await clearLocalCopy();
    },

    async deleteAccount() {
      const user = auth.currentUser;
      if (!user) return;
      // Firebase refuses to delete an account signed into more than a few minutes ago, so ask
      // for the sign-in first, while this is still the click, rather than after the data is gone.
      if (EMULATOR) await reauthenticateWithCredential(user, emulatorCredential());
      else await reauthenticateWithPopup(user, providerFor(describeUser(user).provider));
      const snapshot = await getDocsFromServer(protocols(user.uid));
      for (let start = 0; start < snapshot.docs.length; start += 400) {
        const batch = writeBatch(database());
        for (const entry of snapshot.docs.slice(start, start + 400)) batch.delete(entry.ref);
        await batch.commit();
      }
      await deleteUser(user);
      await clearLocalCopy();
    },

    watchProtocols(uid, onChange, onError) {
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

    async saveProtocol(uid, protocol) {
      await setDoc(doc(protocols(uid), protocol.id), protocolToRecord(protocol));
    },

    async deleteProtocol(uid, id) {
      await deleteDoc(doc(protocols(uid), id));
    },
  };
  return connection;
}

function providerFor(provider: AccountUser['provider']): AuthProvider {
  switch (provider) {
    case 'github':
      return new GithubAuthProvider();
    case 'microsoft':
      return new OAuthProvider('microsoft.com');
    default: {
      const google = new GoogleAuthProvider();
      google.setCustomParameters({ prompt: 'select_account' });
      return google;
    }
  }
}

function describeUser(user: User): AccountUser {
  const provider = user.providerData[0]?.providerId;
  return {
    uid: user.uid,
    email: user.email ?? user.providerData.find((entry) => entry.email)?.email ?? null,
    name: user.displayName,
    provider:
      provider === 'google.com' ? 'google' : provider === 'github.com' ? 'github' : provider === 'microsoft.com' ? 'microsoft' : 'other',
  };
}

/**
 * A sign-in the Auth emulator accepts without a popup: an unsigned Google token for the test
 * user the page names in `window.__a3emTestUser`. Only in emulator builds.
 */
function emulatorCredential() {
  const user = (globalThis as { __a3emTestUser?: { sub: string; email: string; name?: string } }).__a3emTestUser ?? {
    sub: 'test-user',
    email: 'test@example.com',
  };
  return GoogleAuthProvider.credential(JSON.stringify({ ...user, email_verified: true }));
}

/** A sign-in or database failure, in words for the person at the keyboard. */
export function describeFirebaseError(error: unknown): string | null {
  const code = (error as { code?: string })?.code ?? '';
  switch (code) {
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
    case 'auth/user-cancelled':
      return null;
    case 'auth/popup-blocked':
      return 'Your browser blocked the sign-in window. Allow pop-ups for this site, then try again.';
    case 'auth/account-exists-with-different-credential':
      return 'That email address already has an account through a different sign-in method. Sign in the way you did before.';
    case 'auth/unauthorized-domain':
      return 'This site is not yet allowed to sign people in. Its address needs adding to the Firebase project’s authorized domains.';
    case 'auth/operation-not-allowed':
      return 'That sign-in method is not switched on for this site yet.';
    case 'auth/network-request-failed':
    case 'unavailable':
      return 'The account service could not be reached. Check the connection and try again.';
    case 'auth/user-mismatch':
      return 'That was a different account. Sign in as the account you are deleting.';
    case 'permission-denied':
      return 'The account service refused the request.';
    case 'resource-exhausted':
      return 'The account service has reached its free daily limit. Changes will save again tomorrow.';
  }
  return error instanceof Error ? error.message : String(error);
}
