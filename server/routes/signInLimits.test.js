// The per-address limits on the sign-in routes that reach Waypoint (routes/auth.js): new
// accounts, guest sign-ins and the SSO code exchange. Waypoint sees only this server's address,
// so one visitor could otherwise use up everyone's sign-ins. The address counted is the one
// Railway's edge added last to X-Forwarded-For, not one the client wrote. SSO is off here, so
// each route answers on its own before it would reach Waypoint; the limit counts first.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.USE_PGLITE = '1';
process.env.JWT_SECRET = 'sign-in-limits-test-secret';

const ssoPath = require.resolve('../config/sso');
require.cache[ssoPath] = {
  id: ssoPath, filename: ssoPath, loaded: true,
  exports: {
    SSO_ENABLED: false,
    AUTH_SERVICE_URL: '',
    SSO_CLIENT_ID: '',
    centralRegister: async () => { throw new Error('not used'); },
    centralLogin: async () => { throw new Error('not used'); },
    centralGuest: async () => { throw new Error('not used'); },
    exchangeCode: async () => { throw new Error('not used'); },
  },
};

const express = require('express');
const initDb = require('../config/initDb');
const authRoutes = require('./auth');

const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const trustProxy = JSON.parse(indexSource.match(/app\.set\('trust proxy', ([^)]+)\)/)[1]);

let base;
let server;

test.before(async () => {
  await initDb();
  const app = express();
  app.set('trust proxy', trustProxy);
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/auth`;
});

test.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));

// What Railway's edge sends: whatever the client put in X-Forwarded-For, then the address it saw.
const post = async (route, address, spoofed) => {
  const res = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': spoofed ? `${spoofed}, ${address}` : address,
    },
    body: JSON.stringify({}),
  });
  return { status: res.status, headers: res.headers, body: await res.json() };
};

const cases = [
  // route, how many pass, what a request under the limit answers (no Waypoint in this test)
  { route: '/register', allowed: 10, under: 400, window: 60 * 60 },
  { route: '/guest', allowed: 10, under: 503, window: 15 * 60 },
  { route: '/sso-callback', allowed: 20, under: 404, window: 15 * 60 },
];

for (const { route, allowed, under, window } of cases) {
  test(`${route}: ${allowed} from one address, then 429 with Retry-After; a forged X-Forwarded-For doesn't help`, async () => {
    const address = `198.51.100.${10 + cases.findIndex((c) => c.route === route)}`;
    for (let i = 0; i < allowed; i++) {
      const res = await post(route, address, `10.0.${i}.1`);
      assert.strictEqual(res.status, under, `request ${i + 1} is under the limit`);
    }
    const res = await post(route, address, '10.9.9.9');
    assert.strictEqual(res.status, 429);
    assert.strictEqual(Number(res.headers.get('retry-after')), window);
    assert.match(res.body.error, /Try again/);
    const other = await post(route, '203.0.113.200');
    assert.strictEqual(other.status, under, 'another address is not limited');
  });
}

test('each route has its own budget', async () => {
  const address = '192.0.2.77';
  for (let i = 0; i < 10; i++) await post('/guest', address);
  assert.strictEqual((await post('/guest', address)).status, 429);
  assert.strictEqual((await post('/register', address)).status, 400, 'the account budget is untouched');
});
