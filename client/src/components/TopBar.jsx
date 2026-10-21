import { useEffect, useRef, useState } from 'react';
import { ARCADE_URL, chipLabel } from '../lib/topBar.js';
import './TopBar.css';

// The thin bar at the top of every game: "All games" on the left, the account chip on the
// right. The page below starts under it (--top-bar in TopBar.css), so it never covers play.
// Handlers left out (null) drop their menu item, e.g. Switch account when SSO is off.
export default function TopBar({ ready = true, user, onSignIn, onSwitchAccount, onSignOut, onSignOutAll }) {
  return (
    <nav id="top-bar" className="top-bar" aria-label="Games">
      <a className="top-bar-home" href={ARCADE_URL}>
        <span aria-hidden="true">◂</span> All games
      </a>
      {ready && (user
        ? <AccountMenu user={user} items={[
          onSwitchAccount && ['Switch account', onSwitchAccount],
          onSignOut && ['Sign out', onSignOut],
          onSignOutAll && ['Sign out of all games', onSignOutAll],
        ].filter(Boolean)} />
        : onSignIn && (
          <button type="button" className="top-bar-chip" onClick={onSignIn} aria-label="Sign in with Waypoint">
            Sign in
          </button>
        ))}
    </nav>
  );
}

function AccountMenu({ user, items }) {
  const [open, setOpen] = useState(false);
  const chip = useRef(null);
  const menu = useRef(null);
  const label = chipLabel(user);

  const close = (refocus) => {
    setOpen(false);
    if (refocus) chip.current?.focus();
  };

  // Opening moves focus into the menu; a click anywhere else closes it.
  useEffect(() => {
    if (!open) return undefined;
    menu.current?.querySelector('[role="menuitem"]')?.focus();
    const outside = (e) => {
      if (!chip.current?.contains(e.target) && !menu.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  const onMenuKey = (e) => {
    const entries = [...menu.current.querySelectorAll('[role="menuitem"]')];
    const at = entries.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      entries[(at + step + entries.length) % entries.length]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      entries[e.key === 'Home' ? 0 : entries.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div className="top-bar-account">
      <button
        ref={chip}
        type="button"
        className="top-bar-chip"
        aria-label={`Account: ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="top-bar-menu"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="top-bar-chip-name">{label}</span>
        <span aria-hidden="true" className="top-bar-caret">▾</span>
      </button>
      {open && (
        <ul ref={menu} id="top-bar-menu" className="top-bar-menu" role="menu" aria-label="Account" onKeyDown={onMenuKey}>
          {items.map(([text, run]) => (
            <li key={text} role="none">
              <button type="button" role="menuitem" tabIndex={-1} onClick={() => { close(false); run(); }}>
                {text}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
