// The per-address limits on the sign-in routes that reach Waypoint: new accounts (routes/auth.js)
// and the code exchange at /auth/callback (fleet-kit's, as index.js mounts it). Waypoint sees only
// this server's address, so one visitor could otherwise use up everyone's sign-ins. The address
// counted is the one Railway's edge added last to X-Forwarded-For, not one the client wrote. SSO
// is off here, so each route answers on its own before it would reach Waypoint; the limit counts
// first. (The guest button's limit is the kit's own, tested there.)
const test = require('node:test');
const assert = require('node:assert');

process.env.USE_PGLITE = '1';
process.env.JWT_SECRET = 'sign-in-limits-test-secret';
for (const name of ['AUTH_SERVICE_URL', 'SSO_CLIENT_ID', 'SSO_CLIENT_SECRET']) delete process.env[name];

const express = require('express');
const { trustOneProxy } = require('fleet-kit/server');
const initDb = require('../config/initDb');
const { wp } = require('../config/auth');
const authRoutes = require('./auth');

let site;
let server;

test.before(async () => {
  await initDb();
  const app = trustOneProxy(express());
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  app.get('/auth/callback', wp.callback);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  site = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));

// What Railway's edge sends: whatever the client put in X-Forwarded-For, then the address it saw.
const send = async ({ method, route }, address, spoofed) => {
  const res = await fetch(`${site}${route}`, {
    method,
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': spoofed ? `${spoofed}, ${address}` : address,
    },
    body: method === 'POST' ? JSON.stringify({}) : undefined,
  });
  return { status: res.status, headers: res.headers, location: res.headers.get('location') };
};

const cases = [
  // the route, how many pass, what a request under the limit answers (no Waypoint in this test),
  // and what one over it answers
  { method: 'POST', route: '/api/auth/register', allowed: 10, under: 400, window: 60 * 60, over: (r) => r.status === 429 },
  { method: 'GET', route: '/auth/callback?code=x&state=y', allowed: 20, under: 503, window: 15 * 60, over: (r) => r.status === 302 && r.location === '/login?error=sso_busy' },
];

for (const c of cases) {
  test(`${c.route}: ${c.allowed} from one address, then turned away with Retry-After; a forged X-Forwarded-For doesn't help`, async () => {
    const address = `198.51.100.${10 + cases.indexOf(c)}`;
    for (let i = 0; i < c.allowed; i++) {
      const res = await send(c, address, `10.0.${i}.1`);
      assert.strictEqual(res.status, c.under, `request ${i + 1} is under the limit`);
    }
    const res = await send(c, address, '10.9.9.9');
    assert.ok(c.over(res), `turned away (${res.status} ${res.location})`);
    const retryAfter = Number(res.headers.get('retry-after'));
    assert.ok(retryAfter > 0 && retryAfter <= c.window, `Retry-After ${retryAfter}`);
    const other = await send(c, '203.0.113.200');
    assert.strictEqual(other.status, c.under, 'another address is not limited');
  });
}

test('each route has its own budget', async () => {
  const address = '192.0.2.77';
  for (let i = 0; i < 20; i++) await send(cases[1], address);
  assert.ok(cases[1].over(await send(cases[1], address)));
  assert.strictEqual((await send(cases[0], address)).status, 400, 'the account budget is untouched');
});
