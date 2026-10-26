import { useEffect, useRef } from 'react';
import 'fleet-kit/client/topbar';
import 'fleet-kit/client/topbar.css';
import { ARCADE_URL, chipLabel } from '../lib/topBar.js';
import './TopBar.css';

// The thin bar at the top of every game: fleet-kit's <fleet-topbar>, with "All games" on the left
// and the account chip on the right. The page below starts under it (--top-bar in TopBar.css), so
// it never covers play. The app says who is signed in (`manual`) and takes over the menu, so Sign
// out keeps the sign-in page up and drops the game's socket. A handler left out (null) leaves the
// bar's own action; without Waypoint the bar shows only Sign out.
export default function TopBar({ ready = true, user, ssoEnabled, onSignIn, onSwitchAccount, onSignOut, onSignOutAll }) {
  const bar = useRef(null);

  useEffect(() => {
    if (!bar.current) return;
    const label = chipLabel(user);
    bar.current.account = !ready ? undefined : user ? { name: label, guest: label === 'Guest' } : onSignIn ? null : undefined;
  }, [ready, user, onSignIn]);

  useEffect(() => {
    const el = bar.current;
    if (!el) return undefined;
    const take = (run) => (e) => {
      if (!run) return;
      e.preventDefault();
      run();
    };
    const handlers = {
      'fleet-topbar-signin': take(onSignIn),
      'fleet-topbar-switch': take(onSwitchAccount),
      'fleet-topbar-signout': take(onSignOut),
      'fleet-topbar-signout-all': take(onSignOutAll),
    };
    for (const [name, fn] of Object.entries(handlers)) el.addEventListener(name, fn);
    return () => {
      for (const [name, fn] of Object.entries(handlers)) el.removeEventListener(name, fn);
    };
  }, [onSignIn, onSwitchAccount, onSignOut, onSignOutAll]);

  return <fleet-topbar ref={bar} home={ARCADE_URL} manual="" sso={ssoEnabled ? undefined : 'off'} />;
}
