// Auth routes with SSO switched on, against an in-process PGlite database. The central
// auth-service is mocked so each case decides what it answers.
const test = require('node:test');
const assert = require('node:assert');

process.env.USE_PGLITE = '1';
process.env.JWT_SECRET = 'auth-test-secret';

// What the mocked auth-service does; each case overrides the parts it needs.
const central = {};
const resetCentral = () => {
  central.register = async () => { throw new Error('central register not expected'); };
  central.login = async () => { throw new Error('Invalid credentials'); };
};

const ssoPath = require.resolve('../config/sso');
require.cache[ssoPath] = {
  id: ssoPath, filename: ssoPath, loaded: true,
  exports: {
    SSO_ENABLED: true,
    AUTH_SERVICE_URL: 'http://auth.invalid',
    SSO_CLIENT_ID: 'test-client',
    centralRegister: (body) => central.register(body),
    centralLogin: (body) => central.login(body),
    centralGuest: async () => { throw new Error('not used'); },
    exchangeCode: async () => { throw new Error('not used'); },
  },
};

const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const db = require('../config/database');
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

test.beforeEach(async () => {
  resetCentral();
  await db.query('DELETE FROM users WHERE id > $1', [0]);
});

const post = async (path, body) => {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

const usersWithEmail = async (email) =>
  (await db.query('SELECT id, central_user_id FROM users WHERE LOWER(email) = LOWER($1)', [email])).rows;

// A central account and the password that opens it.
const victim = { central_user_id: 42, email: 'victim@example.com', username: 'victim' };
const centralAccepts = (account, password) => async (body) => {
  if (body.email === account.email && body.password === password) return { ...account };
  throw new Error('Invalid credentials');
};

test('a sign-up the auth-service refuses makes no local account', async () => {
  // The email already belongs to someone's central account.
  central.register = async () => {
    const err = new Error('Email already registered');
    err.status = 409;
    throw err;
  };

  const res = await post('/register', { email: victim.email, username: 'squatter', password: 'squatter-pass' });

  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'Email already registered');
  assert.strictEqual(res.body.token, undefined);
  assert.deepStrictEqual(await usersWithEmail(victim.email), []);
});

test('a sign-up is refused while the auth-service cannot be reached', async () => {
  central.register = async () => { throw new Error('fetch failed'); };

  const res = await post('/register', { email: 'new@example.com', username: 'newbie', password: 'secret-pass' });

  assert.strictEqual(res.status, 503);
  assert.deepStrictEqual(await usersWithEmail('new@example.com'), []);
});

test('the first SSO login that adopts a local row retires that row\'s local password', async () => {
  // An unclaimed local row carrying the victim's email, with a password someone else chose.
  const hash = await bcrypt.hash('squatter-pass', 4);
  const planted = await db.query(
    `INSERT INTO users (email, username, password_hash, role, is_active)
     VALUES ($1, 'squatter', $2, 'player', true) RETURNING id`,
    [victim.email, hash]
  );
  central.login = centralAccepts(victim, 'victim-pass');

  const adopted = await post('/login', { username: victim.email, password: 'victim-pass' });
  assert.strictEqual(adopted.status, 200);
  assert.strictEqual(adopted.body.user.id, planted.rows[0].id);

  const squatter = await post('/login', { username: victim.email, password: 'squatter-pass' });
  assert.strictEqual(squatter.status, 401);
  const byUsername = await post('/login', { username: 'squatter', password: 'squatter-pass' });
  assert.strictEqual(byUsername.status, 401);

  // The owner still gets in through the auth-service.
  const again = await post('/login', { username: victim.email, password: 'victim-pass' });
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.body.user.id, planted.rows[0].id);
});

test('a sign-up the auth-service accepts is linked and still signs in locally', async () => {
  central.register = async ({ username, email }) => ({ central_user_id: 7, username, email });

  const reg = await post('/register', { email: 'ok@example.com', username: 'okay', password: 'okay-pass' });
  assert.strictEqual(reg.status, 201);
  assert.ok(reg.body.token);
  assert.deepStrictEqual((await usersWithEmail('ok@example.com')).map((u) => u.central_user_id), [7]);

  // With the auth-service down, the local password is the fallback, as before.
  central.login = async () => { throw new Error('fetch failed'); };
  const login = await post('/login', { username: 'okay', password: 'okay-pass' });
  assert.strictEqual(login.status, 200);
  assert.strictEqual(login.body.user.id, reg.body.user.id);
});

test('a local account with no central account still signs in with its password', async () => {
  const hash = await bcrypt.hash('local-pass', 4);
  await db.query(
    `INSERT INTO users (email, username, password_hash, role, is_active)
     VALUES ('old@example.com', 'oldtimer', $1, 'player', true)`,
    [hash]
  );

  const login = await post('/login', { username: 'oldtimer', password: 'local-pass' });
  assert.strictEqual(login.status, 200);
  assert.strictEqual(login.body.user.username, 'oldtimer');
});
