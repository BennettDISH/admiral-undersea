// Matches across a restart: the adapter (sockets/game.js) writes a running match to the database,
// and a player who joins after a restart gets it back and play carries on. A "restart" empties the
// adapter's memory over the same fake database. No Postgres needed; the clock is run by hand.
const test = require('node:test');
const assert = require('node:assert');

const games = {};
const seats = {};
const matches = {};
const results = []; // [code, winner] each time a result is written

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
      if (/insert into game_matches/i.test(text)) { matches[params[0]] = params[1]; return { rows: [] }; }
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
