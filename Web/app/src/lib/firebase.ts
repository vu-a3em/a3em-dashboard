import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  deleteUser,
  EmailAuthProvider,
  getAuth,
  GithubAuthProvider,
  GoogleAuthProvider,
  onAuthStateChanged,
  OAuthProvider,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  revokeAccessToken,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithCredential,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as firebaseSignOut,
  type Auth,
  type AuthProvider,
  type User,
} from 'firebase/auth';
import type { Protocol } from '@a3em/config-schema';
import type { FirebaseWebConfig, SignInProvider } from './accountConfig';
import type { RemoteLibrary, Store } from './firestore';

export type { RemoteLibrary } from './firestore';

/**
 * Everything that talks to Firebase, in one module the rest of the app loads only when this
 * deployment offers accounts. Nothing on the card path imports it.
 *
 * There is no server of our own. Sign-in is Firebase Authentication, in a popup rather than a
 * redirect: the dashboard is not served from Firebase Hosting, and a redirect sign-in breaks in
 * browsers that block third-party storage. Protocols are kept in Cloud Firestore, by
 * `firestore.ts`, which is loaded only once someone signs in: it is four times the size of
 * sign-in, and a signed-out visitor never needs it.
 */

export interface AccountUser {
  uid: string;
  email: string | null;
  name: string | null;
  provider: SignInProvider | 'other';
  /** False for an email-and-password account whose address has not been confirmed yet. */
  emailVerified: boolean;
}

export interface Connection {
  onUser(listener: (user: AccountUser | null) => void): () => void;
  /** Must be called straight from a click: the popup is opened before anything is awaited. */
  signIn(provider: Exclude<SignInProvider, 'password'>): Promise<void>;
  signInWithPassword(email: string, password: string): Promise<void>;
  /** Creates an email-and-password account, signs in, and sends the address a confirmation link. */
  createAccount(email: string, password: string): Promise<void>;
  /** Sends a reset link. Says nothing about whether the address has an account. */
  resetPassword(email: string): Promise<void>;
  resendVerification(): Promise<void>;
  /** Re-reads the signed-in account, to notice an address confirmed in another tab. */
  refreshUser(): Promise<void>;
  signOut(): Promise<void>;
  /**
   * Also straight from a click: it asks the person to sign in once more first — with a popup,
   * or with `password` for an email-and-password account.
   */
  deleteAccount(password?: string): Promise<void>;
  watchProtocols(uid: string, onChange: (library: RemoteLibrary) => void, onError: (error: unknown) => void): () => void;
  /** Resolves once the server has the protocol, which offline is not until back online. */
  saveProtocol(uid: string, protocol: Protocol): Promise<void>;
  deleteProtocol(uid: string, id: string): Promise<void>;
}

/** The shortest password an email account may have. Firebase itself allows six. */
export const MIN_PASSWORD_LENGTH = 8;

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

  /** The account database, fetched the first time it is needed. */
  let loading: Promise<Store> | null = null;
  const store = (): Promise<Store> => {
    if (!loading) {
      loading = import('./firestore').then((module) => module.createStore(app, EMULATOR));
      // A failed load (offline, say) is not remembered, so the next attempt tries again.
      loading.catch(() => {
        loading = null;
      });
    }
    return loading;
  };

  const listeners = new Set<(user: AccountUser | null) => void>();
  connection = {
    onUser(listener) {
      listeners.add(listener);
      const unsubscribe = onAuthStateChanged(auth, (user) => listener(user ? describeUser(user) : null));
      return () => {
        listeners.delete(listener);
        unsubscribe();
      };
    },

    async refreshUser() {
      const user = auth.currentUser;
      if (!user) return;
      await user.reload();
      for (const listener of listeners) listener(describeUser(user));
    },

    async signIn(provider) {
      if (EMULATOR) {
        await signInWithCredential(auth, emulatorCredential());
        return;
      }
      await signInWithPopup(auth, providerFor(provider));
    },

    async signInWithPassword(email, password) {
      await signInWithEmailAndPassword(auth, email.trim(), password);
    },

    async createAccount(email, password) {
      const { user } = await createUserWithEmailAndPassword(auth, email.trim(), password);
      // Not a condition of using the account: the address is confirmed so that a mistyped one
      // is noticed while it can still be fixed, and so a password reset has somewhere to go.
      await sendEmailVerification(user, { url: continueUrl() }).catch(() => undefined);
    },

    async resetPassword(email) {
      await sendPasswordResetEmail(auth, email.trim(), { url: continueUrl() });
    },

    async resendVerification() {
      if (auth.currentUser) await sendEmailVerification(auth.currentUser, { url: continueUrl() });
    },

    async signOut() {
      await firebaseSignOut(auth);
      // Signed out either way. If the database code cannot be fetched to clear this browser's
      // copy, the copy stays until the next sign-out; it is unreadable without signing in.
      await store()
        .then((database) => database.clear())
        .catch(() => undefined);
    },

    async deleteAccount(password) {
      const user = auth.currentUser;
      if (!user) return;
      const provider = describeUser(user).provider;
      // Firebase refuses to delete an account signed into more than a few minutes ago, so ask
      // for the sign-in first, while this is still the click, rather than after the data is gone.
      let appleToken: string | undefined;
      if (provider === 'password') {
        await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email ?? '', password ?? ''));
      } else if (EMULATOR) {
        await reauthenticateWithCredential(user, emulatorCredential());
      } else {
        const result = await reauthenticateWithPopup(user, providerFor(provider));
        appleToken = provider === 'apple' ? (OAuthProvider.credentialFromResult(result)?.accessToken ?? undefined) : undefined;
      }
      const database = await store();
      await database.removeAll(user.uid);
      // Apple asks that an app deleting an account also withdraw its access to the Apple ID, so
      // the person's Apple settings stop listing the dashboard as signed in.
      if (appleToken) await revokeAccessToken(auth, appleToken).catch(() => undefined);
      await deleteUser(user);
      await database.clear();
    },

    watchProtocols(uid, onChange, onError) {
      let unsubscribe: (() => void) | null = null;
      let stopped = false;
      store()
        .then((database) => {
          if (!stopped) unsubscribe = database.watch(uid, onChange, onError);
        })
        .catch(onError);
      return () => {
        stopped = true;
        unsubscribe?.();
      };
    },

    async saveProtocol(uid, protocol) {
      await (await store()).save(uid, protocol);
    },

    async deleteProtocol(uid, id) {
      await (await store()).remove(uid, id);
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
    case 'apple': {
      const apple = new OAuthProvider('apple.com');
      apple.addScope('email');
      apple.addScope('name');
      return apple;
    }
    default: {
      const google = new GoogleAuthProvider();
      google.setCustomParameters({ prompt: 'select_account' });
      return google;
    }
  }
}

const PROVIDER_IDS: Record<string, SignInProvider> = {
  'google.com': 'google',
  'github.com': 'github',
  'apple.com': 'apple',
  'microsoft.com': 'microsoft',
  password: 'password',
};

function describeUser(user: User): AccountUser {
  const provider = PROVIDER_IDS[user.providerData[0]?.providerId ?? ''] ?? 'other';
  return {
    uid: user.uid,
    email: user.email ?? user.providerData.find((entry) => entry.email)?.email ?? null,
    name: user.displayName,
    provider,
    // Only a password account's address can be unconfirmed; the others vouch for their own.
    emailVerified: provider !== 'password' || user.emailVerified,
  };
}

/** Where the links in confirmation and reset emails return to: this dashboard. */
function continueUrl(): string {
  return `${location.origin}${location.pathname}`;
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
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'That email address and password do not match an account.';
    case 'auth/email-already-in-use':
      return 'That email address already has an account. Sign in instead, or reset its password.';
    case 'auth/invalid-email':
      return 'That is not a valid email address.';
    case 'auth/missing-password':
      return 'Enter the password.';
    case 'auth/weak-password':
    case 'auth/password-does-not-meet-requirements':
      return `Choose a longer password: at least ${MIN_PASSWORD_LENGTH} characters.`;
    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a few minutes, or reset the password.';
    case 'auth/requires-recent-login':
      return 'Sign in again, then try once more.';
    case 'permission-denied':
      return 'The account service refused the request.';
    case 'resource-exhausted':
      return 'The account service has reached its free daily limit. Changes will save again tomorrow.';
  }
  return error instanceof Error ? error.message : String(error);
}
