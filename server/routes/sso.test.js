// The Waypoint redirect and its callback, against an in-process PGlite database with the
// auth-service mocked. The OAuth state lives in an httpOnly cookie the server sets at
// /sso/login, and the callback only exchanges a code that comes back with that same state.
const test = require('node:test');
const assert = require('node:assert');

process.env.USE_PGLITE = '1';
process.env.JWT_SECRET = 'sso-test-secret';

// The mocked code exchange: `code-good` is one Waypoint account, anything else is refused.
const exchanged = [];
const ssoPath = require.resolve('../config/sso');
require.cache[ssoPath] = {
  id: ssoPath, filename: ssoPath, loaded: true,
  exports: {
    SSO_ENABLED: true,
    AUTH_SERVICE_URL: 'http://auth.invalid',
    SSO_CLIENT_ID: 'test-client',
    centralRegister: async () => { throw new Error('not used'); },
    centralLogin: async () => { throw new Error('not used'); },
    centralGuest: async () => { throw new Error('not used'); },
    exchangeCode: async (code) => {
      exchanged.push(code);
      if (code !== 'code-good') throw new Error('invalid_grant');
      return { central_user_id: 77, username: 'captain', email: null };
    },
  },
};

const express = require('express');
const cookieParser = require('cookie-parser');
const initDb = require('../config/initDb');
const authRoutes = require('./auth');

let base;
let server;

test.before(async () => {
  await initDb();
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/auth`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

test.beforeEach(() => { exchanged.length = 0; });

// Start the redirect without following it: the authorize URL and the state cookie it set.
async function start(query = '') {
  const res = await fetch(`${base}/sso/login${query}`, { redirect: 'manual' });
  const setCookie = res.headers.get('set-cookie') || '';
  const cookie = /au_oauth_state=([^;]*)/.exec(setCookie)?.[1] || null;
  return { status: res.status, url: new URL(res.headers.get('location')), cookie, setCookie };
}

const callback = async (body, cookie) => {
  const res = await fetch(`${base}/sso-callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: `au_oauth_state=${cookie}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json(), setCookie: res.headers.get('set-cookie') || '' };
};

test('starting sign-in keeps a fresh state in an httpOnly cookie and sends the same one to Waypoint', async () => {
  const first = await start();
  assert.strictEqual(first.status, 302);
  assert.strictEqual(first.url.origin + first.url.pathname, 'http://auth.invalid/oauth/authorize');
  assert.match(first.cookie, /^[0-9a-f]{32}$/);
  assert.strictEqual(first.url.searchParams.get('state'), first.cookie);
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

test('a callback without the state cookie is refused before any code exchange', async () => {
  const { url } = await start();
  const res = await callback({ code: 'code-good', state: url.searchParams.get('state') });
  assert.strictEqual(res.status, 400);
  assert.deepStrictEqual(exchanged, []);
});

test('a callback whose state is not the cookie\'s is refused before any code exchange', async () => {
  const { cookie } = await start();
  assert.strictEqual((await callback({ code: 'code-good', state: 'someone-elses' }, cookie)).status, 400);
  assert.strictEqual((await callback({ code: 'code-good' }, cookie)).status, 400);
  assert.deepStrictEqual(exchanged, []);
});

test('the matching state turns the code into a session, and the cookie is spent', async () => {
  const { cookie, url } = await start();
  const res = await callback({ code: 'code-good', state: url.searchParams.get('state') }, cookie);
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.token);
  assert.strictEqual(res.body.user.username, 'captain');
  assert.deepStrictEqual(exchanged, ['code-good']);
  // The answer clears the cookie, so the same state can't be used twice.
  assert.match(res.setCookie, /au_oauth_state=;/);
});

test('a code Waypoint refuses makes no session', async () => {
  const { cookie, url } = await start();
  const res = await callback({ code: 'code-stolen', state: url.searchParams.get('state') }, cookie);
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.body.token, undefined);
});

test('the config names Waypoint, for Sign out of all games', async () => {
  const res = await fetch(`${base}/config`);
  assert.deepStrictEqual(await res.json(), { ssoEnabled: true, authUrl: 'http://auth.invalid' });
});
