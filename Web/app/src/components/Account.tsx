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
  microsoft: 'Microsoft',
  other: 'another provider',
};

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
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const { closeDialog } = account;

  useEffect(() => {
    const element = dialog.current;
    if (!element) return undefined;
    element.showModal();
    element.addEventListener('close', closeDialog);
    return () => element.removeEventListener('close', closeDialog);
  }, [closeDialog]);

  const signedIn = account.status === 'signed-in';
  const plural = (count: number) => `${count} protocol${count === 1 ? '' : 's'}`;

  return (
    <dialog className="modal account-modal" ref={dialog} aria-label={signedIn ? 'Your account' : 'Sign in'}>
      {signedIn ? (
        <>
          <h2>Your account</h2>
          <p className="hint">
            Signed in as <strong>{account.user?.email ?? account.user?.name}</strong> with{' '}
            {PROVIDER_LABEL[account.user?.provider ?? 'other']}. {plural(protocolCount)} in your account, on any
            computer you sign in on.
          </p>
          <p className="card-help">
            Signing out removes your protocols from this computer. They stay in your account.
          </p>
          {confirmingDelete ? (
            <div className="banner crit" role="alert" style={{ marginTop: 12 }}>
              <strong>Delete your account and its {plural(protocolCount)}?</strong>
              This cannot be undone. You will be asked to sign in once more to confirm it is you.
              <div className="account-actions">
                <button className="btn small danger" disabled={account.busy} onClick={account.deleteAccount}>
                  Delete my account
                </button>
                <button className="btn small ghost" onClick={() => setConfirmingDelete(false)}>
                  Keep it
                </button>
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <h2>Sign in</h2>
          <p className="hint">
            Sign in to keep your protocols in an account, so they are there on any computer you sign in on.
            Everything else in the dashboard works the same without one.
          </p>
          <div className="account-providers">
            {account.providers.map((provider) => (
              <button
                key={provider}
                className="btn"
                disabled={account.busy}
                // Straight from the click: the sign-in popup must open before anything is awaited.
                onClick={() => account.signIn(provider)}
              >
                Continue with {PROVIDER_LABEL[provider]}
              </button>
            ))}
          </div>
          <p className="card-help">
            Your account holds your email address, your name, and the protocols you save — nothing else, and nothing
            about your cards or recordings. Protocols already saved in this browser move into your account when you sign
            in.
          </p>
        </>
      )}

      {account.error ? (
        <div className="banner crit" role="alert" style={{ marginTop: 12, marginBottom: 0 }}>
          {account.error}
        </div>
      ) : null}

      <div className="modal-actions">
        {signedIn && !confirmingDelete ? (
          <>
            <button className="btn" disabled={account.busy} onClick={account.signOut}>
              Sign out
            </button>
            <button className="btn ghost" disabled={account.busy} onClick={() => setConfirmingDelete(true)}>
              Delete account…
            </button>
          </>
        ) : null}
        <button className="btn" onClick={() => dialog.current?.close()}>
          Close
        </button>
      </div>
    </dialog>
  );
}
