// The per-socket event cap (sockets/rateLimit.js): the bucket itself, and that the socket
// handlers drop a flood instead of running it. DB and JWT are mocked as in
// game.integration.test.js; no Postgres needed.
const test = require('node:test');
const assert = require('node:assert');

const dbCalls = [];
const dbPath = require.resolve('../config/database');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    query: async (text, params) => {
      dbCalls.push({ text, params });
      if (/from games/i.test(text)) return { rows: [{ id: 1, status: 'lobby', created_by: 1 }] };
      return { rows: [] };
    },
  },
};
const jwtPath = require.resolve('../config/jwt');
require.cache[jwtPath] = { id: jwtPath, filename: jwtPath, loaded: true, exports: { verifyToken: () => ({ id: 1, username: 'x' }) } };

const { tokenBucket, SOCKET_BURST, SOCKET_PER_SECOND } = require('./rateLimit');
const setupGameSockets = require('./game');

test('a bucket allows a burst, then refills over time', () => {
  const take = tokenBucket({ burst: 3, perSecond: 2, now: 0 });
  assert.deepStrictEqual([take(0), take(0), take(0), take(0)], [true, true, true, false]);
  assert.strictEqual(take(250), false, 'half a token back is not enough');
  assert.strictEqual(take(500), true, 'one token back after half a second');
  assert.strictEqual(take(500), false);
  assert.deepStrictEqual([take(60_000), take(60_000), take(60_000), take(60_000)], [true, true, true, false], 'never more than the burst');
});

test('the cap sits well above click-paced play', () => {
  assert.ok(SOCKET_BURST >= 10 && SOCKET_PER_SECOND >= 5);
});

function connect() {
  const emitted = [];
  const io = {
    use() {},
    on(ev, fn) { if (ev === 'connection') io._conn = fn; },
    to(room) { return { emit: (ev, payload) => emitted.push({ room, ev, payload }) }; },
  };
  setupGameSockets(io);
  const handlers = {};
  const socket = {
    id: 's1', userId: 1, username: 'x', handshake: { auth: { token: 't' } },
    join() {}, leave() {}, to: io.to,
    on(ev, fn) { handlers[ev] = fn; },
    emit() {},
  };
  io._conn(socket);
  socket.gameCode = 'G1';
  socket.team = 'alpha';
  return { socket, handlers, emitted };
}

test('a socket looping an emit gets its burst, and the rest are dropped', async () => {
  const { handlers, emitted } = connect();
  dbCalls.length = 0;
  const sends = [];
  for (let i = 0; i < 200; i++) sends.push(handlers['select-roles']({ gameCode: 'G1', roles: ['captain'] }));
  await Promise.all(sends);
  const writes = dbCalls.filter((c) => /update game_players/i.test(c.text)).length;
  assert.ok(writes <= SOCKET_BURST + 1, `expected at most ${SOCKET_BURST + 1} writes, got ${writes}`);
  assert.ok(writes >= SOCKET_BURST - 1, 'the burst itself still goes through');
  assert.strictEqual(emitted.filter((e) => e.ev === 'roles-updated').length, writes);
});

test('each socket has its own allowance', async () => {
  const a = connect();
  const b = connect();
  const flood = [];
  for (let i = 0; i < 100; i++) flood.push(a.handlers['select-roles']({ gameCode: 'G1', roles: ['captain'] }));
  await Promise.all(flood);
  dbCalls.length = 0;
  await b.handlers['select-roles']({ gameCode: 'G1', roles: ['captain'] });
  assert.strictEqual(dbCalls.filter((c) => /update game_players/i.test(c.text)).length, 1);
});
