import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  applyActionCode,
  checkActionCode,
  confirmPasswordReset,
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  deleteUser,
  EmailAuthProvider,
  getAuth,
  GithubAuthProvider,
  GoogleAuthProvider,
  linkWithCredential,
  linkWithPopup,
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
  unlink,
  updatePassword,
  verifyPasswordResetCode,
  type Auth,
  type AuthCredential,
  type AuthProvider,
  type User,
} from 'firebase/auth';
import type { Protocol } from '@a3em/config-schema';
import type { FirebaseWebConfig, SignInProvider } from './accountConfig';
import type { RemoteLibrary, Store } from './firestore';
import { isPopupProvider, PROVIDER_ID, type PopupProvider } from './signInProviders';

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
 *
 * One person, one account, however they sign in. Firebase keeps one account per email address,
 * so signing in a new way with an address that already has an account is refused — and the new
 * sign-in is then held and added to that account as soon as the person signs in the way they did
 * before. They can also add and remove ways of signing in from their account settings.
 *
 * The links in Firebase's emails can come back here, to be completed in the dashboard (see
 * `readEmailAction`), rather than on Firebase's own page. Nothing is used up until the person
 * presses a button: mail scanners that open every link — Microsoft's Safe Links does — would
 * otherwise spend a confirmation link before its owner ever saw it.
 */

export interface AccountUser {
  uid: string;
  email: string | null;
  name: string | null;
  /** Every way this account can be signed into, in the order they were added. */
  providers: SignInProvider[];
  /** False while an account with a password has an address not yet confirmed. */
  emailVerified: boolean;
}

/** What a finished sign-in did beyond signing in. */
export interface SignInResult {
  /** A sign-in method held from an earlier attempt and now added to this account. */
  linked: PopupProvider | null;
}

/**
 * Thrown when a sign-in finds its email address already has an account through another method.
 * The attempted method is held, and added to that account at the next successful sign-in.
 */
export class LinkNeeded extends Error {
  readonly code = 'a3em/link-needed';
  constructor(
    readonly provider: PopupProvider,
    readonly email: string | null,
  ) {
    super('That email address already has an account through a different sign-in method.');
  }
}

/** An email link, read without using it up. */
export type EmailAction =
  | { mode: 'verifyEmail'; code: string; email: string | null; valid: true }
  | { mode: 'resetPassword'; code: string; email: string; valid: true }
  | {
      mode: 'verifyEmail' | 'resetPassword' | 'other';
      code: string;
      valid: false;
      /** For a used confirmation link: whether the signed-in account's address is confirmed anyway. */
      alreadyVerified: boolean;
    };

export interface Connection {
  onUser(listener: (user: AccountUser | null) => void): () => void;
  /** Must be called straight from a click: the popup is opened before anything is awaited. */
  signIn(provider: PopupProvider): Promise<SignInResult>;
  signInWithPassword(email: string, password: string): Promise<SignInResult>;
  /** Creates an email-and-password account, signs in, and sends the address a confirmation link. */
  createAccount(email: string, password: string): Promise<void>;
  /** Sends a reset link. Says nothing about whether the address has an account. */
  resetPassword(email: string): Promise<void>;
  resendVerification(): Promise<void>;
  /** Re-reads the signed-in account, to notice an address confirmed in another tab. */
  refreshUser(): Promise<AccountUser | null>;
  /** Forgets a sign-in method held by `LinkNeeded`. */
  cancelPendingLink(): void;
  /** Adds a way of signing in to the signed-in account. Straight from a click. */
  linkProvider(provider: PopupProvider): Promise<void>;
  /**
   * Adds a password to the signed-in account, for its own email address, and sends that address
   * a confirmation link if it has not been confirmed yet.
   */
  linkPassword(password: string): Promise<{ verificationSent: boolean }>;
  unlinkProvider(provider: SignInProvider): Promise<void>;
  /** What an email link in the page's address asks for, without using it up. */
  readEmailAction(mode: string, code: string): Promise<EmailAction>;
  confirmEmail(code: string): Promise<void>;
  setNewPassword(code: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  /**
   * Also straight from a click: it asks the person to sign in once more first — with a popup, or
   * with `password` for an account that has only a password.
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
  /** Tells everyone about a change to the account that is not a sign-in or sign-out. */
  const announce = (user: User | null) => {
    const described = user ? describeUser(user) : null;
    for (const listener of listeners) listener(described);
    return described;
  };

  /** A sign-in method refused for an existing email address, waiting to be added to it. */
  let pending: { credential: AuthCredential; provider: PopupProvider } | null = null;
  const addPending = async (user: User): Promise<SignInResult> => {
    if (!pending) return { linked: null };
    const { credential, provider } = pending;
    pending = null;
    await linkWithCredential(user, credential);
    announce(user);
    return { linked: provider };
  };

  const currentUser = (): User => {
    const user = auth.currentUser;
    if (!user) throw Object.assign(new Error('Nobody is signed in.'), { code: 'auth/no-current-user' });
    return user;
  };

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
      if (!user) return null;
      await user.reload();
      return announce(user);
    },

    async signIn(provider) {
      try {
        const result = EMULATOR
          ? await signInWithCredential(auth, emulatorCredential(provider))
          : await signInWithPopup(auth, providerFor(provider));
        return await addPending(result.user);
      } catch (error) {
        if ((error as { code?: string }).code === 'auth/account-exists-with-different-credential') {
          const credential = credentialFromError(provider, error);
          if (credential) {
            pending = { credential, provider };
            const email = (error as { customData?: { email?: string } }).customData?.email ?? null;
            throw new LinkNeeded(provider, email);
          }
        }
        throw error;
      }
    },

    async signInWithPassword(email, password) {
      const result = await signInWithEmailAndPassword(auth, email.trim(), password);
      return addPending(result.user);
    },

    async createAccount(email, password) {
      pending = null;
      const { user } = await createUserWithEmailAndPassword(auth, email.trim(), password);
      // Not a condition of using the account: the address is confirmed so that a mistyped one
      // is noticed while it can still be fixed, and so a password reset has somewhere to go.
      await sendEmailVerification(user, { url: continueUrl() }).catch(() => undefined);
    },

    async resetPassword(email) {
      await sendPasswordResetEmail(auth, email.trim(), { url: continueUrl() });
    },

    async resendVerification() {
      await sendEmailVerification(currentUser(), { url: continueUrl() });
    },

    cancelPendingLink() {
      pending = null;
    },

    async linkProvider(provider) {
      const user = currentUser();
      if (EMULATOR) await linkWithCredential(user, emulatorCredential(provider));
      else await linkWithPopup(user, providerFor(provider));
      announce(user);
    },

    async linkPassword(password) {
      const user = currentUser();
      if (!user.email) throw Object.assign(new Error('This account has no email address to go with a password.'), { code: 'a3em/no-email' });
      try {
        await linkWithCredential(user, EmailAuthProvider.credential(user.email, password));
      } catch (error) {
        // The account's own address can come back as taken, because the account already uses it
        // (the Auth emulator always does this). With one account per address it cannot belong to
        // anyone else, so setting the password on this account directly is the same outcome.
        if ((error as { code?: string }).code !== 'auth/email-already-in-use') throw error;
        await updatePassword(user, password);
      }
      await user.reload();
      // A password makes the address matter: it is where a reset link would go. An address the
      // sign-in providers have not vouched for is asked to confirm itself, as for a new account.
      let verificationSent = false;
      if (!user.emailVerified) {
        await sendEmailVerification(user, { url: continueUrl() });
        verificationSent = true;
      }
      announce(user);
      return { verificationSent };
    },

    async unlinkProvider(provider) {
      const user = currentUser();
      await unlink(user, PROVIDER_ID[provider]);
      announce(user);
    },

    async readEmailAction(mode, code) {
      // Whoever was signed in here may not be known yet when the page has only just loaded.
      await auth.authStateReady();
      try {
        if (mode === 'resetPassword') return { mode, code, email: await verifyPasswordResetCode(auth, code), valid: true };
        if (mode === 'verifyEmail') {
          const info = await checkActionCode(auth, code);
          return { mode, code, email: info.data.email ?? null, valid: true };
        }
        return { mode: 'other', code, valid: false, alreadyVerified: false };
      } catch {
        // Used, expired, or mangled. A used confirmation link has usually done its job already —
        // opened by a mail scanner, or by an earlier click — so say so where that can be known.
        let alreadyVerified = false;
        if (mode === 'verifyEmail' && auth.currentUser) {
          await auth.currentUser.reload().catch(() => undefined);
          alreadyVerified = auth.currentUser.emailVerified;
          announce(auth.currentUser);
        }
        return { mode: mode === 'verifyEmail' || mode === 'resetPassword' ? mode : 'other', code, valid: false, alreadyVerified };
      }
    },

    async confirmEmail(code) {
      await applyActionCode(auth, code);
      if (auth.currentUser) {
        await auth.currentUser.reload().catch(() => undefined);
        announce(auth.currentUser);
      }
    },

    async setNewPassword(code, password) {
      await confirmPasswordReset(auth, code, password);
    },

    async signOut() {
      pending = null;
      await firebaseSignOut(auth);
      // Signed out either way. If the database code cannot be fetched to clear this browser's
      // copy, the copy stays until the next sign-out; it is unreadable without signing in.
      await store()
        .then((database) => database.clear())
        .catch(() => undefined);
    },

    async deleteAccount(password) {
      const user = currentUser();
      const providers = describeUser(user).providers;
      const popup = providers.find(isPopupProvider);
      // Firebase refuses to delete an account signed into more than a few minutes ago, so ask
      // for the sign-in first, while this is still the click, rather than after the data is gone.
      let appleToken: string | undefined;
      if (!popup || password) {
        await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email ?? '', password ?? ''));
      } else if (EMULATOR) {
        await reauthenticateWithCredential(user, emulatorCredential(popup));
      } else {
        const result = await reauthenticateWithPopup(user, providerFor(popup));
        appleToken = popup === 'apple' ? (OAuthProvider.credentialFromResult(result)?.accessToken ?? undefined) : undefined;
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

function providerFor(provider: PopupProvider): AuthProvider {
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

/** The credential a refused sign-in carried, so it can be added to the existing account. */
function credentialFromError(provider: PopupProvider, error: unknown): AuthCredential | null {
  const failure = error as Parameters<typeof OAuthProvider.credentialFromError>[0];
  if (provider === 'google') return GoogleAuthProvider.credentialFromError(failure);
  if (provider === 'github') return GithubAuthProvider.credentialFromError(failure) ?? OAuthProvider.credentialFromError(failure);
  return OAuthProvider.credentialFromError(failure);
}

const PROVIDERS_BY_ID: Record<string, SignInProvider> = Object.fromEntries(
  Object.entries(PROVIDER_ID).map(([provider, id]) => [id, provider as SignInProvider]),
);

function describeUser(user: User): AccountUser {
  const providers = user.providerData
    .map((entry) => PROVIDERS_BY_ID[entry.providerId])
    .filter((provider): provider is SignInProvider => Boolean(provider));
  return {
    uid: user.uid,
    email: user.email ?? user.providerData.find((entry) => entry.email)?.email ?? null,
    name: user.displayName ?? user.providerData.find((entry) => entry.displayName)?.displayName ?? null,
    providers,
    // Only an address that came with a password can be unconfirmed; the providers vouch for theirs.
    emailVerified: user.emailVerified || !providers.includes('password'),
  };
}

/** Where the links in confirmation and reset emails return to: this dashboard. */
function continueUrl(): string {
  return `${location.origin}${location.pathname}`;
}

type TestUser = { sub: string; email: string; name?: string; email_verified?: boolean };

/**
 * A sign-in the Auth emulator accepts without a popup: an unsigned token for the test user the
 * page names, in `window.__a3emTestUsers[provider]` or `window.__a3emTestUser`. Emulator builds only.
 */
function emulatorCredential(provider: PopupProvider): AuthCredential {
  const page = globalThis as { __a3emTestUsers?: Partial<Record<PopupProvider, TestUser>>; __a3emTestUser?: TestUser };
  const user = page.__a3emTestUsers?.[provider] ?? page.__a3emTestUser ?? { sub: 'test-user', email: 'test@example.com' };
  const token = JSON.stringify({ email_verified: provider === 'google', ...user });
  if (provider === 'google') return GoogleAuthProvider.credential(token);
  return new OAuthProvider(PROVIDER_ID[provider]).credential({ idToken: token });
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
    case 'auth/credential-already-in-use':
      return 'That sign-in already belongs to a different account here, so it cannot be added to this one.';
    case 'auth/provider-already-linked':
      return 'That way of signing in is already part of this account.';
    case 'auth/no-such-provider':
      return 'That way of signing in is not part of this account.';
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
      return 'For your security, sign out and sign in again, then try once more.';
    case 'auth/invalid-action-code':
    case 'auth/expired-action-code':
      return 'This link has expired or has already been used.';
    case 'permission-denied':
      return 'The account service refused the request.';
    case 'resource-exhausted':
      return 'The account service has reached its free daily limit. Changes will save again tomorrow.';
  }
  return error instanceof Error ? error.message : String(error);
}
