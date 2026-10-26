// Signing in goes through Waypoint. The server builds the trip there and takes the code back
// (fleet-kit): it keeps the OAuth state in an httpOnly cookie of its own, finishes the sign-in
// at /auth/callback and sends the browser on to the page that needed an account (`next`). These
// are the page's decisions around it; startWaypoint below is the one browser side effect.

// sessionStorage keys. sso_hold keeps the sign-in page on screen instead of leaving for
// Waypoint ('signed-out' after Sign out, 'failed' after a sign-in that came back with an
// error); sso_auto is when the last trip to Waypoint that nobody clicked for started.
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
// machinery itself, and without ?local or a sign-in ?error. null means the game's usual
// landing page.
export function returnPath(pathname, search = '') {
  if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.startsWith('//')) return null
  if (['/auth/callback', '/login', '/register'].includes(pathname)) return null
  const params = new URLSearchParams(typeof search === 'string' ? search : '')
  params.delete('local')
  params.delete('error')
  const qs = params.toString()
  const path = qs ? `${pathname}?${qs}` : pathname
  return path === '/' ? null : path
}

// The server's route that sends you on to Waypoint, with the page to come back to. The server
// follows `next` only to a path on this site. prompt=login (Switch account) makes Waypoint ask
// which account again instead of reusing the one it is signed in as.
export function ssoStartUrl({ next = null, prompt } = {}) {
  const params = new URLSearchParams()
  if (next) params.set('next', next)
  if (prompt === 'login') params.set('prompt', 'login')
  const qs = params.toString()
  return `/api/auth/sso/login${qs ? `?${qs}` : ''}`
}

// What the sign-in page says when the server sent it back with ?error= (fleet-kit's codes).
export function signInError(code) {
  if (!code) return null
  if (code === 'sso_busy') return 'Too many sign-in attempts from here. Wait a few minutes and try again.'
  return 'Waypoint sign-in did not finish. Try again.'
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
  if (automatic) storage.setItem(AUTO_KEY, String(env.now()))
  else storage.removeItem(AUTO_KEY)
  env.go(ssoStartUrl({ next: back, prompt }), { replace: automatic })
}
