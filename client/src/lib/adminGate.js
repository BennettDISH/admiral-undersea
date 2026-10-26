// What /admin does for whoever opens it. The server decides the page first (fleet-kit's gate:
// signed out goes to sign-in and back, anyone but the admin gets a plain 403), and every admin
// API refuses a non-admin on its own (403). This is for a player who follows a link to /admin
// inside the game: the page asks /api/admin/me, and anyone else gets a plain page with nothing of
// the admin area in it.

export const FORBIDDEN_TEXT = 'This page is for the site admin.'

// 'sign-in' (signed out), 'checking' (asking the server), 'forbidden', or 'show'.
export function adminGate({ signedIn, isAdmin }) {
  if (!signedIn) return 'sign-in'
  if (isAdmin === null || isAdmin === undefined) return 'checking'
  return isAdmin === true ? 'show' : 'forbidden'
}
