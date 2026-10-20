// The guest sweep (services/guestSweep.js) against the real schema, in an in-process PGlite.
// What it may take is exactly an idle guest and what only guests had a part in: every other
// row in every table is compared, before and after, and must be there unchanged.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');

process.env.USE_PGLITE = '1';
process.env.JWT_SECRET = 'sweep-test-secret';
delete process.env.PGLITE_DIR;

// Sign-ins go to a stand-in Waypoint that answers with `central.login`.
const central = {};
const ssoPath = require.resolve('../config/sso');
require.cache[ssoPath] = {
  id: ssoPath, filename: ssoPath, loaded: true,
  exports: {
    SSO_ENABLED: true,
    AUTH_SERVICE_URL: 'http://auth.invalid',
    SSO_CLIENT_ID: 'test-client',
    centralRegister: async () => { throw new Error('not used'); },
    centralLogin: (body) => central.login(body),
    centralGuest: async () => { throw new Error('not used'); },
    exchangeCode: async () => { throw new Error('not used'); },
  },
};

const database = require('../config/database');
const initDb = require('../config/initDb');
const { sweepGuests, runGuestSweep } = require('./guestSweep');
/** The in-process PGlite is one session, so it is the sweep's one connection too. */
const db = { connect: async () => ({ query: (text, params) => database.query(text, params), release() {} }) };

before(async () => {
  await initDb();
});

const q = async (sql, params) => (await database.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];

/** Every row of every table, as text, by table. */
async function everything() {
  const out = {};
  for (const { name } of await q(`SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)) {
    out[name] = (await q(`SELECT to_jsonb(t)::text AS row FROM "${name}" t`)).map((r) => r.row).sort();
  }
  return out;
}
/** What went, by table: the rows of `was` that `now` no longer has. Fails if any row changed. */
function gone(was, now) {
  const out = {};
  for (const [table, rows] of Object.entries(was)) {
    const left = new Set(now[table]);
    for (const row of now[table]) assert.ok(rows.includes(row), `${table}: a row changed or appeared: ${row}`);
    const went = rows.filter((r) => !left.has(r)).map((r) => JSON.parse(r));
    if (went.length) out[table] = went;
  }
  return out;
}
const ids = (rows, col = 'id') => (rows ?? []).map((r) => r[col]).sort((a, b) => a - b);
const sorted = (list) => [...list].sort((a, b) => a - b);

let n = 0;
const USERS = 'users';
/** A user Waypoint's sign-in would make, last seen `days` ago. */
async function profile({ guest = false, name, days = 0, local = false } = {}) {
  n += 1;
  const username = name ?? (guest ? `guest-swift-otter-${1000 + n}` : `player${n}`);
  return one(
    `INSERT INTO users (username, password_hash, central_user_id, created_at, last_seen_at)
     VALUES ($1, $2, $3, NOW() - INTERVAL '400 days', NOW() - ($4 || ' days')::interval) RETURNING *`,
    [username, local ? '$2a$10$a-local-password-hash' : 'sso-managed', local ? null : 500 + n, String(days)]);
}
const game = async (maker) => {
  n += 1;
  const g = await one(`INSERT INTO games (code, created_by) VALUES ($1, $2) RETURNING *`, [`G${n}`, maker.id]);
  await play(g, maker, 'alpha');
  return g;
};
const play = (g, who, team = 'bravo') => q(`INSERT INTO game_players (game_id, user_id, team) VALUES ($1, $2, $3)`, [g.id, who.id, team]);

test('an idle guest goes with what only guests touched; an active guest, a real account and anything a real account has a part in stay', async () => {
  // a real account nobody has seen for over a year, with a game of its own
  const real = await profile({ days: 400 });
  const realGame = await game(real);

  // 1. two idle guests in a game of their own: the game, its roster and both guests go
  const idle = await profile({ guest: true, days: 40 });
  const idle2 = await profile({ guest: true, days: 35 });
  const idleGame = await game(idle);
  await play(idleGame, idle2);
  // 2. a guest whose name was taken here, so it carries its central id: goes too
  const suffixed = await profile({ guest: true, days: 40, name: 'guest-quiet-heron-0042#777' });
  // 3. a guest still in use: stays, with its game
  const active = await profile({ guest: true, days: 2 });
  await game(active);
  // 4. an idle guest's game the real account joined: the game stays, so the guest does
  const hosted = await profile({ guest: true, days: 40 });
  await play(await game(hosted), real);
  // 5. an idle guest that played in the real game: stays, and so does its seat
  const visitor = await profile({ guest: true, days: 40 });
  await play(realGame, visitor);
  // 6. a local password account from before Waypoint with a guest-like name: not a guest
  const local = await profile({ name: 'guest-brave-otter-1234', days: 400, local: true });
  // 7. real accounts whose names only look a little like a guest's
  const lookalike = await profile({ name: 'guest-house', days: 400 });

  const was = await everything();
  const r = await sweepGuests({ db, days: 30 });
  const went = gone(was, await everything());

  assert.deepEqual(Object.keys(went).sort(), ['game_players', 'games', 'users']);
  assert.deepEqual(ids(went.users), sorted([idle.id, idle2.id, suffixed.id]));
  assert.deepEqual(ids(went.games), [idleGame.id]);
  assert.deepEqual(ids(went.game_players, 'user_id'), sorted([idle.id, idle2.id]));
  assert.deepEqual(r, { stale: 5, made: 1, removed: 3, kept: 2 });
  for (const p of [real, active, hosted, visitor, local, lookalike]) {
    assert.ok(await one('SELECT 1 FROM users WHERE id = $1', [p.id]));
  }

  // a second run finds nothing more to take
  const again = await everything();
  assert.deepEqual(await sweepGuests({ db, days: 30 }), { stale: 2, made: 0, removed: 0, kept: 2 });
  assert.deepEqual(gone(again, await everything()), {});
});

test('every Waypoint sign-in notes the time, and a new user is seen when it is made', async () => {
  const express = require('express');
  const cookieParser = require('cookie-parser');
  const authRoutes = require('../routes/auth');
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const account = { central_user_id: 4242, email: 'stamp@example.com', username: 'stamper' };
    central.login = async () => ({ ...account });
    const login = () => fetch(`http://127.0.0.1:${server.address().port}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: account.email, password: 'pw' }),
    });
    assert.equal((await login()).status, 200);
    const fresh = `last_seen_at > NOW() - INTERVAL '1 minute' AS fresh`;
    assert.equal((await one(`SELECT ${fresh} FROM users WHERE central_user_id = 4242`)).fresh, true);
    await q(`UPDATE users SET last_seen_at = NOW() - INTERVAL '40 days' WHERE central_user_id = 4242`);
    assert.equal((await login()).status, 200);
    assert.equal((await one(`SELECT ${fresh} FROM users WHERE central_user_id = 4242`)).fresh, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the window is never shorter than a session, and a dry run takes nothing', async () => {
  const recent = await profile({ guest: true, days: 3 });
  const was = await everything();
  const dry = await sweepGuests({ db, days: 1, dryRun: true });
  assert.equal(dry.removed, 0);
  await sweepGuests({ db, days: 1 }); // a 1-day setting still waits out the 7-day session
  assert.deepEqual(gone(was, await everything()), {});
  assert.ok(await one(`SELECT 1 FROM ${USERS} WHERE id = $1`, [recent.id]));
  await assert.rejects(sweepGuests({ db, days: 0 }), /GUEST_RETENTION_DAYS must be a positive number/);
});

test('a failed run is logged, never thrown', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const r = await runGuestSweep({ db: { connect: async () => { throw new Error('database down'); } } });
  assert.deepEqual(r, { failed: 'database down' });
  assert.match(String(logged.mock.calls[0].arguments.join(' ')), /Guest sweep failed .*database down/);
});
