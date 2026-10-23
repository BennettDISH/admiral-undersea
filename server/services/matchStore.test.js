// The match store (services/matchStore.js) against the real schema, in an in-process PGlite:
// what is written reads back whole, and what is old goes and nothing else.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');

process.env.USE_PGLITE = '1';
process.env.JWT_SECRET = 'match-store-test-secret';
delete process.env.PGLITE_DIR;

const database = require('../config/database');
const initDb = require('../config/initDb');
const engine = require('../game/engine');
const matchStore = require('./matchStore');

const q = async (sql, params) => (await database.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];

let userId;
before(async () => {
  await initDb();
  await initDb(); // every statement is idempotent: a second boot changes nothing
  userId = (await one(`INSERT INTO users (username, password_hash) VALUES ('captain', 'x') RETURNING id`)).id;
});

/** A game row; `endedAgo` and `idleFor` are in days, 0 meaning now. */
async function makeGame(code, { status = 'lobby', endedDaysAgo = null } = {}) {
  await q(
    `INSERT INTO games (code, status, created_by, ended_at) VALUES ($1, $2, $3, ${endedDaysAgo === null ? 'NULL' : `NOW() - INTERVAL '${endedDaysAgo} days'`})`,
    [code, status, userId],
  );
}
const age = (code, days) => q(
  `UPDATE game_matches SET updated_at = NOW() - INTERVAL '${days} days' WHERE game_id = (SELECT id FROM games WHERE code = $1)`,
  [code],
);
const stored = async () => (await q(`SELECT g.code FROM game_matches gm JOIN games g ON g.id = gm.game_id ORDER BY g.code`)).map((r) => r.code);

test('a match reads back as it was written', async () => {
  await makeGame('RT0001', { status: 'playing' });
  const state = engine.initGameState('live', true);
  engine.applyMove(state, 'alpha', 'S', { now: 1000 });
  state.automatedRoles = { alpha: ['engineer'] };
  state.systemPriority = { alpha: ['sonar', 'mine'] };
  state.touchedAt = 12345;
  assert.equal(await matchStore.save('RT0001', state), true);
  assert.deepEqual(await matchStore.load('RT0001'), JSON.parse(JSON.stringify(state)));
});

test('writing again replaces the match, and a lobby setup is kept the same way', async () => {
  await makeGame('RT0002');
  await matchStore.save('RT0002', { automatedRoles: { bravo: ['first-mate'] }, systemPriority: {} });
  assert.deepEqual(await matchStore.load('RT0002'), { automatedRoles: { bravo: ['first-mate'] }, systemPriority: {} });
  await matchStore.save('RT0002', { automatedRoles: { bravo: [] }, systemPriority: { bravo: ['drone'] } });
  assert.deepEqual(await matchStore.load('RT0002'), { automatedRoles: { bravo: [] }, systemPriority: { bravo: ['drone'] } });
  assert.equal((await q(`SELECT 1 FROM game_matches gm JOIN games g ON g.id = gm.game_id WHERE g.code = 'RT0002'`)).length, 1);
});

test('a code with no game stores nothing, and loads as nothing', async () => {
  await matchStore.save('NOGAME', { automatedRoles: {}, systemPriority: {} });
  assert.equal(await matchStore.load('NOGAME'), null);
  assert.ok(!(await stored()).includes('NOGAME'));
  await makeGame('EMPTY1');
  assert.equal(await matchStore.load('EMPTY1'), null, 'a game with no stored match');
});

test('a stored value that is not a match is not loaded', async () => {
  await makeGame('BAD001');
  const id = (await one(`SELECT id FROM games WHERE code = 'BAD001'`)).id;
  for (const bad of ['[1,2]', '"text"', '{"submarines":{"alpha":{}}}']) {
    await q(`INSERT INTO game_matches (game_id, state) VALUES ($1, $2::jsonb) ON CONFLICT (game_id) DO UPDATE SET state = EXCLUDED.state`, [id, bad]);
    assert.equal(await matchStore.load('BAD001'), null, bad);
  }
  assert.equal(matchStore.isMatch({ automatedRoles: {}, systemPriority: {} }), true, 'a lobby setup is fine');
});

test('a finished game goes a day after its end, an unchanged one after a week, and the rest stay', async () => {
  const keep = { automatedRoles: {}, systemPriority: {} };
  const cases = [
    ['FIN-2D', { status: 'finished', endedDaysAgo: 2 }, 0, false],   // finished two days ago: gone
    ['FIN-1H', { status: 'finished', endedDaysAgo: 0 }, 0, true],    // just finished: kept
    ['PLAY-8', { status: 'playing' }, 8, false],                     // untouched eight days: gone
    ['PLAY-6', { status: 'playing' }, 6, true],                      // untouched six days: kept
    ['LOBBY8', { status: 'lobby' }, 8, false],                       // an old lobby setup: gone
    ['LOBBY1', { status: 'lobby' }, 1, true],
    ['FIN-OLDW', { status: 'finished', endedDaysAgo: 0 }, 9, false], // finished now but not written for nine days
  ];
  for (const [code, game, idle] of cases) {
    await makeGame(code, game);
    await matchStore.save(code, keep);
    if (idle) await age(code, idle);
  }
  const before = await stored();
  const removed = await matchStore.purge();
  const left = await stored();
  assert.equal(removed, cases.filter((c) => !c[3]).length);
  for (const [code, , , kept] of cases) assert.equal(left.includes(code), kept, code);
  assert.ok(before.length - left.length === removed);
  // the games themselves are not touched: only their stored match goes
  assert.equal((await q(`SELECT 1 FROM games WHERE code = 'FIN-2D'`)).length, 1);
});

test('deleting a game deletes its match with it', async () => {
  await makeGame('DEL001');
  await matchStore.save('DEL001', { automatedRoles: {}, systemPriority: {} });
  assert.ok((await stored()).includes('DEL001'));
  await q(`DELETE FROM games WHERE code = 'DEL001'`);
  assert.ok(!(await stored()).includes('DEL001'));
});

test('a database that fails is logged and answered, not thrown', async () => {
  const realQuery = database.query;
  const realError = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  database.query = async () => { throw new Error('connection lost'); };
  try {
    assert.equal(await matchStore.save('RT0001', {}), false);
    assert.equal(await matchStore.load('RT0001'), null);
    assert.equal(await matchStore.purge(), 0);
  } finally {
    database.query = realQuery;
    console.error = realError;
  }
  assert.equal(logged.length, 3);
});
