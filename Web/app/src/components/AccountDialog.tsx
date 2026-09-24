import { useEffect, useRef, useState } from 'react';
import type { SignInProvider } from '../lib/accountConfig';
import type { EmailAction } from '../lib/firebase';
import { isPopupProvider, PROVIDER_NAME } from '../lib/signInProviders';
import type { Account } from '../lib/useAccount';
import { ProviderButton, ProviderLogo } from './ProviderButton';

/**
 * The account dialog: signing in, the account's settings, and the links in account emails.
 *
 * Loaded the first time it opens, by App.tsx, so it costs nothing on the visits that never
 * need it.
 */

/** Matches MIN_PASSWORD_LENGTH in lib/firebase.ts, which is not imported here so it stays out of the main bundle. */
const MIN_PASSWORD_LENGTH = 8;

const plural = (count: number) =>
  count === 1 ? 'There is 1 protocol stored in your account.' : `There are ${count} protocols stored in your account.`;

/** The account dialog, rendered once for the whole app and opened from wherever sign-in is offered. */
export function AccountDialog({ account, protocolCount }: Readonly<{ account: Account; protocolCount: number }>) {
  if (!account.dialogOpen || account.status === 'unavailable') return null;
  if (account.status === 'loading' && !account.emailAction) return null;
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
  let body;
  if (account.emailAction) body = <EmailLink account={account} />;
  else if (signedIn) body = <SignedIn account={account} protocolCount={protocolCount} />;
  else body = <SignIn account={account} />;

  return (
    <dialog className="modal account-modal" ref={dialog} aria-label={signedIn ? 'Your account' : 'Sign in'}>
      {body}

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

function SmallPrint() {
  return (
    <p className="card-help">
      Your account holds your email address, your name, and the protocols you save. It does not store anything about
      your deployments or recordings. Protocols already saved in this browser move into your account when you sign in.{' '}
      <a href="privacy.html" target="_blank" rel="noopener">
        Privacy policy
      </a>
    </p>
  );
}

function SignIn({ account }: Readonly<{ account: Account }>) {
  const popupProviders = account.providers.filter(isPopupProvider);
  const withPassword = account.providers.includes('password');
  const pending = account.pendingLink;
  return (
    <>
      <h2>Sign in</h2>
      <p className="hint">
        Sign in to keep your protocols in an account. They will automatically sync to any computer you sign in on.
      </p>
      {pending ? (
        <div className="banner warn" role="status" style={{ marginTop: 12 }}>
          <strong>{pending.email ?? 'That email address'} already has an account here</strong>
          It was made with a different sign-in method. Sign in the way you did before, and {PROVIDER_NAME[pending.provider]}{' '}
          will be added to that account, so either way works from then on.
          <div className="account-actions">
            <button className="btn small ghost" onClick={account.cancelPendingLink}>
              Never mind
            </button>
          </div>
        </div>
      ) : null}
      {popupProviders.length ? (
        <div className="account-providers">
          {popupProviders
            .filter((provider) => provider !== pending?.provider)
            .map((provider) => (
              // Straight from the click: the sign-in popup must open before anything is awaited.
              <ProviderButton key={provider} provider={provider} disabled={account.busy} onClick={() => account.signIn(provider)} />
            ))}
        </div>
      ) : null}
      {withPassword ? (
        <>
          {popupProviders.length ? <p className="account-or">or with an email address</p> : null}
          <PasswordForm account={account} />
        </>
      ) : null}
      <SmallPrint />
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

  const emailOk = looksLikeEmail(email);
  const ready =
    emailOk && (mode === 'reset' || (mode === 'sign-in' && password.length > 0) || mode === 'create');

  const submit = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    if (!ready || account.busy) return;
    if (mode === 'sign-in') account.signInWithPassword(email, password);
    else account.resetPassword(email);
  };

  return (
    <form className="account-password" onSubmit={submit} noValidate>
      <div className="field">
        <label htmlFor="account-email">Email address</label>
        <input id="account-email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} />
      </div>
      {mode === 'create' ? (
        <NewPassword
          id="account-new"
          busy={account.busy}
          disabled={!emailOk}
          submitLabel={SUBMIT_LABEL.create}
          onSubmit={(chosen) => account.createAccount(email, chosen)}
        />
      ) : (
        <>
          {mode === 'sign-in' ? (
            <div className="field">
              <label htmlFor="account-password">Password</label>
              <input
                id="account-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
          ) : null}
          <button type="submit" className="btn primary" disabled={!ready || account.busy}>
            {SUBMIT_LABEL[mode]}
          </button>
        </>
      )}
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

/**
 * A new password, typed twice: for a new account, a password added to an account, and a reset.
 * Not a form of its own, so it can sit inside the sign-in form; Enter in either box submits it.
 */
function NewPassword({
  id,
  busy,
  disabled,
  submitLabel,
  onSubmit,
}: Readonly<{ id: string; busy: boolean; disabled?: boolean; submitLabel: string; onSubmit: (password: string) => void }>) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready = !disabled && password.length >= MIN_PASSWORD_LENGTH && confirm === password;
  const submit = () => {
    if (ready && !busy) onSubmit(password);
  };
  const onEnter = (event: { key: string; preventDefault: () => void }) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  };
  return (
    <>
      <div className="field">
        <label htmlFor={`${id}-password`}>Password</label>
        <input
          id={`${id}-password`}
          type="password"
          autoComplete="new-password"
          value={password}
          aria-invalid={tooShort}
          onKeyDown={onEnter}
          onChange={(event) => setPassword(event.target.value)}
        />
        <p className={`help${tooShort ? ' problem' : ''}`}>At least {MIN_PASSWORD_LENGTH} characters.</p>
      </div>
      <div className="field">
        <label htmlFor={`${id}-confirm`}>Password again</label>
        <input
          id={`${id}-confirm`}
          type="password"
          autoComplete="new-password"
          value={confirm}
          aria-invalid={mismatch}
          onKeyDown={onEnter}
          onChange={(event) => setConfirm(event.target.value)}
        />
        {mismatch ? <p className="help problem">The two passwords are not the same.</p> : null}
      </div>
      <button type="button" className="btn primary" disabled={!ready || busy} onClick={submit}>
        {submitLabel}
      </button>
    </>
  );
}

function SignedIn({ account, protocolCount }: Readonly<{ account: Account; protocolCount: number }>) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [password, setPassword] = useState('');
  const user = account.user;
  if (!user) return null;
  const passwordOnly = !user.providers.some(isPopupProvider);

  return (
    <>
      <h2>Your account</h2>
      <p className="hint">
        Signed in as <strong className="account-email">{user.email ?? user.name}</strong>. {plural(protocolCount)}
      </p>
      {!user.emailVerified ? (
        <div className="banner warn" style={{ marginTop: 12 }}>
          <strong>Confirm your email address</strong>
          Open the confirmation link emailed to {user.email}. If it has not arrived, or has expired, send a new one.
          Until the address is confirmed, a forgotten password cannot be reset.
          <div className="account-actions">
            <button className="btn small" disabled={account.busy} onClick={account.refreshUser}>
              I have confirmed it
            </button>
            <button className="btn small ghost" disabled={account.busy} onClick={account.resendVerification}>
              Send a new link
            </button>
          </div>
        </div>
      ) : null}

      <SignInMethods account={account} />

      <p className="card-help">Signing out removes your protocols from this computer. They stay in your account.</p>

      {confirmingDelete ? (
        <div className="banner crit" role="alert" style={{ marginTop: 12 }}>
          <strong>Delete your account? {plural(protocolCount)}</strong>
          {passwordOnly
            ? 'This cannot be undone. Enter your password to confirm it is you.'
            : 'This cannot be undone. You will be asked to sign in once more to confirm it is you.'}
          {passwordOnly ? (
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
              disabled={account.busy || (passwordOnly && !password)}
              onClick={() => account.deleteAccount(passwordOnly ? password : undefined)}
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

/**
 * Every way into this account, and the ones that could be added.
 *
 * One account, however someone signs in: a person who used Google on one computer and GitHub on
 * another has one library, not two. The last way in cannot be removed.
 */
function SignInMethods({ account }: Readonly<{ account: Account }>) {
  const [addingPassword, setAddingPassword] = useState(false);
  const user = account.user;
  if (!user) return null;
  const addable = account.providers.filter((provider) => !user.providers.includes(provider));
  const remove = (provider: SignInProvider) => account.unlinkProvider(provider);

  return (
    <section className="account-methods">
      <h3>Ways to sign in</h3>
      <ul>
        {user.providers.map((provider) => (
          <li key={provider}>
            <span className="account-method-logo">
              <ProviderLogo provider={provider} size={16} />
            </span>
            <span>{PROVIDER_NAME[provider]}</span>
            {user.providers.length > 1 ? (
              <button className="link-button" disabled={account.busy} onClick={() => remove(provider)}>
                Remove
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {addable.length ? (
        <div className="account-add">
          <p className="card-help">Add another, so you can sign in either way:</p>
          <div className="account-providers compact">
            {addable.filter(isPopupProvider).map((provider) => (
              <ProviderButton
                key={provider}
                provider={provider}
                label={`Add ${PROVIDER_NAME[provider]}`}
                disabled={account.busy}
                // Straight from the click, as signing in is.
                onClick={() => account.linkProvider(provider)}
              />
            ))}
          </div>
          {addable.includes('password') && user.email ? (
            addingPassword ? (
              <div className="account-password">
                <p className="card-help">A password for {user.email}.</p>
                <NewPassword
                  id="account-add"
                  busy={account.busy}
                  submitLabel="Add this password"
                  onSubmit={(chosen) => {
                    account.linkPassword(chosen);
                    setAddingPassword(false);
                  }}
                />
              </div>
            ) : (
              <button className="link-button account-add-password" onClick={() => setAddingPassword(true)}>
                Add a password
              </button>
            )
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * A link from one of the account emails, completed here rather than on Firebase's own page.
 *
 * Nothing is used up until a button is pressed: a mail scanner that opens every link — Microsoft
 * Safe Links does — would otherwise spend the link before its owner ever saw it, and they would
 * be told it had expired.
 */
function EmailLink({ account }: Readonly<{ account: Account }>) {
  const state = account.emailAction;
  if (!state) return null;
  if (state.stage === 'checking') {
    return (
      <>
        <h2>{state.mode === 'resetPassword' ? 'Choose a new password' : 'Confirm your email address'}</h2>
        <p className="hint">Checking the link…</p>
      </>
    );
  }
  const action: EmailAction = state.action;
  const done = state.stage === 'done';
  const next = (
    <div className="account-actions">
      <button className="btn primary" onClick={account.finishEmailAction}>
        Continue
      </button>
    </div>
  );

  if (action.mode === 'verifyEmail') {
    if (done) return <><h2>Your email address is confirmed</h2>{next}</>;
    if (action.valid) {
      return (
        <>
          <h2>Confirm your email address</h2>
          <p className="hint">
            Confirm that <strong className="account-email">{action.email}</strong> is yours, so a forgotten password can
            be reset.
          </p>
          <div className="account-actions">
            <button className="btn primary" disabled={account.busy} onClick={() => account.confirmEmail(action)}>
              Confirm my email address
            </button>
          </div>
        </>
      );
    }
    if (action.alreadyVerified) {
      return (
        <>
          <h2>Your email address is confirmed</h2>
          <p className="hint">This link had already been used, and the address it confirms is confirmed.</p>
          {next}
        </>
      );
    }
    return (
      <>
        <h2>This link has expired or has already been used</h2>
        <p className="hint">
          {account.status === 'signed-in'
            ? 'If your address is not confirmed yet, send yourself a new link from your account.'
            : 'Sign in, and your account will offer to send a new link if your address still needs confirming.'}
        </p>
        {next}
      </>
    );
  }

  if (action.mode === 'resetPassword') {
    if (done) return <><h2>Your password has been changed</h2>{next}</>;
    if (action.valid) {
      return (
        <>
          <h2>Choose a new password</h2>
          <p className="hint">
            For <strong className="account-email">{action.email}</strong>.
          </p>
          <div className="account-password">
            <NewPassword
              id="account-reset"
              busy={account.busy}
              submitLabel="Change the password"
              onSubmit={(chosen) => account.setNewPassword(action, chosen)}
            />
          </div>
        </>
      );
    }
    return (
      <>
        <h2>This link has expired or has already been used</h2>
        <p className="hint">Ask for a new one: choose Sign in, then “Forgot the password?”.</p>
        {next}
      </>
    );
  }

  return (
    <>
      <h2>This link cannot be completed here</h2>
      <p className="hint">It is not one the dashboard knows how to handle.</p>
      {next}
    </>
  );
}
