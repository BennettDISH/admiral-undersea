// Adapter-seam test: drives the real socket handlers through a fake io/socket, mocking
// only the DB + JWT modules. Verifies engine wiring, event routing, rejection, and the
// confirm loop -- the layer the pure-engine tests don't cover. No Postgres required.
const test = require('node:test');
const assert = require('node:assert');

// Inject module mocks BEFORE requiring the adapter (same absolute paths it resolves).
let gameStatus = 'lobby'; // flip to exercise the mid-game team-switch guard
const dbPath = require.resolve('../config/database');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    query: async (text) => {
      if (/from games/i.test(text) && /status/i.test(text)) return { rows: [{ id: 1, status: gameStatus }] };
      if (/from games/i.test(text)) return { rows: [{ id: 1 }] };
      return { rows: [] };
    },
  },
};
const jwtPath = require.resolve('../config/jwt');
require.cache[jwtPath] = { id: jwtPath, filename: jwtPath, loaded: true, exports: { verifyToken: () => ({ id: 1, username: 'x' }) } };

const setupGameSockets = require('./game');

// Fake io that records every room emit.
function harness() {
  const emitted = [];
  const roomEmitter = (room) => ({ emit: (ev, payload) => emitted.push({ room, ev, payload }) });
  const io = {
    use() {},
    on(ev, fn) { if (ev === 'connection') io._conn = fn; },
    to(room) { return roomEmitter(room); },
  };
  setupGameSockets(io);

  const connect = (team) => {
    const handlers = {};
    const socket = {
      id: `s-${team}`, userId: team === 'alpha' ? 1 : 2, username: team,
      handshake: { auth: { token: 't' } },
      join() {}, leave() {}, to: roomEmitter,
      on(ev, fn) { handlers[ev] = fn; },
      emit(ev, payload) { socket._emitted.push({ ev, payload }); },
      _emitted: [], _handlers: handlers,
    };
    io._conn(socket);
    socket.team = team; // bypass the DB-driven team assignment
    return socket;
  };

  return { emitted, connect };
}

const hasRoom = (emitted, ev, room) => emitted.some((e) => e.ev === ev && (!room || e.room === room));

test('adapter rejects an illegal move to the acting socket', async () => {
  const { connect } = harness();
  const alpha = connect('alpha');
  await alpha._handlers['captain-move']({ gameCode: 'G1', direction: 'E' }); // (1,1)->island
  const rej = alpha._emitted.find((e) => e.ev === 'action-rejected');
  assert.ok(rej, 'expected action-rejected');
  assert.strictEqual(rej.payload.reason, 'island');
});

test('adapter routes a legal move to room + game-state to both teams', async () => {
  const { emitted, connect } = harness();
  const alpha = connect('alpha');
  await alpha._handlers['captain-move']({ gameCode: 'G2', direction: 'S' });
  assert.ok(hasRoom(emitted, 'move-announced', 'game:G2'));
  assert.ok(hasRoom(emitted, 'game-state', 'game:G2:alpha'));
  assert.ok(hasRoom(emitted, 'game-state', 'game:G2:bravo'));
  // enemy radio sound targeted at bravo's room
  assert.ok(emitted.some((e) => e.ev === 'play-move-sound' && e.room === 'game:G2:bravo'));
});

test('adapter confirm loop completes the turn once required roles ack', async () => {
  const { emitted, connect } = harness();
  const alpha = connect('alpha');
  await alpha._handlers['captain-move']({ gameCode: 'G3', direction: 'S' });
  await alpha._handlers['aye-captain']({ gameCode: 'G3', role: 'first-mate' });
  await alpha._handlers['aye-captain']({ gameCode: 'G3', role: 'engineer' });
  assert.ok(!hasRoom(emitted, 'turn-complete'), 'not complete before radio acks');
  await alpha._handlers['aye-captain']({ gameCode: 'G3', role: 'radio-operator' });
  assert.ok(hasRoom(emitted, 'turn-complete', 'game:G3'));
});

test('select-team is refused once the game has started (blocks enemy-room join / info leak)', async () => {
  gameStatus = 'playing';
  const { connect } = harness();
  const attacker = connect('alpha');       // already on alpha
  await attacker._handlers['select-team']({ gameCode: 'G8', team: 'bravo' });
  const rej = attacker._emitted.find((e) => e.ev === 'action-rejected');
  assert.ok(rej && rej.payload.reason === 'game-started', 'expected select-team rejection mid-game');
  assert.strictEqual(attacker.team, 'alpha', 'attacker must not switch onto the enemy team');
  gameStatus = 'lobby';
});

test('adapter marks damage using the server-tracked move direction', async () => {
  const { emitted, connect } = harness();
  const alpha = connect('alpha');
  await alpha._handlers['captain-move']({ gameCode: 'G4', direction: 'S' }); // lastMoveDir = S
  emitted.length = 0;
  // s1 is a valid slot in the S section; client only sends slotId now.
  await alpha._handlers['mark-damage']({ gameCode: 'G4', slotId: 's1' });
  const dm = emitted.find((e) => e.ev === 'damage-marked');
  assert.ok(dm, 'expected damage-marked');
  assert.strictEqual(dm.payload.direction, 'S');
  assert.ok(dm.payload.finalDamagedSlots.includes('s1'));
});
