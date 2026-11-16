// Matches across a restart: the adapter (sockets/game.js) writes a running match to the database,
// and a player who joins after a restart gets it back and play carries on. A "restart" empties the
// adapter's memory over the same fake database. No Postgres needed; the clock is run by hand.
const test = require('node:test');
const assert = require('node:assert');

const games = {};
const seats = {};
const matches = {};
const results = []; // [code, winner] each time a result is written
const failSaves = new Set(); // codes whose match writes fail (the database is away for them)
const saveTries = {}; // code -> match writes tried

function newGame(code, row = {}, seatList = { 1: { team: 'alpha', roles: 'helm,listener,weapons,chief' } }) {
  games[code] = { id: Object.keys(games).length + 1, code, status: 'lobby', game_mode: 'vs-ai', same_room: false, created_by: 1, ...row };
  seats[code] = seatList;
  return code;
}
const codeOfId = (id) => Object.keys(games).find((c) => games[c].id === id);

const dbPath = require.resolve('../config/database');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    query: async (text, params) => {
      if (/insert into game_matches/i.test(text)) {
        saveTries[params[0]] = (saveTries[params[0]] || 0) + 1;
        if (failSaves.has(params[0])) throw new Error('Connection terminated unexpectedly');
        matches[params[0]] = params[1];
        return { rows: [] };
      }
      if (/delete from game_matches/i.test(text)) return { rows: [], rowCount: 0 };
      if (/from game_matches/i.test(text)) return { rows: matches[params[0]] ? [{ state: JSON.parse(matches[params[0]]) }] : [] };
      if (/update games set status = 'playing'/i.test(text)) {
        const g = games[params[0]];
        if (!g || g.status !== 'lobby') return { rows: [], rowCount: 0 };
        g.status = 'playing';
        return { rows: [{ id: g.id }], rowCount: 1 };
      }
      if (/update games set status = 'finished'/i.test(text)) {
        const g = games[params[1]];
        if (g?.status === 'playing') { g.status = 'finished'; results.push([params[1], params[0]]); return { rows: [], rowCount: 1 }; }
        return { rows: [], rowCount: 0 };
      }
      if (/from game_players/i.test(text)) {
        const table = seats[codeOfId(params[0])] || {};
        if (params.length === 1) return { rows: Object.entries(table).map(([id, s]) => ({ user_id: Number(id), ...s })) };
        return { rows: table[params[1]] ? [table[params[1]]] : [] };
      }
      if (/from games/i.test(text)) return { rows: games[params[0]] ? [games[params[0]]] : [] };
      return { rows: [] };
    },
  },
};

const emitted = [];
const roomEmitter = (room) => ({ emit: (ev, payload) => emitted.push({ room, ev, payload }) });
const io = { use() {}, on(ev, fn) { if (ev === 'connection') io._conn = fn; }, to: roomEmitter };
const server = require('./game')(io, { clock: false });
const engine = require('../game/engine');

let n = 0;
function connect(userId) {
  const handlers = {};
  const socket = {
    id: `p-${userId}-${++n}`, userId, username: `u${userId}`, join() {}, leave() {}, to: roomEmitter,
    on(ev, fn) { handlers[ev] = fn; }, emit(ev, payload) { socket._emitted.push({ ev, payload }); }, _emitted: [],
  };
  io._conn(socket);
  return { socket, call: (ev, payload) => handlers[ev](payload), drop: () => handlers.disconnect() };
}
async function join(code, userId = 1) {
  const p = connect(userId);
  await p.call('join-game', { gameCode: code });
  return p;
}
const viewOf = (p) => p.socket._emitted.filter((e) => e.ev === 'game-state').pop()?.payload;
const restart = () => server._states.clear();
// Let the fake database's answers and the writes after them land.
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

test('a running match is written to the database and comes back after a restart, where play carries on', async () => {
  const code = newGame('KEEP01');
  const me = await join(code);
  await me.call('start-game', { gameCode: code });
  await me.call('power', { gameCode: code, power: { engines: 3, sonar: 2, tubes: 1 } });
  await me.call('helm', { gameCode: code, speed: 3 });
  for (let i = 0; i < 40; i++) server._tickAll();
  await server.flushMatches();
  const stored = JSON.parse(matches[code]);
  assert.equal(stored.v, 2);
  const at = { x: stored.subs.alpha.x, y: stored.subs.alpha.y, t: stored.t };

  restart();
  const back = await join(code);
  const view = viewOf(back);
  assert.deepEqual({ x: view.boat.x, y: view.boat.y }, { x: at.x, y: at.y });
  assert.ok(Array.isArray(view.contacts), 'the plot comes back too');
  server._tickAll();
  assert.ok(server._states.get(code).t > at.t, 'and the clock runs again');
  me.drop();
  back.drop();
});

test('a row from the old rules is not a match: a game being played starts afresh, a lobby gets nothing', async () => {
  const playing = newGame('OLD001', { status: 'playing' });
  matches[playing] = JSON.stringify({ submarines: { alpha: { position: { x: 1, y: 1 } }, bravo: {} }, mode: 'turn-based' });
  const p = await join(playing);
  const view = viewOf(p);
  assert.equal(view.v, 2);
  assert.equal(view.boat.hull, 5);
  p.drop();

  const lobby = newGame('OLD002');
  matches[lobby] = JSON.stringify({ automatedRoles: { alpha: ['engineer'] }, systemPriority: {} });
  const q = await join(lobby);
  assert.equal(viewOf(q), undefined);
  q.drop();
});

test('a finished game is never replayed, and its result is written once', async () => {
  const code = newGame('DONE01');
  const me = await join(code);
  await me.call('start-game', { gameCode: code });
  const s = server._states.get(code);
  s.subs.bravo.hull = 0; // sunk by hand
  server._tickAll();
  server._tickAll();
  await server.flushMatches();
  assert.deepEqual(results.filter((r) => r[0] === code), [[code, 'alpha']]);
  assert.ok(emitted.some((e) => e.room === `game:${code}` && e.ev === 'game-over' && e.payload.winner === 'alpha'));
  const t = s.t;
  server._tickAll();
  assert.equal(s.t, t, 'the clock stopped');

  // gone from memory and the database: a finished game is not started again
  restart();
  delete matches[code];
  const late = await join(code);
  assert.equal(viewOf(late), undefined);
  assert.equal(games[code].status, 'finished');
  me.drop();
  late.drop();
});

test('a finished match leaves memory a day after its end', async () => {
  const code = newGame('SWEEP1');
  const me = await join(code);
  await me.call('start-game', { gameCode: code });
  const s = server._states.get(code);
  s.subs.bravo.hull = 0;
  server._tickAll();
  await server.flushMatches();
  assert.equal(await server.sweepMatches(Date.now()), 0);
  assert.ok((await server.sweepMatches(Date.now() + 25 * 60 * 60 * 1000)) >= 1);
  assert.equal(server._states.has(code), false);
  me.drop();
});

// ---- a write that fails --------------------------------------------------------------------------
// The clock is real until each test has written what earlier ones left waiting; then it is mocked.
async function finishedWhileAway(t, code) {
  await server.flushMatches();
  t.mock.method(console, 'error', () => {});
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  newGame(code);
  const me = await join(code);
  await me.call('start-game', { gameCode: code });
  failSaves.add(code);
  server._states.get(code).subs.bravo.hull = 0; // sunk by hand: the clock stops, nothing re-saves it
  server._tickAll();
  await settle();
  assert.equal(saveTries[code], 1, 'the game-over write was tried');
  assert.equal(matches[code], undefined, 'and failed');
  return me;
}

test('a finished match whose write fails is tried again after 2s, then 4s, until it lands', async (t) => {
  const code = 'RETRY1';
  const me = await finishedWhileAway(t, code);

  t.mock.timers.tick(1500);
  await settle();
  assert.equal(saveTries[code], 1, 'not before its wait');
  t.mock.timers.tick(500);
  await settle();
  assert.equal(saveTries[code], 2, 'tried again after 2s');
  assert.equal(matches[code], undefined);

  failSaves.delete(code); // the database is back
  t.mock.timers.tick(3000);
  await settle();
  assert.equal(saveTries[code], 2, 'the second wait is longer');
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(saveTries[code], 3);
  const stored = JSON.parse(matches[code]);
  assert.equal(stored.over.winner, 'alpha', 'the last state is kept');

  t.mock.timers.tick(10 * 60 * 1000);
  await settle();
  assert.equal(saveTries[code], 3, 'once it lands it is not written again');
  await server.flushMatches();
  me.drop();
});

test('a match whose writes keep failing waits at most a minute between tries, and stops once it is let go of', async (t) => {
  const code = 'RETRY2';
  const me = await finishedWhileAway(t, code);
  for (let i = 0; i < 8; i++) { t.mock.timers.tick(60 * 1000); await settle(); }
  const tries = saveTries[code];
  assert.equal(tries, 9, 'one try for each wait');
  t.mock.timers.tick(59 * 1000);
  await settle();
  assert.equal(saveTries[code], tries, 'the wait has grown to a minute');
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(saveTries[code], tries + 1, 'and grows no more');

  const before = saveTries[code];
  await server.sweepMatches(Date.now() + 25 * 60 * 60 * 1000);
  assert.equal(server._states.has(code), false);
  for (let i = 0; i < 5; i++) { t.mock.timers.tick(60 * 1000); await settle(); }
  assert.equal(saveTries[code], before, 'a swept match is not retried');
  failSaves.delete(code);
  await server.flushMatches();
  me.drop();
});

test('a direct write (a shutdown) tries a failed match at once, whatever its wait', async (t) => {
  const code = 'RETRY3';
  const me = await finishedWhileAway(t, code);
  failSaves.delete(code);
  await server.flushMatches();
  assert.equal(saveTries[code], 2);
  assert.equal(JSON.parse(matches[code]).over.winner, 'alpha');
  me.drop();
});

test('a running match whose write failed is written at the usual pace once it changes, not after the wait', async (t) => {
  await server.flushMatches();
  t.mock.method(console, 'error', () => {});
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const code = newGame('RETRY4');
  const me = await join(code);
  await me.call('start-game', { gameCode: code });
  failSaves.add(code);
  await server.flushMatches();
  t.mock.timers.tick(2000);
  await settle();
  assert.equal(saveTries[code], 2, 'failed twice: the next wait is 4s');

  failSaves.delete(code);
  server._tickAll(); // the clock moves the boat: a change
  t.mock.timers.tick(750);
  await settle();
  assert.equal(saveTries[code], 3, 'written 750ms after the change');
  assert.ok(matches[code]);
  await server.flushMatches();
  me.drop();
});

// ---- a tick that throws --------------------------------------------------------------------------
test('a tick that keeps throwing stops the clock, saves the match and tells the room; a seated rejoin starts it again', async (t) => {
  t.mock.method(console, 'error', () => {});
  const code = newGame('STALL1');
  const me = await join(code);
  await me.call('start-game', { gameCode: code });
  server._tickAll();
  const s = server._states.get(code);
  const stallsOf = () => emitted.filter((e) => e.ev === 'match-error' && e.room.startsWith(`game:${code}`));
  const before = stallsOf().length;

  const broken = t.mock.method(engine, 'tick', () => { throw new Error('engine fault: hull NaN at secret-detail'); });
  server._tickAll();
  server._tickAll();
  assert.equal(stallsOf().length, before, 'a couple of bad ticks are tried again');
  server._tickAll();
  const stalls = stallsOf().slice(before);
  assert.equal(stalls.length, 1);
  assert.equal(stalls[0].room, `game:${code}`, 'to the whole room, both crews');
  assert.equal(stalls[0].payload.message, 'The boat stalled: rejoin to carry on.');
  assert.equal(stalls[0].payload.t, s.t);
  assert.ok(!JSON.stringify(stalls[0].payload).includes('secret-detail'), 'the error itself stays in the log');
  await server.flushMatches();
  assert.equal(JSON.parse(matches[code]).t, s.t, 'what it had is saved');

  broken.mock.restore();
  const t0 = s.t;
  server._tickAll();
  assert.equal(s.t, t0, 'the clock stopped');
  assert.equal(stallsOf().length, before + 1, 'and the room hears it once');

  // someone with no seat on the boat cannot start it
  const outsider = await join(code, 2);
  server._tickAll();
  assert.equal(s.t, t0);

  // a seated player's rejoin does, with a full view
  await me.call('join-game', { gameCode: code });
  assert.ok(Array.isArray(viewOf(me).contacts));
  server._tickAll();
  assert.ok(s.t > t0, 'the clock runs again');
  outsider.drop();
  me.drop();
});

test('a broken match logs its error once a minute, however often it is rejoined', async (t) => {
  const log = t.mock.method(console, 'error', () => {});
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const code = newGame('STALL3');
  const me = await join(code);
  await me.call('start-game', { gameCode: code });
  t.mock.method(engine, 'tick', () => { throw new Error('broken'); });
  const logs = () => log.mock.calls.filter((c) => c.arguments[0] === `tick error in ${code}:`).length;
  const stalls = () => emitted.filter((e) => e.ev === 'match-error' && e.room === `game:${code}`).length;
  for (let i = 0; i < 5; i++) {
    for (let k = 0; k < 3; k++) server._tickAll();
    await me.call('join-game', { gameCode: code });
  }
  assert.equal(stalls(), 5, 'each rejoin runs it, and it stalls again');
  assert.equal(logs(), 1, 'one log line, not three a rejoin');
  t.mock.timers.tick(60 * 1000);
  for (let k = 0; k < 3; k++) server._tickAll();
  assert.equal(logs(), 2, 'a minute on, it is logged again');
  await server.flushMatches();
  me.drop();
});

test('a tick that throws now and then never stalls the match, and is not logged every tick', async (t) => {
  const log = t.mock.method(console, 'error', () => {});
  const code = newGame('STALL2');
  const me = await join(code);
  await me.call('start-game', { gameCode: code });
  const s = server._states.get(code);
  const real = engine.tick;
  let n = 0;
  t.mock.method(engine, 'tick', (...args) => {
    n += 1;
    if (n % 3) throw new Error('flaky');
    return real(...args);
  });
  for (let i = 0; i < 30; i++) server._tickAll();
  assert.ok(!emitted.some((e) => e.ev === 'match-error' && e.room === `game:${code}`));
  assert.ok(s.t > 0, 'the good ticks still run');
  assert.equal(log.mock.calls.filter((c) => c.arguments[0] === `tick error in ${code}:`).length, 1);
  me.drop();
});
