// The bar every game shares, so the games feel like one site (fleet-kit's <fleet-topbar>,
// components/TopBar.jsx). The arcade's address lives here and nowhere else.
export const ARCADE_URL = 'https://games.bennettdishman.com/';

// What the account chip says: the display name, "Guest" for a Waypoint guest, or "Sign in".
// A game that keeps no guest flag still knows one by name: Waypoint keeps "guest-" for the
// names it makes up for guests (guest-swift-otter-4821), so no account can pick one.
export function chipLabel(user) {
  if (!user) return 'Sign in';
  if (user.is_guest || /^guest-/i.test(user.username || '')) return 'Guest';
  return user.display_name || user.username || 'Account';
}

// "Sign out of all games": the server's route to Waypoint's own sign-out page, which ends the
// Waypoint session every game's sign-in reuses, then sends you on to the arcade (return_to).
// The game's own session is ended first (POST /api/auth/logout).
export const logoutAllUrl = () => `/api/auth/logout-all?return_to=${encodeURIComponent(ARCADE_URL)}`;
