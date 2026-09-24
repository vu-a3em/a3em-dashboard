import { useCallback, useEffect, useState } from 'react';
import { FIREBASE_CONFIG, SIGN_IN_PROVIDERS, type SignInProvider } from './accountConfig';
import type { AccountUser, Connection } from './firebase';

/**
 * The signed-in person, if any.
 *
 * Accounts are optional in the same way the card helper is: everything in the dashboard works
 * signed out, and a deployment with no Firebase project configured offers no sign-in at all.
 * What an account adds is a protocol library that follows the person to any computer.
 *
 *  - `unavailable` — no accounts on this deployment. Nothing is shown.
 *  - `loading` — finding out whether someone is already signed in here.
 *  - `signed-out`, `signed-in` — as they say.
 *
 * The Firebase code is loaded as a separate chunk, only on deployments that have accounts, and
 * as soon as the page starts rather than on the first click: a sign-in popup must open in the
 * click itself, before anything is awaited, or the browser blocks it.
 */

export type AccountStatus = 'unavailable' | 'loading' | 'signed-out' | 'signed-in';

export interface AccountState {
  status: AccountStatus;
  user: AccountUser | null;
  /** Something that went wrong, in words, for the account dialog. */
  error: string | null;
  /** Something that went right and is worth saying, such as a reset link having been sent. */
  notice: string | null;
  busy: boolean;
  dialogOpen: boolean;
}

const EMULATOR = import.meta.env.VITE_FIREBASE_EMULATOR === '1';
const AVAILABLE = FIREBASE_CONFIG !== null || EMULATOR;

export function useAccount() {
  const [state, setState] = useState<AccountState>({
    status: AVAILABLE ? 'loading' : 'unavailable',
    user: null,
    error: null,
    notice: null,
    busy: false,
    dialogOpen: false,
  });
  const [connection, setConnection] = useState<Connection | null>(null);
  const [describe, setDescribe] = useState<((error: unknown) => string | null) | null>(null);

  useEffect(() => {
    if (!AVAILABLE) return undefined;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    import('./firebase')
      .then((module) => {
        if (cancelled) return;
        const connected = module.connect(FIREBASE_CONFIG);
        if (!connected) {
          setState((previous) => ({ ...previous, status: 'unavailable' }));
          return;
        }
        setConnection(connected);
        setDescribe(() => module.describeFirebaseError);
        unsubscribe = connected.onUser((user) =>
          setState((previous) => ({ ...previous, status: user ? 'signed-in' : 'signed-out', user })),
        );
      })
      .catch(() => {
        // The chunk did not load — offline on a first visit, say. Accounts are simply absent.
        if (!cancelled) setState((previous) => ({ ...previous, status: 'unavailable' }));
      });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  /**
   * Runs an account action, keeping `busy` and `error` up to date, and applies `onSuccess` to
   * the state once it has worked. Starts the action synchronously.
   */
  const run = useCallback(
    (action: (connected: Connection) => Promise<void>, onSuccess: Partial<AccountState> = {}) => {
      if (!connection) return;
      setState((previous) => ({ ...previous, busy: true, error: null, notice: null }));
      action(connection)
        .then(() => setState((previous) => ({ ...previous, busy: false, ...onSuccess })))
        .catch((error: unknown) => {
          const message = describe ? describe(error) : String(error);
          setState((previous) => ({ ...previous, busy: false, error: message }));
        });
    },
    [connection, describe],
  );

  const signIn = useCallback(
    (provider: Exclude<SignInProvider, 'password'>) => run((connected) => connected.signIn(provider), { dialogOpen: false }),
    [run],
  );
  const signInWithPassword = useCallback(
    (email: string, password: string) => run((connected) => connected.signInWithPassword(email, password), { dialogOpen: false }),
    [run],
  );
  const createAccount = useCallback(
    (email: string, password: string) =>
      // No notice of its own: the account dialog already asks for the address to be confirmed.
      run((connected) => connected.createAccount(email, password)),
    [run],
  );
  const resetPassword = useCallback(
    (email: string) =>
      run(
        (connected) => connected.resetPassword(email),
        { notice: `If ${email.trim()} has an account, a link to choose a new password is on its way. Check spam if it does not arrive.` },
      ),
    [run],
  );
  const resendVerification = useCallback(
    () => run((connected) => connected.resendVerification(), { notice: 'Sent again. Open the link in the email, then choose “I have confirmed it”.' }),
    [run],
  );
  const refreshUser = useCallback(() => run((connected) => connected.refreshUser()), [run]);
  const signOut = useCallback(() => run((connected) => connected.signOut(), { dialogOpen: false }), [run]);
  const deleteAccount = useCallback(
    (password?: string) =>
      run((connected) => connected.deleteAccount(password), { dialogOpen: false }),
    [run],
  );
  const openDialog = useCallback(() => setState((previous) => ({ ...previous, dialogOpen: true, error: null, notice: null })), []);
  const closeDialog = useCallback(() => setState((previous) => ({ ...previous, dialogOpen: false, error: null, notice: null })), []);

  return {
    ...state,
    providers: SIGN_IN_PROVIDERS,
    connection,
    describeError: describe,
    signIn,
    signInWithPassword,
    createAccount,
    resetPassword,
    resendVerification,
    refreshUser,
    signOut,
    deleteAccount,
    openDialog,
    closeDialog,
  };
}

export type Account = ReturnType<typeof useAccount>;
