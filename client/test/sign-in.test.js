// The sign-in decisions (src/lib/signIn.js) and the top bar's labels (src/lib/topBar.js):
// when a signed-out player goes straight to Waypoint, the hold that stops a bounce or a loop,
// and where Waypoint sends you back to. The state check is the server's (routes/sso.test.js).
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  HOLD_KEY, AUTO_KEY, AUTO_GAP_MS,
  holdReason, goStraightToWaypoint, returnPath, signInError, ssoStartUrl, startWaypoint,
} from '../src/lib/signIn.js'
import { ARCADE_URL, chipLabel, logoutAllUrl } from '../src/lib/topBar.js'

const on = { ssoEnabled: true, hold: null, wantsLocal: false }

test('signed out with SSO on goes straight to Waypoint', () => {
  assert.equal(goStraightToWaypoint(on), true)
})

test('no redirect without SSO, or before the server has said', () => {
  assert.equal(goStraightToWaypoint({ ...on, ssoEnabled: false }), false)
  assert.equal(goStraightToWaypoint({ ...on, ssoEnabled: null }), false)
})

test('the hold after Sign out or a failed callback keeps the page up', () => {
  assert.equal(goStraightToWaypoint({ ...on, hold: 'signed-out' }), false)
  assert.equal(goStraightToWaypoint({ ...on, hold: 'failed' }), false)
  assert.equal(goStraightToWaypoint({ ...on, hold: 'whatever' }), true)
  assert.equal(holdReason('failed'), 'failed')
  assert.equal(holdReason('nope'), null)
})

test('?local keeps the game\'s own form', () => {
  assert.equal(goStraightToWaypoint({ ...on, wantsLocal: true }), false)
})

test('a second automatic trip within a minute waits for a click', () => {
  const now = 1_000_000
  assert.equal(goStraightToWaypoint({ ...on, lastAutoAt: String(now - 5000), now }), false)
  assert.equal(goStraightToWaypoint({ ...on, lastAutoAt: String(now - AUTO_GAP_MS - 1), now }), true)
  assert.equal(goStraightToWaypoint({ ...on, lastAutoAt: null, now }), true)
})

test('the return path is a page on this site, never the sign-in machinery', () => {
  assert.equal(returnPath('/lobby/ABC123', ''), '/lobby/ABC123')
  assert.equal(returnPath('/join', '?local&code=XYZ'), '/join?code=XYZ')
  assert.equal(returnPath('/', ''), null)
  assert.equal(returnPath('/login', ''), null)
  assert.equal(returnPath('/register', '?local'), null)
  assert.equal(returnPath('/auth/callback', '?code=x'), null)
  assert.equal(returnPath('/lobby/ABC123', '?error=sso_state'), '/lobby/ABC123', 'a sign-in error is dropped')
  assert.equal(returnPath('//evil.example/x', ''), null)
})

test('the start URL carries the page to come back to, and prompt=login only for Switch account', () => {
  assert.equal(ssoStartUrl(), '/api/auth/sso/login')
  assert.equal(ssoStartUrl({ prompt: 'login' }), '/api/auth/sso/login?prompt=login')
  assert.equal(ssoStartUrl({ prompt: 'none' }), '/api/auth/sso/login')
  assert.equal(ssoStartUrl({ next: '/lobby/ABC123' }), '/api/auth/sso/login?next=%2Flobby%2FABC123')
  assert.equal(ssoStartUrl({ next: '/join?code=XYZ', prompt: 'login' }), '/api/auth/sso/login?next=%2Fjoin%3Fcode%3DXYZ&prompt=login')
})

test('a sign-in that came back with an error says why', () => {
  assert.equal(signInError(null), null)
  assert.match(signInError('sso_busy'), /Too many sign-in attempts/)
  for (const code of ['sso_state', 'sso_exchange', 'sso_save', 'anything']) assert.match(signInError(code), /did not finish/, code)
})

function fakeEnv() {
  const store = new Map()
  const env = {
    storage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    now: () => 42,
    went: null,
    go: (url, opts) => { env.went = { url, ...opts } },
  }
  return { env, store }
}

test('an automatic trip carries the way back, stores the time, and replaces history', () => {
  const { env, store } = fakeEnv()
  store.set(HOLD_KEY, 'failed')
  startWaypoint({ back: '/lobby/ABC123', automatic: true }, env)
  assert.deepEqual(env.went, { url: '/api/auth/sso/login?next=%2Flobby%2FABC123', replace: true })
  assert.equal(store.get(AUTO_KEY), '42')
  assert.equal(store.has(HOLD_KEY), false)
})

test('a click (Switch account) clears the hold and the automatic timer', () => {
  const { env, store } = fakeEnv()
  store.set(HOLD_KEY, 'signed-out')
  store.set(AUTO_KEY, '41')
  startWaypoint({ prompt: 'login' }, env)
  assert.deepEqual(env.went, { url: '/api/auth/sso/login?prompt=login', replace: false })
  assert.equal(store.has(HOLD_KEY), false)
  assert.equal(store.has(AUTO_KEY), false)
})

test('the top bar: arcade link, chip label, Sign out of all games', () => {
  assert.equal(ARCADE_URL, 'https://games.bennettdishman.com/')
  assert.equal(chipLabel(null), 'Sign in')
  assert.equal(chipLabel({ username: 'captain' }), 'captain')
  assert.equal(chipLabel({ username: 'guest-swift-otter-4821' }), 'Guest')
  assert.equal(chipLabel({ username: 'kept-it', is_guest: true }), 'Guest')
  assert.equal(logoutAllUrl(), '/api/auth/logout-all?return_to=https%3A%2F%2Fgames.bennettdishman.com%2F')
})
