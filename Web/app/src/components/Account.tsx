import { useEffect, useRef, useState } from 'react';
import type { SignInProvider } from '../lib/accountConfig';
import type { Account } from '../lib/useAccount';

/**
 * Signing in, as a quiet line in the rail foot and one dialog.
 *
 * The same weight as "Card tools" beside it, for the same reason: an account is optional.
 * Everything in the dashboard works signed out, so this is a standing offer rather than a
 * gate, and it says nothing at all on a deployment with no accounts configured.
 */

const PROVIDER_LABEL: Record<SignInProvider | 'other', string> = {
  google: 'Google',
  github: 'GitHub',
  apple: 'Apple',
  microsoft: 'Microsoft',
  password: 'an email address and password',
  other: 'another provider',
};

/** Matches MIN_PASSWORD_LENGTH in lib/firebase.ts, which is not imported here so it stays out of the main bundle. */
const MIN_PASSWORD_LENGTH = 8;

export function AccountRailStatus({ account }: Readonly<{ account: Account }>) {
  if (account.status === 'unavailable') return null;
  return (
    <div className="rail-foot-row">
      <span className="rail-foot-label">Account</span>
      {account.status === 'loading' ? (
        <span className="rail-foot-value muted">…</span>
      ) : (
        <button className="rail-foot-action" onClick={account.openDialog}>
          {account.status === 'signed-in' ? (account.user?.email ?? account.user?.name ?? 'Signed in') : 'Sign in…'}
        </button>
      )}
    </div>
  );
}

/** The account dialog, rendered once for the whole app and opened from wherever sign-in is offered. */
export function AccountDialog({ account, protocolCount }: Readonly<{ account: Account; protocolCount: number }>) {
  if (!account.dialogOpen || account.status === 'unavailable' || account.status === 'loading') return null;
  return <AccountModal account={account} protocolCount={protocolCount} />;
}

function AccountModal({ account, protocolCount }: Readonly<{ account: Account; protocolCount: number }>) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { closeDialog } = account;

  useEffect(() => {
    const element = dialog.current;
    if (!element) return undefined;
    element.showModal();
    element.addEventListener('close', closeDialog);
    return () => element.removeEventListener('close', closeDialog);
  }, [closeDialog]);

  const signedIn = account.status === 'signed-in';

  return (
    <dialog className="modal account-modal" ref={dialog} aria-label={signedIn ? 'Your account' : 'Sign in'}>
      {signedIn ? <SignedIn account={account} protocolCount={protocolCount} /> : <SignIn account={account} />}

      {account.error ? (
        <div className="banner crit" role="alert" style={{ marginTop: 12, marginBottom: 0 }}>
          {account.error}
        </div>
      ) : null}
      {account.notice ? (
        <div className="banner ok" role="status" style={{ marginTop: 12, marginBottom: 0 }}>
          {account.notice}
        </div>
      ) : null}

      <div className="modal-actions">
        <button className="btn" onClick={() => dialog.current?.close()}>
          Close
        </button>
      </div>
    </dialog>
  );
}

function SignIn({ account }: Readonly<{ account: Account }>) {
  const popupProviders = account.providers.filter(
    (provider): provider is Exclude<SignInProvider, 'password'> => provider !== 'password',
  );
  const withPassword = account.providers.includes('password');
  return (
    <>
      <h2>Sign in</h2>
      <p className="hint">
        Sign in to keep your protocols in an account, so they are there on any computer you sign in on. Everything
        else in the dashboard works the same without one.
      </p>
      {popupProviders.length ? (
        <div className="account-providers">
          {popupProviders.map((provider) => (
            <button
              key={provider}
              className={`btn${provider === 'apple' ? ' apple' : ''}`}
              disabled={account.busy}
              // Straight from the click: the sign-in popup must open before anything is awaited.
              onClick={() => account.signIn(provider)}
            >
              Continue with {PROVIDER_LABEL[provider]}
            </button>
          ))}
        </div>
      ) : null}
      {withPassword ? (
        <>
          {popupProviders.length ? <p className="account-or">or with an email address</p> : null}
          <PasswordForm account={account} />
        </>
      ) : null}
      <p className="card-help">
        Your account holds your email address, your name, and the protocols you save — nothing else, and nothing about
        your cards or recordings. Protocols already saved in this browser move into your account when you sign in.{' '}
        <a href="privacy.html" target="_blank" rel="noopener">
          Privacy policy
        </a>
      </p>
    </>
  );
}

type PasswordMode = 'sign-in' | 'create' | 'reset';

const SUBMIT_LABEL: Record<PasswordMode, string> = {
  'sign-in': 'Sign in',
  create: 'Create account',
  reset: 'Send a reset link',
};

/** Enough to catch a slip of the keyboard; Firebase decides what is really valid. */
function looksLikeEmail(text: string): boolean {
  const value = text.trim();
  const at = value.indexOf('@');
  return at > 0 && !value.includes(' ') && value.indexOf('.', at + 2) > at + 1 && !value.endsWith('.');
}

/**
 * An email address and password, for people with no Google, GitHub or Apple account to use.
 *
 * One form in three modes rather than three forms, because they share the address and differ
 * only in what is done with it. Errors stay vague where Firebase does: it will not say whether
 * an address has an account, so a stranger cannot use this to find out who does.
 */
function PasswordForm({ account }: Readonly<{ account: Account }>) {
  const [mode, setMode] = useState<PasswordMode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  const emailOk = looksLikeEmail(email);
  const tooShort = mode === 'create' && password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  const mismatch = mode === 'create' && confirm.length > 0 && confirm !== password;
  const ready =
    emailOk &&
    (mode === 'reset' ||
      (mode === 'sign-in' && password.length > 0) ||
      (mode === 'create' && password.length >= MIN_PASSWORD_LENGTH && confirm === password));

  const submit = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    if (!ready || account.busy) return;
    if (mode === 'sign-in') account.signInWithPassword(email, password);
    else if (mode === 'create') account.createAccount(email, password);
    else account.resetPassword(email);
  };

  return (
    <form className="account-password" onSubmit={submit} noValidate>
      <div className="field">
        <label htmlFor="account-email">Email address</label>
        <input
          id="account-email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      {mode !== 'reset' ? (
        <div className="field">
          <label htmlFor="account-password">Password</label>
          <input
            id="account-password"
            type="password"
            autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
            value={password}
            aria-invalid={tooShort}
            onChange={(event) => setPassword(event.target.value)}
          />
          {mode === 'create' ? (
            <p className={`help${tooShort ? ' problem' : ''}`}>At least {MIN_PASSWORD_LENGTH} characters.</p>
          ) : null}
        </div>
      ) : null}
      {mode === 'create' ? (
        <div className="field">
          <label htmlFor="account-confirm">Password again</label>
          <input
            id="account-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            aria-invalid={mismatch}
            onChange={(event) => setConfirm(event.target.value)}
          />
          {mismatch ? <p className="help problem">The two passwords are not the same.</p> : null}
        </div>
      ) : null}
      <button type="submit" className="btn primary" disabled={!ready || account.busy}>
        {SUBMIT_LABEL[mode]}
      </button>
      <p className="account-modes">
        {mode === 'sign-in' ? (
          <>
            <button type="button" className="link-button" onClick={() => setMode('create')}>
              Create an account
            </button>
            {' · '}
            <button type="button" className="link-button" onClick={() => setMode('reset')}>
              Forgot the password?
            </button>
          </>
        ) : (
          <button type="button" className="link-button" onClick={() => setMode('sign-in')}>
            Back to signing in
          </button>
        )}
      </p>
    </form>
  );
}

function SignedIn({ account, protocolCount }: Readonly<{ account: Account; protocolCount: number }>) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [password, setPassword] = useState('');
  const user = account.user;
  const withPassword = user?.provider === 'password';
  const plural = (count: number) => `${count} protocol${count === 1 ? '' : 's'}`;

  return (
    <>
      <h2>Your account</h2>
      <p className="hint">
        Signed in as <strong>{user?.email ?? user?.name}</strong> with {PROVIDER_LABEL[user?.provider ?? 'other']}.{' '}
        {plural(protocolCount)} in your account, on any computer you sign in on.
      </p>
      {user && !user.emailVerified ? (
        <div className="banner warn" style={{ marginTop: 12 }}>
          <strong>Confirm your email address</strong>
          Open the link we sent to {user.email}. Until then, a forgotten password cannot be reset.
          <div className="account-actions">
            <button className="btn small" disabled={account.busy} onClick={account.refreshUser}>
              I have confirmed it
            </button>
            <button className="btn small ghost" disabled={account.busy} onClick={account.resendVerification}>
              Send it again
            </button>
          </div>
        </div>
      ) : null}
      <p className="card-help">Signing out removes your protocols from this computer. They stay in your account.</p>

      {confirmingDelete ? (
        <div className="banner crit" role="alert" style={{ marginTop: 12 }}>
          <strong>Delete your account and its {plural(protocolCount)}?</strong>
          {withPassword
            ? 'This cannot be undone. Enter your password to confirm it is you.'
            : 'This cannot be undone. You will be asked to sign in once more to confirm it is you.'}
          {withPassword ? (
            <input
              className="account-delete-password"
              type="password"
              autoComplete="current-password"
              aria-label="Password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          ) : null}
          <div className="account-actions">
            <button
              className="btn small danger"
              disabled={account.busy || (withPassword && !password)}
              onClick={() => account.deleteAccount(withPassword ? password : undefined)}
            >
              Delete my account
            </button>
            <button className="btn small ghost" onClick={() => setConfirmingDelete(false)}>
              Keep it
            </button>
          </div>
        </div>
      ) : (
        <div className="account-actions">
          <button className="btn" disabled={account.busy} onClick={account.signOut}>
            Sign out
          </button>
          <button className="btn ghost" disabled={account.busy} onClick={() => setConfirmingDelete(true)}>
            Delete account…
          </button>
        </div>
      )}
    </>
  );
}
