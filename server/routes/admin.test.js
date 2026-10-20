// Admin views against an in-process PGlite database: who gets in, paging, search, and that
// no password hash ever leaves.
const test = require('node:test');
const assert = require('node:assert');

process.env.USE_PGLITE = '1';
process.env.JWT_SECRET = 'admin-test-secret';

const express = require('express');
const db = require('../config/database');
const initDb = require('../config/initDb');
const { signToken } = require('../config/jwt');
const adminRoutes = require('./admin');

const ADMIN_CENTRAL = 900;
let base;
let server;
let admin;
let player;
let localOnly;

const addUser = async (username, centralId, email = `${username}@example.com`) =>
  (await db.query(
    `INSERT INTO users (email, username, password_hash, role, is_active, central_user_id)
     VALUES ($1, $2, '$2a$10$secret-hash-never-shown', 'player', true, $3)
     RETURNING id, username, role`,
    [email, username, centralId]
  )).rows[0];

const addGame = async (code, createdBy, players, extra = {}) => {
  const g = (await db.query(
    `INSERT INTO games (code, status, created_by, winner_team, created_at)
     VALUES ($1, $2, $3, $4, NOW() - make_interval(mins => $5::int)) RETURNING id`,
    [code, extra.status || 'lobby', createdBy, extra.winner || null, extra.ago || 0]
  )).rows[0];
  for (const [user, team] of players) {
    await db.query(
      `INSERT INTO game_players (game_id, user_id, team, roles) VALUES ($1, $2, $3, 'captain')`,
      [g.id, user.id, team]
    );
  }
  return g;
};

test.before(async () => {
  await initDb();
  admin = await addUser('admiral', ADMIN_CENTRAL);
  player = await addUser('deckhand', 901);
  localOnly = await addUser('oldsalt', null);
  // 120 more accounts so the users list runs to three pages.
  for (let i = 0; i < 120; i++) await addUser(`crew_${String(i).padStart(3, '0')}`, 1000 + i);

  await addGame('AAAAAA', admin.id, [[admin, 'alpha'], [player, 'bravo']], { status: 'finished', winner: 'alpha', ago: 30 });
  await addGame('BBBBBB', player.id, [[player, 'alpha']], { status: 'playing', ago: 20 });
  await addGame('CCCCCC', localOnly.id, [], { ago: 10 });

  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoutes);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/admin`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

test.beforeEach(() => { process.env.ADMIN_CENTRAL_USER_IDS = ` ${ADMIN_CENTRAL}, 77 `; });

const get = async (path, user) => {
  const headers = user ? { Authorization: `Bearer ${signToken(user)}` } : {};
  const res = await fetch(`${base}${path}`, { headers });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) };
};

test('signed-out visitors get 401 and other players 403', async () => {
  for (const path of ['/users', '/games']) {
    assert.strictEqual((await get(path)).status, 401);
    assert.strictEqual((await get(path, player)).status, 403);
    assert.strictEqual((await get(path, localOnly)).status, 403);
    assert.strictEqual((await get(path, admin)).status, 200);
  }
});

test('the gate fails closed when ADMIN_CENTRAL_USER_IDS is unset or empty', async () => {
  delete process.env.ADMIN_CENTRAL_USER_IDS;
  assert.strictEqual((await get('/users', admin)).status, 403);
  process.env.ADMIN_CENTRAL_USER_IDS = ' , junk';
  assert.strictEqual((await get('/games', admin)).status, 403);
});

test('/me says who is an admin without opening anything', async () => {
  assert.deepStrictEqual((await get('/me', admin)).body, { isAdmin: true });
  assert.deepStrictEqual((await get('/me', player)).body, { isAdmin: false });
  assert.strictEqual((await get('/me')).status, 401);
});

test('users page 50 at a time, newest first', async () => {
  const p1 = await get('/users', admin);
  assert.strictEqual(p1.body.total, 123);
  assert.strictEqual(p1.body.totalPages, 3);
  assert.strictEqual(p1.body.users.length, 50);
  const p3 = await get('/users?page=3', admin);
  assert.strictEqual(p3.body.users.length, 23);
  assert.strictEqual(p3.body.page, 3);
  const seen = new Set([...p1.body.users, ...p3.body.users].map((u) => u.id));
  assert.strictEqual(seen.size, 73);
  assert.strictEqual((await get('/users?page=junk', admin)).body.page, 1);
});

test('users search matches name or email, with % and _ taken literally', async () => {
  const r = await get('/users?q=DECK', admin);
  assert.deepStrictEqual(r.body.users.map((u) => u.username), ['deckhand']);
  const byEmail = await get('/users?q=oldsalt@example', admin);
  assert.deepStrictEqual(byEmail.body.users.map((u) => u.username), ['oldsalt']);
  assert.strictEqual((await get('/users?q=crew_00', admin)).body.total, 10);
  // Unescaped, "k_a" would match "deckhand" and "crew%" every crew account.
  assert.strictEqual((await get('/users?q=k_a', admin)).body.total, 0);
  assert.strictEqual((await get('/users?q=crew%25', admin)).body.total, 0);
});

test('users carry games played, won and created, and never a password hash', async () => {
  const r = await get('/users?q=admiral', admin);
  const u = r.body.users[0];
  assert.strictEqual(u.games_played, 1);
  assert.strictEqual(u.games_won, 1);
  assert.strictEqual(u.games_created, 1);
  assert.strictEqual(u.waypoint, true);
  const d = (await get('/users?q=deckhand', admin)).body.users[0];
  assert.strictEqual(d.games_played, 2);
  assert.strictEqual(d.games_won, 0);
  for (const page of [1, 2, 3]) {
    const all = await get(`/users?page=${page}`, admin);
    assert.ok(!all.text.includes('password'));
    assert.ok(!all.text.includes('secret-hash'));
    assert.ok(!all.text.includes('central_user_id'));
  }
});

test('games list players and winners, newest first', async () => {
  const r = await get('/games', admin);
  assert.strictEqual(r.body.total, 3);
  assert.deepStrictEqual(r.body.games.map((g) => g.code), ['CCCCCC', 'BBBBBB', 'AAAAAA']);
  const done = r.body.games[2];
  assert.strictEqual(done.winner_team, 'alpha');
  assert.strictEqual(done.creator_name, 'admiral');
  assert.deepStrictEqual(
    done.players.map((p) => [p.username, p.team]),
    [['admiral', 'alpha'], ['deckhand', 'bravo']]
  );
  assert.deepStrictEqual(r.body.games[0].players, []);
  assert.ok(!r.text.includes('secret-hash'));
});

test('games filter by search, status and account', async () => {
  const code = await get('/games?q=bbb', admin);
  assert.deepStrictEqual(code.body.games.map((g) => g.code), ['BBBBBB']);
  const byPlayer = await get('/games?q=deckhand', admin);
  assert.deepStrictEqual(byPlayer.body.games.map((g) => g.code), ['BBBBBB', 'AAAAAA']);
  const finished = await get('/games?status=finished', admin);
  assert.deepStrictEqual(finished.body.games.map((g) => g.code), ['AAAAAA']);
  const mine = await get(`/games?user=${localOnly.id}`, admin);
  assert.deepStrictEqual(mine.body.games.map((g) => g.code), ['CCCCCC']);
  assert.strictEqual((await get('/games?status=sunk', admin)).status, 400);
  assert.strictEqual((await get('/games?user=abc', admin)).status, 400);
});

test('games page 50 at a time', async () => {
  for (let i = 0; i < 60; i++) await addGame(`P${String(i).padStart(5, '0')}`, player.id, [], { ago: 100 + i });
  try {
    const p1 = await get('/games', admin);
    assert.strictEqual(p1.body.total, 63);
    assert.strictEqual(p1.body.games.length, 50);
    assert.strictEqual((await get('/games?page=2', admin)).body.games.length, 13);
  } finally {
    await db.query(`DELETE FROM games WHERE code LIKE 'P%'`);
  }
});
