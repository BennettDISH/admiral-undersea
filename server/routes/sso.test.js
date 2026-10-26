// The Waypoint redirect and its callback (fleet-kit), against an in-process PGlite database and
// the kit's stand-in Waypoint. The OAuth state lives in an httpOnly cookie the server sets at
// /sso/login, the callback at /auth/callback (the address Waypoint has registered) only exchanges
// a code that comes back with that same state, and the answer is the session cookie.
const test = require('node:test');
const assert = require('node:assert');

process.env.USE_PGLITE = '1';
process.env.JWT_SECRET = 'sso-test-secret';
delete process.env.SESSION_SECRET;

const express = require('express');
const initDb = require('../config/initDb');
const { wp } = require('../config/auth');
const authRoutes = require('./auth');

let site;
let server;
let waypoint;

test.before(async () => {
  const { startFakeWaypoint } = await import('fleet-kit/test/fakeWaypoint');
  waypoint = await startFakeWaypoint();
  Object.assign(process.env, waypoint.env());
  await initDb();
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  app.get('/auth/callback', wp.callback);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  site = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  await waypoint.close();
});

test.beforeEach(() => waypoint.reset());

const cookiesOf = (res) => res.headers.getSetCookie().map((c) => c.split(';')[0]);
const exchanges = () => waypoint.requests.filter((r) => r.path === '/oauth/token');

// Start the redirect without following it: the authorize URL and the state cookie it set.
async function start(query = '') {
  const res = await fetch(`${site}/api/auth/sso/login${query}`, { redirect: 'manual' });
  const setCookie = res.headers.getSetCookie().find((c) => c.startsWith('__Host-au_oauth_state=')) || '';
  return { status: res.status, url: new URL(res.headers.get('location')), cookie: setCookie.split(';')[0].split('=')[1] || null, setCookie, cookies: cookiesOf(res) };
}

const callback = async (query, cookies = []) => {
  const res = await fetch(`${site}/auth/callback${query}`, { redirect: 'manual', headers: cookies.length ? { Cookie: cookies.join('; ') } : {} });
  return { status: res.status, location: res.headers.get('location'), setCookie: res.headers.getSetCookie() };
};

test('starting sign-in keeps a fresh state in an httpOnly cookie and sends the same one to Waypoint', async () => {
  const first = await start();
  assert.strictEqual(first.status, 302);
  assert.strictEqual(first.url.origin + first.url.pathname, `${waypoint.url}/oauth/authorize`);
  assert.match(first.cookie, /^[0-9a-f]{32}$/);
  assert.strictEqual(first.url.searchParams.get('state'), first.cookie);
  assert.strictEqual(first.url.searchParams.get('redirect_uri'), `${site}/auth/callback`);
  assert.match(first.setCookie, /HttpOnly/i);
  assert.match(first.setCookie, /SameSite=Lax/i);
  assert.strictEqual(first.url.searchParams.has('prompt'), false);
  const second = await start();
  assert.notStrictEqual(second.cookie, first.cookie);
});

test('Switch account passes prompt=login on, and no other prompt', async () => {
  assert.strictEqual((await start('?prompt=login')).url.searchParams.get('prompt'), 'login');
  assert.strictEqual((await start('?prompt=none')).url.searchParams.has('prompt'), false);
});

test('a callback without the state cookie, or with another state, is refused before any code exchange', async () => {
  const { url, cookies } = await start();
  const state = url.searchParams.get('state');
  assert.strictEqual((await callback(`?code=abc&state=${state}`)).location, '/login?error=sso_state');
  assert.strictEqual((await callback('?code=abc&state=someone-elses', cookies)).location, '/login?error=sso_state');
  assert.strictEqual((await callback('?code=abc', cookies)).location, '/login?error=sso_state');
  assert.deepStrictEqual(exchanges(), []);
});

test('the matching state turns the code into a session on the page that asked, and the state is spent', async () => {
  waypoint.signInAs({ central_user_id: 77, username: 'captain' });
  const { url, cookies } = await start('?next=%2Flobby%2FABC123');
  const atWaypoint = await fetch(url, { redirect: 'manual' });
  const back = new URL(atWaypoint.headers.get('location'));
  const res = await callback(back.search, cookies);
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.location, '/lobby/ABC123');
  const session = res.setCookie.find((c) => c.startsWith(`${wp.session.name}=`));
  assert.ok(session, 'the session cookie is set');
  assert.match(session, /HttpOnly/i);
  assert.ok(res.setCookie.some((c) => /^__Host-au_oauth_state=;.*Secure/i.test(c)), 'the state cookie is cleared');
  assert.strictEqual(exchanges().length, 1);

  const me = await (await fetch(`${site}/api/auth/me`, { headers: { Cookie: session.split(';')[0] } })).json();
  assert.strictEqual(me.user.username, 'captain');
  assert.strictEqual(me.user.is_guest, false);
});

test('a code Waypoint refuses makes no session', async () => {
  const { url, cookies } = await start();
  const res = await callback(`?code=code-stolen&state=${url.searchParams.get('state')}`, cookies);
  assert.strictEqual(res.location, '/login?error=sso_exchange');
  assert.ok(!res.setCookie.some((c) => new RegExp(`^${wp.session.name}=[^;]+`).test(c)));
});

test('the config says Waypoint is on and guests are taken', async () => {
  const res = await (await fetch(`${site}/api/auth/config`)).json();
  assert.strictEqual(res.ssoEnabled, true);
  assert.strictEqual(res.guests, 'allow');
});

test('one-click guest: a Waypoint guest account and a session for it, seen as a guest', async () => {
  const res = await fetch(`${site}/api/auth/guest`, { method: 'POST' });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.match(body.user.username, /^guest-/);
  assert.strictEqual(body.user.is_guest, true);
  const session = res.headers.getSetCookie().find((c) => c.startsWith(`${wp.session.name}=`)).split(';')[0];
  const me = await (await fetch(`${site}/api/auth/me`, { headers: { Cookie: session } })).json();
  assert.strictEqual(me.user.id, body.user.id);
  assert.strictEqual(me.user.is_guest, true);
});
