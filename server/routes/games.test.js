// Creating a game against an in-process PGlite database: the options must be ones the game
// plays, leaving them out gives the defaults, and one person's open lobbies are capped.
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
let other;

test.before(async () => {
  await initDb();
  const mk = async (name) => (await db.query(
    `INSERT INTO users (email, username, password_hash, role, is_active)
     VALUES ($1, $2, 'x', 'player', true) RETURNING id, username, role`,
    [`${name}@example.com`, name],
  )).rows[0];
  token = wp.session.mint(await mk('cap')); // the session cookie a sign-in would set
  other = wp.session.mint(await mk('mate'));
  const app = express();
  app.use(express.json());
  app.use('/api/games', gameRoutes);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/games`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

const create = async (body, as = token) => {
  const res = await fetch(`${base}/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `${wp.session.name}=${as}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

test('a game is made with the mode and room setting asked for', async () => {
  for (const gameMode of ['tutorial', 'vs-ai-easy', 'vs-ai-normal', 'vs-ai-hard', 'crews']) {
    const r = await create({ sameRoom: true, gameMode });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.game.game_mode, gameMode);
    assert.strictEqual(r.body.game.same_room, true);
  }
});

test("an old page's mode names still make a game, stored as the difficulty they meant", async () => {
  assert.strictEqual((await create({ gameMode: 'vs-ai' })).body.game.game_mode, 'vs-ai-easy');
  assert.strictEqual((await create({ gameMode: 'vs-ai-veteran' })).body.game.game_mode, 'vs-ai-hard');
});

test('left out, the options default to playing the AI on Normal, online', async () => {
  const r = await create({});
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.game.game_mode, 'vs-ai-normal');
  assert.strictEqual(r.body.game.same_room, false);
});

test('a mode the game does not play is refused, not stored (the old turn-based one too)', async () => {
  const before = (await db.query('SELECT COUNT(*)::int AS n FROM games', [])).rows[0].n;
  // case, made-up levels, other types, and the names every object has ('constructor', '__proto__')
  for (const gameMode of ['banana', 'VS-AI', 'Tutorial', 'vs-ai-insane', 'vs-ai-', 42, ['crews'], { tutorial: true }, 'turn-based', 'live', 'constructor', '__proto__', 'toString']) {
    const r = await create({ sameRoom: false, gameMode });
    assert.strictEqual(r.status, 400, `gameMode ${JSON.stringify(gameMode)}`);
  }
  const after = (await db.query('SELECT COUNT(*)::int AS n FROM games', [])).rows[0].n;
  assert.strictEqual(after, before);
});

test('sameRoom must be true or false', async () => {
  for (const sameRoom of ['yes', 'abc', 1, {}]) {
    const r = await create({ sameRoom, gameMode: 'crews' });
    assert.strictEqual(r.status, 400, `sameRoom ${JSON.stringify(sameRoom)}`);
  }
});

test('one person holds at most ten open lobbies; each answer says how many are open, and others are not held back', async () => {
  let r;
  let last;
  for (let i = 0; i < 12; i++) {
    r = await create({ gameMode: 'crews' }, other);
    if (r.status === 201) last = r.body;
  }
  assert.strictEqual(last.openLobbies, 10);
  assert.strictEqual(last.lobbyCap, 10);
  assert.strictEqual(r.status, 429);
  assert.match(r.body.error, /10 open lobbies/);
  // starting one frees a place
  await db.query(`UPDATE games SET status = 'playing' WHERE code = $1`, [last.game.code]);
  assert.strictEqual((await create({ gameMode: 'crews' }, other)).status, 201);
  // someone else is not counted against
  assert.strictEqual((await create({ gameMode: 'vs-ai' })).status, 201);
});

test('one person makes at most sixty games a day, started ones too (a tutorial starts itself); each answer says how many', async () => {
  const id = (await db.query(
    `INSERT INTO users (email, username, password_hash, role, is_active) VALUES ('many@example.com', 'many', 'x', 'player', true) RETURNING id, username, role`,
  )).rows[0];
  const many = wp.session.mint(id);
  let r;
  for (let i = 0; i < 60; i++) {
    r = await create({ gameMode: 'tutorial' }, many);
    assert.strictEqual(r.status, 201, `game ${i + 1}`);
    await db.query(`UPDATE games SET status = 'playing' WHERE code = $1`, [r.body.game.code]); // it dives at once
  }
  assert.deepEqual([r.body.madeToday, r.body.dayCap], [60, 60]);
  r = await create({ gameMode: 'vs-ai-easy' }, many);
  assert.strictEqual(r.status, 429);
  assert.match(r.body.error, /60 games today/);
  assert.strictEqual(r.body.madeToday, 60);
  // a day on, there is room again
  await db.query(`UPDATE games SET created_at = NOW() - INTERVAL '25 hours' WHERE created_by = $1`, [id.id]);
  assert.strictEqual((await create({ gameMode: 'vs-ai-easy' }, many)).status, 201);
});
