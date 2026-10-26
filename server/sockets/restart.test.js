// A captain's move for a game the server holds no match for (it restarted, or the game never
// started): only a game the database says is being played gets a board, in its own mode.
// The DB is mocked as in game.integration.test.js; no Postgres needed.
const test = require('node:test');
const assert = require('node:assert');

let gameRow = null; // what the games table holds for the code under test
const dbCalls = [];
const dbPath = require.resolve('../config/database');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    query: async (text, params) => {
      dbCalls.push({ text, params });
      if (/from games/i.test(text)) return { rows: gameRow ? [{ id: 1, created_by: 1, ...gameRow }] : [] };
      return { rows: [] };
    },
  },
};

const setupGameSockets = require('./game');

const emitted = [];
const io = {
  use() {},
  on(ev, fn) { if (ev === 'connection') io._conn = fn; },
  to(room) { return { emit: (ev, payload) => emitted.push({ room, ev, payload }) }; },
};
setupGameSockets(io);

// A captain seated on alpha in `gameCode`, as join-game would leave the socket.
function captain(gameCode) {
  const handlers = {};
  const socket = {
    id: `s-${gameCode}`, userId: 1, username: 'cap', handshake: { auth: { token: 't' } },
    join() {}, leave() {}, to: io.to,
    on(ev, fn) { handlers[ev] = fn; },
    emit(ev, payload) { socket._emitted.push({ ev, payload }); },
    _emitted: [],
  };
  io._conn(socket);
  socket.gameCode = gameCode;
  socket.team = 'alpha';
  return { socket, move: (direction) => handlers['captain-move']({ gameCode, direction }) };
}

const moved = (code) => emitted.some((e) => e.ev === 'move-announced' && e.room === `game:${code}`);

test('a finished game is not replayed', async () => {
  gameRow = { status: 'finished', game_mode: 'turn-based', same_room: false, winner_team: 'bravo' };
  const { socket, move } = captain('DONE01');
  await move('S');
  assert.ok(!moved('DONE01'), 'no new match for a finished game');
  assert.strictEqual(socket._emitted.find((e) => e.ev === 'action-rejected')?.payload.reason, 'not-playing');
  assert.ok(!dbCalls.some((c) => /update games/i.test(c.text)), 'its stored result is untouched');
});

test('a game still in its lobby is not played before it starts', async () => {
  gameRow = { status: 'lobby', game_mode: 'turn-based', same_room: false };
  const { socket, move } = captain('LOBBY1');
  await move('S');
  assert.ok(!moved('LOBBY1'));
  assert.strictEqual(socket._emitted.find((e) => e.ev === 'action-rejected')?.payload.reason, 'not-playing');
});

test('an unknown game is not played', async () => {
  gameRow = null;
  const { move } = captain('NOPE01');
  await move('S');
  assert.ok(!moved('NOPE01'));
});

test('a live game being played comes back live, with its room setting', async () => {
  gameRow = { status: 'playing', game_mode: 'live', same_room: true };
  const { move } = captain('LIVE01');
  await move('S');
  assert.ok(moved('LIVE01'));
  const state = emitted.filter((e) => e.ev === 'game-state' && e.room === 'game:LIVE01:alpha').pop().payload;
  assert.strictEqual(state.mode, 'live');
  assert.strictEqual(state.sameRoom, true);
});

test('a turn-based game being played comes back turn-based', async () => {
  gameRow = { status: 'playing', game_mode: 'turn-based', same_room: false };
  const { move } = captain('TURN01');
  await move('S');
  const state = emitted.filter((e) => e.ev === 'game-state' && e.room === 'game:TURN01:alpha').pop().payload;
  assert.strictEqual(state.mode, 'turn-based');
});

test('once a match is in memory, moves need no database lookup', async () => {
  gameRow = { status: 'playing', game_mode: 'turn-based', same_room: false };
  const { move } = captain('HOT001');
  await move('S');
  dbCalls.length = 0;
  gameRow = null; // even if the row went away, the match in memory plays on
  await move('W'); // turn-based: refused as awaiting-confirmation, but by the engine
  assert.strictEqual(dbCalls.length, 0);
});
