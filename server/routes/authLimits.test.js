// The old local sign-in can't be used to guess passwords at full speed, and the address it
// counts is the one Railway's edge adds last to X-Forwarded-For, not one the client wrote.
// In-process PGlite; SSO off, so every password is checked locally.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.USE_PGLITE = '1';
process.env.JWT_SECRET = 'auth-limits-test-secret';
for (const name of ['AUTH_SERVICE_URL', 'SSO_CLIENT_ID', 'SSO_CLIENT_SECRET']) delete process.env[name];

const express = require('express');
const bcrypt = require('bcryptjs');
const { trustOneProxy } = require('fleet-kit/server');
const db = require('../config/database');
const initDb = require('../config/initDb');
const authRoutes = require('./auth');

let base;
let server;

test.before(async () => {
  await initDb();
  // the server's own setting (index.js), so this app sees addresses the way production does
  const app = trustOneProxy(express());
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/auth`;

  const hash = await bcrypt.hash('right-password', 4);
  for (const name of ['target', 'bystander', 'typist']) {
    await db.query(
      `INSERT INTO users (email, username, password_hash, role, is_active)
       VALUES ($1, $2, $3, 'player', true)`,
      [`${name}@example.com`, name, hash]
    );
  }
});

test.after(() => new Promise((resolve) => server.close(resolve)));

// What Railway's edge sends: whatever the client put in X-Forwarded-For, then the address it saw.
const login = async (username, password, address, spoofed) => {
  const res = await fetch(`${base}/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': spoofed ? `${spoofed}, ${address}` : address,
    },
    body: JSON.stringify({ username, password }),
  });
  return { status: res.status, headers: res.headers, body: await res.json() };
};

test('the server trusts exactly one proxy hop', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(source, /const app = trustOneProxy\(express\(\)\);/);
  assert.ok(!/app\.set\('trust proxy'/.test(source), 'nothing sets it to anything else');
});

test('10 wrong passwords for one name make that name wait, from any address', async () => {
  let res;
  for (let i = 0; i < 10; i++) {
    res = await login('target', `guess-${i}`, `203.0.113.${i + 1}`);
    assert.strictEqual(res.status, 401, `guess ${i + 1}`);
  }
  res = await login('TARGET', 'right-password', '203.0.113.99');
  assert.strictEqual(res.status, 429, 'even the right password waits');
  assert.match(res.body.error, /Too many wrong passwords/);
  const retryAfter = Number(res.headers.get('retry-after'));
  assert.ok(retryAfter > 0 && retryAfter <= 15 * 60, `Retry-After ${retryAfter}`);

  res = await login('target@example.com', 'right-password', '203.0.113.99');
  assert.strictEqual(res.status, 200, 'the email is a name of its own');
  res = await login('bystander', 'right-password', '203.0.113.1');
  assert.strictEqual(res.status, 200, 'other names still sign in from the same addresses');
});

test('a right password clears that name\'s wrong ones', async () => {
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < 9; i++) {
      const res = await login('typist', `typo-${i}`, `192.0.2.${round * 10 + i + 1}`);
      assert.strictEqual(res.status, 401);
    }
    const res = await login('typist', 'right-password', '192.0.2.200');
    assert.strictEqual(res.status, 200, `round ${round + 1}`);
  }
});

test('30 wrong passwords from one address make it wait, and a forged X-Forwarded-For doesn\'t help', async () => {
  for (let i = 0; i < 30; i++) {
    const res = await login(`nobody-${i}`, 'whatever', '198.51.100.50', `10.0.${i}.1`);
    assert.strictEqual(res.status, 401, `guess ${i + 1}`);
  }
  let res = await login('bystander', 'right-password', '198.51.100.50', '10.9.9.9');
  assert.strictEqual(res.status, 429);

  res = await login('bystander', 'right-password', '198.51.100.51');
  assert.strictEqual(res.status, 200, 'another address still signs in');
});
