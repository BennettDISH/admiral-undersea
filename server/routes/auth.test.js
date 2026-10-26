// The game's own password forms and the session, with SSO switched on, against an in-process
// PGlite database and fleet-kit's stand-in Waypoint, which each case tells what to answer.
const test = require('node:test');
const assert = require('node:assert');

process.env.USE_PGLITE = '1';
process.env.JWT_SECRET = 'auth-test-secret';
delete process.env.SESSION_SECRET;

const express = require('express');
const jwtSign = (claims, secret) => {
  // what jsonwebtoken minted before the move: HS256, { id, username, role, iat, exp }
  const crypto = require('node:crypto');
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const data = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}`;
  return `${data}.${crypto.createHmac('sha256', secret).update(data).digest('base64url')}`;
};
const bcrypt = require('bcryptjs');
const db = require('../config/database');
const initDb = require('../config/initDb');
const { wp } = require('../config/auth');
const authRoutes = require('./auth');

let base;
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
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/auth`;
});

test.after(async () => {
  await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  await waypoint.close();
});

test.beforeEach(async () => {
  waypoint.reset();
  Object.assign(process.env, waypoint.env());
  await db.query('DELETE FROM users WHERE id > $1', [0]);
});

const sessionOf = (res) => res.headers.getSetCookie().find((c) => c.startsWith(`${wp.session.name}=`))?.split(';')[0].split('=')[1];
const post = async (path, body, headers = {}) => {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json(), session: sessionOf(res) };
};
const me = async (headers) => (await (await fetch(`${base}/me`, { headers })).json()).user;
const withSession = (session) => ({ Cookie: `${wp.session.name}=${session}` });

const usersWithEmail = async (email) =>
  (await db.query('SELECT id, central_user_id FROM users WHERE LOWER(email) = LOWER($1)', [email])).rows;

// A central account and the password that opens it.
const victim = { central_user_id: 42, email: 'victim@example.com', username: 'victim', password: 'victim-pass' };

test('a sign-up the auth-service refuses makes no local account', async () => {
  // The email already belongs to someone's central account.
  waypoint.status = 409;

  const res = await post('/register', { email: victim.email, username: 'squatter', password: 'squatter-pass' });

  assert.strictEqual(res.status, 400);
  assert.ok(res.body.error);
  assert.strictEqual(res.session, undefined);
  assert.deepStrictEqual(await usersWithEmail(victim.email), []);
});

test('a sign-up is refused while the auth-service cannot be reached', async () => {
  process.env.AUTH_SERVICE_URL = 'http://127.0.0.1:9';

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
  waypoint.addUser(victim);

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

test('a sign-up the auth-service accepts is linked, sets the session, and still signs in locally', async () => {
  const reg = await post('/register', { email: 'ok@example.com', username: 'okay', password: 'okay-pass' });
  assert.strictEqual(reg.status, 201);
  assert.strictEqual(reg.body.token, undefined, 'no token for the page to keep');
  assert.ok(reg.session, 'the session cookie is set');
  assert.strictEqual((await me(withSession(reg.session))).id, reg.body.user.id);
  const [linked] = await usersWithEmail('ok@example.com');
  assert.ok(Number.isInteger(linked.central_user_id));

  // With the auth-service down, the local password is the fallback, as before.
  waypoint.status = 500;
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
  assert.ok(login.session);
});

test('signing out ends the session on every device', async () => {
  const hash = await bcrypt.hash('local-pass', 4);
  await db.query(`INSERT INTO users (email, username, password_hash) VALUES ('two@example.com', 'twodevices', $1)`, [hash]);
  const phone = (await post('/login', { username: 'twodevices', password: 'local-pass' })).session;
  const laptop = (await post('/login', { username: 'twodevices', password: 'local-pass' })).session;
  assert.ok(await me(withSession(laptop)));
  const out = await post('/logout', {}, withSession(phone));
  assert.strictEqual(out.status, 200);
  assert.strictEqual(await me(withSession(phone)), null);
  assert.strictEqual(await me(withSession(laptop)), null);
  // and the next sign-in works
  const back = (await post('/login', { username: 'twodevices', password: 'local-pass' })).session;
  assert.ok(await me(withSession(back)));
});

test('a page that still holds the old token is moved onto the cookie once, with the end it had', async () => {
  const { rows: [u] } = await db.query(`INSERT INTO users (email, username, password_hash) VALUES ('old@token.test', 'oldtoken', 'x') RETURNING id`);
  const now = Math.floor(Date.now() / 1000);
  const old = jwtSign({ id: u.id, username: 'oldtoken', role: 'player', iat: now - 86400, exp: now + 2 * 86400 }, process.env.JWT_SECRET);
  const res = await fetch(`${base}/me`, { headers: { Authorization: `Bearer ${old}` } });
  const body = await res.json();
  assert.strictEqual(body.user.id, u.id);
  const session = sessionOf(res);
  assert.ok(session, 'swapped for the session cookie');
  const { exp } = JSON.parse(Buffer.from(session.split('.')[1], 'base64url').toString());
  assert.ok(exp <= now + 2 * 86400 + 5 && exp > now + 86400, 'the old end is kept, not extended');
  assert.strictEqual((await me(withSession(session))).id, u.id);
  // a token signed with anything else is nobody
  const forged = jwtSign({ id: u.id, iat: now, exp: now + 3600 }, 'not-the-secret');
  assert.strictEqual(await me({ Authorization: `Bearer ${forged}` }), null);
});
