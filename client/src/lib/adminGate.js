// What /admin does for whoever opens it. The game keeps its session token in the browser rather
// than a cookie, so the server cannot see who is asking when it serves the page; the page asks
// /api/admin/me, and every admin API refuses a non-admin on its own (403). Signed out goes to
// sign-in and comes back (App.jsx's SignInFirst); anyone else gets a plain page with nothing of
// the admin area in it.

export const FORBIDDEN_TEXT = 'This page is for the site admin.'

// 'sign-in' (signed out), 'checking' (asking the server), 'forbidden', or 'show'.
export function adminGate({ signedIn, isAdmin }) {
  if (!signedIn) return 'sign-in'
  if (isAdmin === null || isAdmin === undefined) return 'checking'
  return isAdmin === true ? 'show' : 'forbidden'
}
