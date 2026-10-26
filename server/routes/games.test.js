// Creating a game against an in-process PGlite database: the options must be ones the engine
// plays, and leaving them out gives the defaults.
const test = require('node:test');
const assert = require('node:assert');

process.env.USE_PGLITE = '1';
process.env.JWT_SECRET = 'games-test-secret';

const express = require('express');
const db = require('../config/database');
const initDb = require('../config/initDb');
const { wp } = require('../config/auth');
const gameRoutes = require('./games');

let base;
let server;
let token;

test.before(async () => {
  await initDb();
  const user = (await db.query(
    `INSERT INTO users (email, username, password_hash, role, is_active)
     VALUES ('cap@example.com', 'cap', 'x', 'player', true) RETURNING id, username, role`
  , [])).rows[0];
  token = wp.session.mint(user); // the session cookie a sign-in would set
  const app = express();
  app.use(express.json());
  app.use('/api/games', gameRoutes);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/games`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

const create = async (body) => {
  const res = await fetch(`${base}/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `${wp.session.name}=${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

test('a game is made with the mode and room setting asked for', async () => {
  const r = await create({ sameRoom: true, gameMode: 'live' });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.game.game_mode, 'live');
  assert.strictEqual(r.body.game.same_room, true);
});

test('left out, the options default to turn-based and online', async () => {
  const r = await create({});
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.game.game_mode, 'turn-based');
  assert.strictEqual(r.body.game.same_room, false);
});

test('a mode the engine does not play is refused, not stored', async () => {
  const before = (await db.query('SELECT COUNT(*)::int AS n FROM games', [])).rows[0].n;
  for (const gameMode of ['banana', 'LIVE', 42, ['live']]) {
    const r = await create({ sameRoom: false, gameMode });
    assert.strictEqual(r.status, 400, `gameMode ${JSON.stringify(gameMode)}`);
  }
  const after = (await db.query('SELECT COUNT(*)::int AS n FROM games', [])).rows[0].n;
  assert.strictEqual(after, before);
});

test('sameRoom must be true or false', async () => {
  for (const sameRoom of ['yes', 'abc', 1, {}]) {
    const r = await create({ sameRoom, gameMode: 'turn-based' });
    assert.strictEqual(r.status, 400, `sameRoom ${JSON.stringify(sameRoom)}`);
  }
});
