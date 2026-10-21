// The bar every game shares, so the games feel like one site. The arcade's address lives
// here and nowhere else: it moves to https://bennettdishmanmedia.com/ later.
export const ARCADE_URL = 'https://quickplay-arcade-production.up.railway.app/';

// What the account chip says: the display name, "Guest" for a Waypoint guest, or "Sign in".
// A game that keeps no guest flag still knows one by name: Waypoint keeps "guest-" for the
// names it makes up for guests (guest-swift-otter-4821), so no account can pick one.
export function chipLabel(user) {
  if (!user) return 'Sign in';
  if (user.is_guest || /^guest-/i.test(user.username || '')) return 'Guest';
  return user.display_name || user.username || 'Account';
}

// Waypoint's sign-out, which ends the Waypoint session every game's sign-in reuses, then
// sends you on to the arcade (return_to). null when Waypoint's address isn't known (SSO off),
// and the menu leaves the item out.
export function waypointLogoutUrl(authUrl) {
  if (typeof authUrl !== 'string' || !/^https?:\/\/[^/]/.test(authUrl)) return null;
  return `${authUrl.replace(/\/+$/, '')}/logout?return_to=${encodeURIComponent(ARCADE_URL)}`;
}
