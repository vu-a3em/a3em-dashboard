import { useEffect, useRef, useState } from 'react';
import type { Account } from '../lib/useAccount';

/**
 * Signing in: a button at the right of the top bar, where people look for their account on any
 * other site, and one dialog for everything else.
 *
 * Signed out, the button says "Sign in". Signed in, it is a round badge with the person's initial,
 * which opens a small menu naming the account, with the settings and signing out. Nothing at all
 * is shown on a deployment with no accounts configured, and everything in the dashboard works
 * signed out.
 *
 * Only the button is here, in the main bundle. The dialog is loaded the first time it opens
 * (`AccountDialog.tsx`), since most visits never open it.
 */

function PersonIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="12" cy="8.5" r="3.8" />
      <path d="M4.5 20c.9-3.9 3.9-6 7.5-6s6.6 2.1 7.5 6" strokeLinecap="round" />
    </svg>
  );
}

export function AccountButton({ account }: Readonly<{ account: Account }>) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const outside = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  if (account.status === 'unavailable') return null;

  if (account.status !== 'signed-in' || !account.user) {
    return (
      <button className="account-trigger" disabled={account.status === 'loading'} onClick={account.openDialog}>
        <PersonIcon />
        <span>Sign in</span>
      </button>
    );
  }

  const user = account.user;
  const who = user.name ?? user.email ?? 'Your account';
  const initial = (user.name ?? user.email ?? '?').trim().charAt(0).toUpperCase();
  return (
    <div className="account-menu-wrap" ref={menu}>
      <button
        className="account-avatar"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${user.email ?? who}`}
        title={user.email ?? who}
        onClick={() => setOpen((value) => !value)}
      >
        {initial}
        {!user.emailVerified ? <span className="account-avatar-dot" aria-hidden="true" /> : null}
      </button>
      {open ? (
        <div className="account-menu" role="menu">
          <div className="account-menu-who">
            <strong>{who}</strong>
            {user.name && user.email ? <span>{user.email}</span> : null}
          </div>
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              account.openDialog();
            }}
          >
            Account settings
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              account.signOut();
            }}
          >
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
