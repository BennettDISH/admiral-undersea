// Matches across a restart: the adapter (sockets/game.js) writes a match to the database as it
// changes, and a player who joins after a restart gets it back, with the lobby's automated
// roles. A "restart" here is a second copy of the adapter, with its own memory, over the same
// fake database. DB and JWT are mocked as in game.integration.test.js; no Postgres needed.
const test = require('node:test');
const assert = require('node:assert');
const engine = require('../game/engine');

// ---- a fake database: games, seats, and the game_matches table -----------------------------
const games = {};   // code -> games row
const seats = {};   // code -> { userId: { team, roles } }
const matches = {}; // code -> stored state, as JSON text
const dbCalls = [];
let failMatchReads = false;
let readDelay = false;

function newGame(code, row = {}) {
  games[code] = { id: Object.keys(games).length + 1, code, status: 'lobby', game_mode: 'turn-based', same_room: false, created_by: 1, ...row };
  seats[code] = { 1: { team: 'alpha', roles: 'captain' }, 2: { team: 'bravo', roles: 'captain' } };
  return code;
}
const codeOfId = (id) => Object.keys(games).find((c) => games[c].id === id);

const dbPath = require.resolve('../config/database');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    query: async (text, params) => {
      dbCalls.push({ text, params });
      if (/insert into game_matches/i.test(text)) {
        if (games[params[0]]) matches[params[0]] = params[1];
        return { rows: [] };
      }
      if (/delete from game_matches/i.test(text)) return { rows: [], rowCount: 0 };
      if (/from game_matches/i.test(text)) {
        if (readDelay) await new Promise((r) => setImmediate(r));
        if (failMatchReads) throw new Error('connection lost');
        return { rows: matches[params[0]] ? [{ state: JSON.parse(matches[params[0]]) }] : [] };
      }
      if (/update games set status = 'playing'/i.test(text)) { games[params[0]].status = 'playing'; return { rows: [] }; }
      if (/update games set status = 'finished'/i.test(text)) { games[params[1]].status = 'finished'; return { rows: [] }; }
      if (/from game_players/i.test(text)) {
        const seat = seats[codeOfId(params[0])]?.[params[1]];
        return { rows: seat ? [seat] : [] };
      }
      if (/from games/i.test(text)) return { rows: games[params[0]] ? [games[params[0]]] : [] };
      return { rows: [] };
    },
  },
};
const jwtPath = require.resolve('../config/jwt');
require.cache[jwtPath] = { id: jwtPath, filename: jwtPath, loaded: true, exports: { verifyToken: () => ({ id: 1, username: 'x' }) } };

// ---- a server boot: a fresh copy of the adapter, as a restart makes -------------------------
function boot() {
  delete require.cache[require.resolve('./game')];
  const emitted = [];
  const roomEmitter = (room) => ({ emit: (ev, payload) => emitted.push({ room, ev, payload }) });
  const io = {
    use() {},
    on(ev, fn) { if (ev === 'connection') io._conn = fn; },
    to: roomEmitter,
  };
  const server = require('./game')(io);

  // A socket for `userId` (1 is alpha, 2 is bravo), not yet in any game: it joins with join-game.
  const connect = (userId) => {
    const handlers = {};
    const socket = {
      id: `s-${userId}`, userId, username: `u${userId}`, handshake: { auth: { token: 't' } },
      join() {}, leave() {}, to: roomEmitter,
      on(ev, fn) { handlers[ev] = fn; },
      emit(ev, payload) { socket._emitted.push({ ev, payload }); },
      _emitted: [],
    };
    io._conn(socket);
    const call = (ev, payload) => handlers[ev](payload);
    return { socket, call, join: (gameCode) => call('join-game', { gameCode }) };
  };
  const stateTo = (room) => emitted.filter((e) => e.ev === 'game-state' && e.room === room).pop()?.payload;
  return { emitted, connect, stateTo, ...server };
}
const stateOf = (socket) => socket._emitted.filter((e) => e.ev === 'game-state').pop()?.payload;
const inserts = () => dbCalls.filter((c) => /insert into game_matches/i.test(c.text));
const stored = (code) => JSON.parse(matches[code]);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('a reload after a restart gets the match back instead of nothing', async () => {
  newGame('RESUME');
  const before = boot();
  const alpha = before.connect(1);
  await alpha.join('RESUME');
  await alpha.call('start-game', { gameCode: 'RESUME' });
  await alpha.call('captain-move', { gameCode: 'RESUME', direction: 'S' });
  await before.flushMatches();
  const live = before.stateTo('game:RESUME:alpha');
  assert.strictEqual(live.submarines.alpha.awaitingConfirmation, true);

  const after = boot(); // the deploy: nothing in memory
  const again = after.connect(1);
  await again.join('RESUME');
  const resumed = stateOf(again.socket);
  assert.ok(resumed, 'the player is sent the match, not left on "Loading game..."');
  assert.deepStrictEqual(resumed.submarines.alpha.position, live.submarines.alpha.position);
  assert.deepStrictEqual(resumed.submarines.alpha.path, live.submarines.alpha.path);
  assert.strictEqual(resumed.submarines.alpha.awaitingConfirmation, true);
  assert.strictEqual(resumed.submarines.bravo.position, null, 'still only what alpha may see of bravo');

  // and play goes on from there: the confirm loop finishes the move made before the restart
  for (const role of ['first-mate', 'engineer', 'radio-operator']) await again.call('aye-captain', { gameCode: 'RESUME', role });
  assert.ok(after.emitted.some((e) => e.ev === 'turn-complete' && e.room === 'game:RESUME'));
});

test('the lobby setup of automated roles survives a restart and reaches the match', async () => {
  newGame('LOBBY2');
  const before = boot();
  const alpha = before.connect(1);
  await alpha.join('LOBBY2');
  await alpha.call('set-automated-roles', { gameCode: 'LOBBY2', team: 'alpha', automatedRoles: ['engineer', 'radio-operator'] });
  await alpha.call('set-system-priority', { gameCode: 'LOBBY2', team: 'alpha', systemPriority: ['sonar', 'mine'] });
  await before.flushMatches();

  const after = boot();
  // bravo sets its own side first: that must not wipe alpha's stored setup
  const bravo = after.connect(2);
  await bravo.join('LOBBY2');
  await bravo.call('set-automated-roles', { gameCode: 'LOBBY2', team: 'bravo', automatedRoles: ['first-mate'] });
  await after.flushMatches();
  assert.deepStrictEqual(stored('LOBBY2').automatedRoles, { alpha: ['engineer', 'radio-operator'], bravo: ['first-mate'] });

  const alpha2 = after.connect(1);
  await alpha2.join('LOBBY2');
  await alpha2.call('start-game', { gameCode: 'LOBBY2' });
  const started = after.emitted.find((e) => e.ev === 'game-started' && e.room === 'game:LOBBY2:alpha').payload;
  assert.deepStrictEqual(started.automatedRoles, ['engineer', 'radio-operator']);
  assert.deepStrictEqual(started.systemPriority, ['sonar', 'mine']);
  assert.deepStrictEqual(started.submarines.alpha.automatedRoles, ['engineer', 'radio-operator']);
});

test('after a restart the automated crew finishes the turn that was waiting on it', async () => {
  newGame('AUTO01');
  const before = boot();
  const alpha = before.connect(1);
  await alpha.join('AUTO01');
  await alpha.call('set-automated-roles', { gameCode: 'AUTO01', team: 'alpha', automatedRoles: ['first-mate', 'engineer', 'radio-operator'] });
  await alpha.call('start-game', { gameCode: 'AUTO01' });
  await alpha.call('captain-move', { gameCode: 'AUTO01', direction: 'S' });
  await before.flushMatches(); // the restart comes before the automated crew has acted
  assert.strictEqual(stored('AUTO01').submarines.alpha.awaitingConfirmation, true);
  assert.deepStrictEqual(stored('AUTO01').submarines.alpha.confirmedRoles, []);

  const after = boot();
  const again = after.connect(1);
  await again.join('AUTO01');
  assert.deepStrictEqual(stateOf(again.socket).automatedRoles, ['first-mate', 'engineer', 'radio-operator']);
  await wait(900); // AUTOMATION_DELAY_MS
  assert.ok(after.emitted.some((e) => e.ev === 'turn-complete' && e.room === 'game:AUTO01'), 'the turn completes by itself');
  assert.ok(after.emitted.some((e) => e.ev === 'automation-action' && e.payload.role === 'first-mate'));
});

test('a boat that was surfaced comes back up when its time ends', async () => {
  newGame('SURF01', { status: 'playing', game_mode: 'live' });
  const state = engine.initGameState('live', false);
  engine.surface(state, 'alpha', { now: Date.now() - 60000 }); // surfaced a minute ago: up for 15s only
  matches.SURF01 = JSON.stringify(state);

  const after = boot();
  const alpha = after.connect(1);
  await alpha.join('SURF01');
  assert.strictEqual(stateOf(alpha.socket).submarines.alpha.surfaced, true);
  await wait(100);
  assert.ok(after.emitted.some((e) => e.ev === 'resurfaced' && e.room === 'game:SURF01'));
  assert.strictEqual(after.stateTo('game:SURF01:alpha').submarines.alpha.surfaced, false);
});

test('an open sonar is asked again of a returning player, and still times out', async () => {
  newGame('SONAR1', { status: 'playing' });
  const state = engine.initGameState('turn-based', false);
  state.submarines.bravo.pendingSonar = { askingTeam: 'alpha', id: 41 };
  matches.SONAR1 = JSON.stringify(state);

  const after = boot();
  const bravo = after.connect(2);
  await bravo.join('SONAR1');
  assert.deepStrictEqual(bravo.socket._emitted.find((e) => e.ev === 'sonar-request')?.payload, { askingTeam: 'alpha' });
  assert.ok(!after.emitted.some((e) => e.ev === 'sonar-answered'));
  await wait(8300); // SONAR_RESPONSE_TIMEOUT_MS: the stalled reply is made for them
  assert.ok(after.emitted.some((e) => e.ev === 'sonar-answered' && e.room === 'game:SONAR1:bravo'));
  assert.ok(after.emitted.some((e) => e.ev === 'sonar-result' && e.room === 'game:SONAR1:alpha'));
});

test('a game being played with nothing stored gets a fresh board on join, in its own mode', async () => {
  newGame('FRESH1', { status: 'playing', game_mode: 'live', same_room: true });
  const after = boot();
  const alpha = after.connect(1);
  await alpha.join('FRESH1');
  const state = stateOf(alpha.socket);
  assert.ok(state, 'not left waiting');
  assert.strictEqual(state.mode, 'live');
  assert.strictEqual(state.sameRoom, true);
  await after.flushMatches();
  assert.ok(stored('FRESH1').submarines, 'and it is stored from then on');
});

test('a lobby, or a finished game with no match, is sent nothing', async () => {
  dbCalls.length = 0;
  newGame('LOBBY3');
  newGame('GONE01', { status: 'finished' });
  const after = boot();
  const a = after.connect(1);
  await a.join('LOBBY3');
  assert.ok(!stateOf(a.socket));
  const b = after.connect(1);
  await b.join('GONE01');
  assert.ok(!stateOf(b.socket), 'a finished game is not replayed');
  assert.ok(!dbCalls.some((c) => /update games set status = 'playing'/i.test(c.text)));
});

test('a finished match is handed back as it ended, and recorded if the restart came first', async () => {
  newGame('OVER01', { status: 'playing' });
  const state = engine.initGameState('turn-based', false);
  state.gameOver = true;
  state.winner = 'bravo';
  state.submarines.alpha.health = 0;
  matches.OVER01 = JSON.stringify(state); // game-over reached memory, but the process died before it was recorded

  const after = boot();
  const alpha = after.connect(1);
  await alpha.join('OVER01');
  const got = stateOf(alpha.socket);
  assert.strictEqual(got.gameOver, true);
  assert.strictEqual(got.winner, 'bravo');
  await wait(20);
  const write = dbCalls.find((c) => /update games set status = 'finished'/i.test(c.text) && c.params[1] === 'OVER01');
  assert.ok(write, 'the result is written to the game');
  assert.strictEqual(write.params[0], 'bravo');
  await after.flushMatches();
  assert.strictEqual(stored('OVER01').persisted, true);
  assert.ok(stored('OVER01').endedAt > 0, 'the day it is kept for counts from here');
});

test('changes are written together after a moment, and once per game', async () => {
  newGame('BATCH1');
  const server = boot();
  const alpha = server.connect(1);
  await alpha.join('BATCH1');
  dbCalls.length = 0;
  await alpha.call('start-game', { gameCode: 'BATCH1' });
  await alpha.call('captain-move', { gameCode: 'BATCH1', direction: 'S' });
  for (const role of ['first-mate', 'engineer', 'radio-operator']) await alpha.call('aye-captain', { gameCode: 'BATCH1', role });
  assert.strictEqual(inserts().length, 0, 'nothing is written per event');
  await server.flushMatches();
  assert.strictEqual(inserts().length, 1);
  assert.strictEqual(inserts()[0].params[0], 'BATCH1');
  assert.deepStrictEqual(stored('BATCH1').submarines.alpha.path, [{ x: 1, y: 1 }]);
  await server.flushMatches();
  assert.strictEqual(inserts().length, 1, 'and nothing again when nothing changed');
});

test('sockets joining together after a restart read the stored match once', async () => {
  newGame('RUSH01', { status: 'playing' });
  const state = engine.initGameState('turn-based', false);
  state.submarines.alpha.health = 3;
  matches.RUSH01 = JSON.stringify(state);

  const after = boot();
  const one = after.connect(1);
  const two = after.connect(1);
  dbCalls.length = 0;
  readDelay = true;
  await Promise.all([one.join('RUSH01'), two.join('RUSH01')]);
  readDelay = false;
  assert.strictEqual(dbCalls.filter((c) => /from game_matches/i.test(c.text)).length, 1);
  assert.strictEqual(stateOf(one.socket).submarines.alpha.health, 3);
  assert.strictEqual(stateOf(two.socket).submarines.alpha.health, 3);
});

test('a database that cannot be read does not leave the player waiting', async () => {
  newGame('DOWN01', { status: 'playing' });
  matches.DOWN01 = JSON.stringify(engine.initGameState('turn-based', false));
  const after = boot();
  const alpha = after.connect(1);
  failMatchReads = true;
  const realError = console.error;
  console.error = () => {};
  try { await alpha.join('DOWN01'); } finally { failMatchReads = false; console.error = realError; }
  assert.ok(stateOf(alpha.socket), 'a fresh board stands in');
});

test('sweeping lets go of a finished match after a day and an untouched one after a week', async () => {
  const day = 24 * 60 * 60 * 1000;
  const fixtures = {
    SWEEP1: { gameOver: true, endedAt: Date.now() - 2 * day, touchedAt: Date.now() - 2 * day, persisted: true, winner: 'alpha' },
    SWEEP2: { gameOver: true, endedAt: Date.now() - 3600000, touchedAt: Date.now() - 3600000, persisted: true, winner: 'alpha' },
    SWEEP3: { touchedAt: Date.now() - 8 * day },
    SWEEP4: { touchedAt: Date.now() - 6 * day },
  };
  for (const [code, patch] of Object.entries(fixtures)) {
    newGame(code, { status: 'playing' });
    matches[code] = JSON.stringify({ ...engine.initGameState('turn-based', false), ...patch });
  }
  const server = boot();
  for (const code of Object.keys(fixtures)) await server.connect(1).join(code);

  dbCalls.length = 0;
  assert.strictEqual(await server.sweepMatches(), 2, 'the finished-two-days-ago and the week-old ones');
  assert.ok(dbCalls.some((c) => /delete from game_matches/i.test(c.text)), 'and the database is swept too');
  assert.strictEqual(await server.sweepMatches(), 0, 'nothing more to let go of');
  assert.strictEqual(await server.sweepMatches(Date.now() + 2 * day), 2, 'two days on, the hour-old finished match and the six-day-old one');
});

test('a setup change that lands while the stored match is still being read is added to it', async () => {
  newGame('RACE01');
  matches.RACE01 = JSON.stringify({ automatedRoles: { alpha: ['engineer'] }, systemPriority: { alpha: ['mine'] } });

  const after = boot();
  const bravo = after.connect(2);
  readDelay = true;
  const joining = bravo.join('RACE01');
  while (!bravo.socket.team) await new Promise((r) => setImmediate(r)); // seated, the stored setup not yet back
  await bravo.call('set-automated-roles', { gameCode: 'RACE01', team: 'bravo', automatedRoles: ['first-mate'] });
  await joining;
  readDelay = false;
  await after.flushMatches();
  assert.deepStrictEqual(stored('RACE01').automatedRoles, { alpha: ['engineer'], bravo: ['first-mate'] });
  assert.deepStrictEqual(stored('RACE01').systemPriority, { alpha: ['mine'] });
});
