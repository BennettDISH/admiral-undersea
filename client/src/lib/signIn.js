// Signing in goes through Waypoint (the bug tracker's helper, shared by every game). These are
// the decisions around the redirect; startWaypoint below is the one browser side effect, and
// Login and AuthCallback do the rest.
//
// Unlike the other games, the OAuth state here never touches the browser's storage: the
// server makes it at /api/auth/sso/login, keeps it in an httpOnly cookie and checks it when
// the callback posts the code back (server/routes/auth.js).

// sessionStorage keys. sso_return is the page to come back to; sso_hold keeps the sign-in
// page on screen instead of leaving for Waypoint ('signed-out' after Sign out, 'failed' after
// a callback that didn't work); sso_auto is when the last trip to Waypoint that nobody
// clicked for started.
export const RETURN_KEY = 'sso_return'
export const HOLD_KEY = 'sso_hold'
export const AUTO_KEY = 'sso_auto'

// Arriving signed out again this soon after an automatic trip means something is wrong (the
// new session didn't stick), so the page waits for a click instead of going round again.
export const AUTO_GAP_MS = 60 * 1000

const HOLDS = ['signed-out', 'failed']

export const holdReason = (value) => (HOLDS.includes(value) ? value : null)

// A page that needs an account goes straight to Waypoint, so the first thing asked for is
// the Waypoint sign-in itself (which also offers "Continue as guest"). Not right after Sign
// out (that would bounce you back in), not after a failed attempt or a second trip in a
// minute (either could loop), and not when the game's own form was asked for with ?local.
export function goStraightToWaypoint({ ssoEnabled, hold, wantsLocal, lastAutoAt = null, now = Date.now() }) {
  if (ssoEnabled !== true || holdReason(hold) || wantsLocal) return false
  const since = now - Number(lastAutoAt)
  return !(Number(lastAutoAt) > 0 && since >= 0 && since < AUTO_GAP_MS)
}

// The page to come back to after Waypoint: a path on this site, never the sign-in
// machinery itself, and without ?local. null means the game's usual landing page.
export function returnPath(pathname, search = '') {
  if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.startsWith('//')) return null
  if (['/auth/callback', '/login', '/register'].includes(pathname)) return null
  const params = new URLSearchParams(typeof search === 'string' ? search : '')
  params.delete('local')
  const qs = params.toString()
  const path = qs ? `${pathname}?${qs}` : pathname
  return path === '/' ? null : path
}

// A stored return path is only followed if it is still a plain path on this site.
export function safeReturnPath(value, fallback = '/') {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return fallback
  return value
}

// The game's own route that sends you on to Waypoint. prompt=login (Switch account) makes
// Waypoint ask which account again instead of reusing the one it is signed in as.
export function ssoStartUrl({ prompt } = {}) {
  return prompt === 'login' ? '/api/auth/sso/login?prompt=login' : '/api/auth/sso/login'
}

const browser = () => ({
  storage: window.sessionStorage,
  now: () => Date.now(),
  go: (url, { replace }) => (replace ? window.location.replace(url) : window.location.assign(url)),
})

// Leave for Waypoint. An automatic trip (nobody clicked) replaces this history entry, so Back
// from Waypoint doesn't land on a page that sends you straight there again, and is timed for
// goStraightToWaypoint. A click clears any hold: asking is always allowed.
export function startWaypoint({ back = null, prompt, automatic = false } = {}, env = browser()) {
  const { storage } = env
  storage.removeItem(HOLD_KEY)
  if (back) storage.setItem(RETURN_KEY, back)
  else storage.removeItem(RETURN_KEY)
  if (automatic) storage.setItem(AUTO_KEY, String(env.now()))
  else storage.removeItem(AUTO_KEY)
  env.go(ssoStartUrl({ prompt }), { replace: automatic })
}
