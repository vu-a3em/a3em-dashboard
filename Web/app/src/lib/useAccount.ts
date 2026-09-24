import { useCallback, useEffect, useState } from 'react';
import { FIREBASE_CONFIG, SIGN_IN_PROVIDERS } from './accountConfig';
import type { AccountUser, Connection, EmailAction, SignInResult } from './firebase';
import { PROVIDER_NAME, type PopupProvider } from './signInProviders';

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
 *
 * It also picks up the links in Firebase's emails. With the Firebase project's action URL set to
 * this dashboard, a confirmation or password-reset link opens the dashboard with
 * `?mode=…&oobCode=…`, which is read here, taken out of the address bar, and completed in the
 * account dialog.
 */

export type AccountStatus = 'unavailable' | 'loading' | 'signed-out' | 'signed-in';

/** An email link being completed in the dashboard. */
export type EmailActionState = { stage: 'checking'; mode: string } | { stage: 'ready' | 'done'; action: EmailAction };

export interface AccountState {
  status: AccountStatus;
  user: AccountUser | null;
  /** Something that went wrong, in words, for the account dialog. */
  error: string | null;
  /** Something that went right and is worth saying, such as a reset link having been sent. */
  notice: string | null;
  busy: boolean;
  dialogOpen: boolean;
  /** A sign-in refused for an existing address, to be added once the person signs in as before. */
  pendingLink: { provider: PopupProvider; email: string | null } | null;
  emailAction: EmailActionState | null;
}

const EMULATOR = import.meta.env.VITE_FIREBASE_EMULATOR === '1';
const AVAILABLE = FIREBASE_CONFIG !== null || EMULATOR;

/** Takes an email link's parameters out of the address bar, leaving everything else. */
function takeEmailLink(): { mode: string; code: string } | null {
  const params = new URLSearchParams(location.search);
  const mode = params.get('mode');
  const code = params.get('oobCode');
  if (!mode || !code) return null;
  for (const key of ['mode', 'oobCode', 'apiKey', 'continueUrl', 'lang', 'tenantId']) params.delete(key);
  const rest = params.toString();
  const query = rest ? '?' + rest : '';
  history.replaceState(history.state, '', location.pathname + query + location.hash);
  return { mode, code };
}

/** A finished sign-in: the dialog closes, unless there is something to say about linking. */
function afterSignIn(result: SignInResult): Partial<AccountState> {
  const notice = result.linked
    ? `${PROVIDER_NAME[result.linked]} is now part of your account, so either way of signing in works.`
    : null;
  return { pendingLink: null, notice, dialogOpen: Boolean(notice) };
}

export function useAccount() {
  const [state, setState] = useState<AccountState>({
    status: AVAILABLE ? 'loading' : 'unavailable',
    user: null,
    error: null,
    notice: null,
    busy: false,
    dialogOpen: false,
    pendingLink: null,
    emailAction: null,
  });
  const [connection, setConnection] = useState<Connection | null>(null);
  const [describe, setDescribe] = useState<((error: unknown) => string | null) | null>(null);

  useEffect(() => {
    if (!AVAILABLE) return undefined;
    let canceled = false;
    let unsubscribe: (() => void) | undefined;
    import('./firebase')
      .then((module) => {
        if (canceled) return;
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

        const link = takeEmailLink();
        if (link) {
          setState((previous) => ({ ...previous, dialogOpen: true, emailAction: { stage: 'checking', mode: link.mode } }));
          void connected.readEmailAction(link.mode, link.code).then((action) => {
            if (!canceled) setState((previous) => ({ ...previous, emailAction: { stage: 'ready', action } }));
          });
        }
      })
      .catch(() => {
        // The chunk did not load — offline on a first visit, say. Accounts are simply absent.
        if (!canceled) setState((previous) => ({ ...previous, status: 'unavailable' }));
      });
    return () => {
      canceled = true;
      unsubscribe?.();
    };
  }, []);

  /*
    An address still to confirm is checked again whenever the person comes back to this tab.

    Confirming happens elsewhere — in the email, on Firebase's own page — so without this the
    dashboard would keep asking until someone thought to press "I have confirmed it". When it
    turns out confirmed while the account dialog is open, the dialog says so.
  */
  const unconfirmed = state.status === 'signed-in' && state.user !== null && !state.user.emailVerified;
  useEffect(() => {
    if (!connection || !unconfirmed) return undefined;
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      connection
        .refreshUser()
        .then((user) => {
          if (user?.emailVerified) {
            setState((previous) => ({ ...previous, notice: previous.dialogOpen ? 'Your email address is confirmed.' : previous.notice }));
          }
        })
        .catch(() => undefined);
    };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [connection, unconfirmed]);

  /**
   * Runs an account action, keeping `busy` and `error` up to date, and applies what `onSuccess`
   * returns to the state once it has worked. Starts the action synchronously.
   */
  const run = useCallback(
    <T,>(action: (connected: Connection) => Promise<T>, onSuccess: (result: T) => Partial<AccountState> = () => ({})) => {
      if (!connection) return;
      setState((previous) => ({ ...previous, busy: true, error: null, notice: null }));
      action(connection)
        .then((result) => setState((previous) => ({ ...previous, busy: false, ...onSuccess(result) })))
        .catch((error: unknown) => {
          if ((error as { code?: string })?.code === 'a3em/link-needed') {
            const { provider, email } = error as { provider: PopupProvider; email: string | null };
            setState((previous) => ({ ...previous, busy: false, pendingLink: { provider, email } }));
            return;
          }
          const message = describe ? describe(error) : String(error);
          setState((previous) => ({ ...previous, busy: false, error: message }));
        });
    },
    [connection, describe],
  );

  const signIn = useCallback((provider: PopupProvider) => run((connected) => connected.signIn(provider), afterSignIn), [run]);
  const signInWithPassword = useCallback(
    (email: string, password: string) => run((connected) => connected.signInWithPassword(email, password), afterSignIn),
    [run],
  );
  // No notice of its own: the account dialog already asks for the address to be confirmed.
  const createAccount = useCallback(
    (email: string, password: string, name?: string) =>
      run(
        (connected) => connected.createAccount(email, password, name),
        () => ({ pendingLink: null }),
      ),
    [run],
  );
  const setName = useCallback(
    (name: string) =>
      run(
        (connected) => connected.setName(name),
        (user) => ({
          notice: name.trim()
            ? 'Your name is saved.'
            : user.name
              ? `Your name is back to the one your sign-in service gave: ${user.name}.`
              : 'Your name is removed.',
        }),
      ),
    [run],
  );
  const resetPassword = useCallback(
    (email: string) =>
      run(
        (connected) => connected.resetPassword(email),
        () => ({
          notice: `If ${email.trim()} has an account, a link to choose a new password is on its way. Check spam if it does not arrive.`,
        }),
      ),
    [run],
  );
  const resendVerification = useCallback(
    () =>
      run(
        (connected) => connected.resendVerification(),
        () => ({ notice: 'Sent. Open the link in the email, then choose “I have confirmed it”.' }),
      ),
    [run],
  );
  const refreshUser = useCallback(
    () =>
      run(
        (connected) => connected.refreshUser(),
        (user) => ({
          notice: user?.emailVerified
            ? 'Your email address is confirmed.'
            : 'It is not confirmed yet. Open the link in the email, or send it again.',
        }),
      ),
    [run],
  );
  const cancelPendingLink = useCallback(() => {
    connection?.cancelPendingLink();
    setState((previous) => ({ ...previous, pendingLink: null }));
  }, [connection]);
  const linkProvider = useCallback(
    (provider: PopupProvider) =>
      run(
        (connected) => connected.linkProvider(provider),
        () => ({ notice: `You can now sign in with ${PROVIDER_NAME[provider]} as well.` }),
      ),
    [run],
  );
  const linkPassword = useCallback(
    (password: string) =>
      run(
        (connected) => connected.linkPassword(password),
        ({ verificationSent }) => ({
          notice: verificationSent
            ? 'You can now sign in with your email address and this password as well. We sent a link to confirm the address.'
            : 'You can now sign in with your email address and this password as well.',
        }),
      ),
    [run],
  );
  const unlinkProvider = useCallback(
    (provider: AccountUser['providers'][number]) =>
      run(
        (connected) => connected.unlinkProvider(provider),
        () => ({ notice: `${PROVIDER_NAME[provider]} is no longer a way into this account.` }),
      ),
    [run],
  );
  const confirmEmail = useCallback(
    (action: EmailAction) =>
      run(
        (connected) => connected.confirmEmail(action.code),
        () => ({ emailAction: { stage: 'done', action }, notice: 'Your email address is confirmed.' }),
      ),
    [run],
  );
  const setNewPassword = useCallback(
    (action: EmailAction, password: string) =>
      run(
        (connected) => connected.setNewPassword(action.code, password),
        () => ({ emailAction: { stage: 'done', action }, notice: 'Your password has been changed. Sign in with it now.' }),
      ),
    [run],
  );
  const finishEmailAction = useCallback(
    () => setState((previous) => ({ ...previous, emailAction: null, notice: null, error: null })),
    [],
  );
  const signOut = useCallback(() => run((connected) => connected.signOut(), () => ({ dialogOpen: false })), [run]);
  const deleteAccount = useCallback(
    (password?: string) => run((connected) => connected.deleteAccount(password), () => ({ dialogOpen: false })),
    [run],
  );
  const openDialog = useCallback(() => setState((previous) => ({ ...previous, dialogOpen: true, error: null, notice: null })), []);
  const closeDialog = useCallback(
    () => setState((previous) => ({ ...previous, dialogOpen: false, error: null, notice: null, emailAction: null })),
    [],
  );

  return {
    ...state,
    providers: SIGN_IN_PROVIDERS,
    connection,
    describeError: describe,
    signIn,
    signInWithPassword,
    createAccount,
    setName,
    resetPassword,
    resendVerification,
    refreshUser,
    cancelPendingLink,
    linkProvider,
    linkPassword,
    unlinkProvider,
    confirmEmail,
    setNewPassword,
    finishEmailAction,
    signOut,
    deleteAccount,
    openDialog,
    closeDialog,
  };
}

export type Account = ReturnType<typeof useAccount>;
