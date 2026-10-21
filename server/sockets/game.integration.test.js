// Adapter-seam test: drives the real socket handlers through a fake io/socket, mocking
// only the DB + JWT modules. Verifies engine wiring, event routing, rejection, and the
// confirm loop -- the layer the pure-engine tests don't cover. No Postgres required.
const test = require('node:test');
const assert = require('node:assert');

// Inject module mocks BEFORE requiring the adapter (same absolute paths it resolves).
let gameStatus = 'lobby'; // flip to exercise the mid-game team-switch guard
const dbCalls = []; // every query, for the tests that check what was written
const dbPath = require.resolve('../config/database');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    query: async (text, params) => {
      dbCalls.push({ text, params });
      if (/from games/i.test(text) && /status/i.test(text)) return { rows: [{ id: 1, status: gameStatus, created_by: 1 }] }; // user 1 (alpha) made it
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

  // `gameCode` is the game this socket joined; its team only counts there.
  const connect = (team, gameCode) => {
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
    socket.gameCode = gameCode;
    return socket;
  };

  return { emitted, connect };
}

const hasRoom = (emitted, ev, room) => emitted.some((e) => e.ev === ev && (!room || e.room === room));

test('adapter rejects an illegal move to the acting socket', async () => {
  const { connect } = harness();
  const alpha = connect('alpha', 'G1');
  await alpha._handlers['start-game']({ gameCode: 'G1' }); // alpha (user 1) made the game
  await alpha._handlers['captain-move']({ gameCode: 'G1', direction: 'E' }); // (1,1)->island
  const rej = alpha._emitted.find((e) => e.ev === 'action-rejected');
  assert.ok(rej, 'expected action-rejected');
  assert.strictEqual(rej.payload.reason, 'island');
});

test('adapter routes a legal move to room + game-state to both teams', async () => {
  const { emitted, connect } = harness();
  const alpha = connect('alpha', 'G2');
  await alpha._handlers['start-game']({ gameCode: 'G2' });
  await alpha._handlers['captain-move']({ gameCode: 'G2', direction: 'S' });
  assert.ok(hasRoom(emitted, 'move-announced', 'game:G2'));
  assert.ok(hasRoom(emitted, 'game-state', 'game:G2:alpha'));
  assert.ok(hasRoom(emitted, 'game-state', 'game:G2:bravo'));
  // enemy radio sound targeted at bravo's room
  assert.ok(emitted.some((e) => e.ev === 'play-move-sound' && e.room === 'game:G2:bravo'));
});

test('adapter confirm loop completes the turn once required roles ack', async () => {
  const { emitted, connect } = harness();
  const alpha = connect('alpha', 'G3');
  await alpha._handlers['start-game']({ gameCode: 'G3' });
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
  const attacker = connect('alpha', 'G8');       // already on alpha
  await attacker._handlers['select-team']({ gameCode: 'G8', team: 'bravo' });
  const rej = attacker._emitted.find((e) => e.ev === 'action-rejected');
  assert.ok(rej && rej.payload.reason === 'game-started', 'expected select-team rejection mid-game');
  assert.strictEqual(attacker.team, 'alpha', 'attacker must not switch onto the enemy team');
  gameStatus = 'lobby';
});

test('adapter marks damage using the server-tracked move direction', async () => {
  const { emitted, connect } = harness();
  const alpha = connect('alpha', 'G4');
  await alpha._handlers['start-game']({ gameCode: 'G4' });
  await alpha._handlers['captain-move']({ gameCode: 'G4', direction: 'S' }); // lastMoveDir = S
  emitted.length = 0;
  // s1 is a valid slot in the S section; client only sends slotId now.
  await alpha._handlers['mark-damage']({ gameCode: 'G4', slotId: 's1' });
  const dm = emitted.find((e) => e.ev === 'damage-marked');
  assert.ok(dm, 'expected damage-marked');
  assert.strictEqual(dm.payload.direction, 'S');
  assert.ok(dm.payload.finalDamagedSlots.includes('s1'));
});

test('an action naming a game the socket did not join is ignored', async () => {
  const { emitted, connect } = harness();
  const alpha = connect('alpha', 'G9'); // seated on alpha in G9 only
  await alpha._handlers['start-game']({ gameCode: 'G9' });
  await alpha._handlers['captain-move']({ gameCode: 'OTHER', direction: 'S' });
  assert.ok(!hasRoom(emitted, 'move-announced', 'game:OTHER'), 'must not steer a sub in another game');
  assert.strictEqual(alpha._emitted.length, 0);
  await alpha._handlers['captain-move']({ gameCode: 'G9', direction: 'S' });
  assert.ok(hasRoom(emitted, 'move-announced', 'game:G9'), 'still plays its own game');
});

test('joining another game drops the team held in the last one', async () => {
  const { emitted, connect } = harness();
  const alpha = connect('alpha', 'G10');
  await alpha._handlers['join-game']({ gameCode: 'G11' }); // not seated in G11 (no game_players row)
  assert.strictEqual(alpha.team, null);
  await alpha._handlers['captain-move']({ gameCode: 'G11', direction: 'S' });
  await alpha._handlers['captain-move']({ gameCode: 'G10', direction: 'S' });
  assert.ok(!emitted.some((e) => e.ev === 'move-announced'), 'no team, no moves');
});

test('only the creator starts a game, and only from the lobby', async () => {
  const { emitted, connect } = harness();
  const bravo = connect('bravo', 'G12'); // user 2, not the creator
  await bravo._handlers['start-game']({ gameCode: 'G12' });
  assert.strictEqual(bravo._emitted.find((e) => e.ev === 'action-rejected')?.payload.reason, 'not-creator');
  assert.ok(!hasRoom(emitted, 'game-started'));

  const alpha = connect('alpha', 'G12'); // user 1, the creator
  await alpha._handlers['start-game']({ gameCode: 'G12' });
  assert.ok(hasRoom(emitted, 'game-started', 'game:G12:alpha'));

  gameStatus = 'playing';
  emitted.length = 0;
  await alpha._handlers['start-game']({ gameCode: 'G12' });
  assert.strictEqual(alpha._emitted.find((e) => e.ev === 'action-rejected')?.payload.reason, 'game-started');
  assert.ok(!hasRoom(emitted, 'game-started'), 'a second start must not reset the match');
  gameStatus = 'lobby';
});

test('automation can only be set for your own team', async () => {
  const { emitted, connect } = harness();
  const alpha = connect('alpha', 'G13');
  await alpha._handlers['set-automated-roles']({ gameCode: 'G13', team: 'bravo', automatedRoles: ['engineer'] });
  assert.ok(!hasRoom(emitted, 'automated-roles-updated'));
  await alpha._handlers['set-automated-roles']({ gameCode: 'G13', team: 'alpha', automatedRoles: ['engineer'] });
  assert.ok(hasRoom(emitted, 'automated-roles-updated', 'game:G13'));
});

test('lobby picks keep only known roles, each once', async () => {
  const { emitted, connect } = harness();
  const alpha = connect('alpha', 'G14');
  dbCalls.length = 0;
  await alpha._handlers['select-roles']({ gameCode: 'G14', roles: ['captain', 'admiral', 'captain', { x: 1 }, 'engineer'] });
  const write = dbCalls.find((c) => /update game_players set roles/i.test(c.text));
  assert.strictEqual(write.params[0], 'captain,engineer');
  assert.deepStrictEqual(alpha.roles, ['captain', 'engineer']);
  assert.deepStrictEqual(emitted.find((e) => e.ev === 'roles-updated').payload.roles, ['captain', 'engineer']);

  await alpha._handlers['set-automated-roles']({ gameCode: 'G14', team: 'alpha', automatedRoles: ['captain', 'first-mate', 'x'.repeat(1000), 'first-mate'] });
  assert.deepStrictEqual(emitted.find((e) => e.ev === 'automated-roles-updated').payload.automatedRoles, ['first-mate']);

  emitted.length = 0;
  await alpha._handlers['set-automated-roles']({ gameCode: 'G14', team: 'alpha', automatedRoles: 'engineer' });
  assert.ok(!hasRoom(emitted, 'automated-roles-updated'), 'not a list, not taken');
});

test('the automated first mate charges only real systems, in the order given', async () => {
  const { emitted, connect } = harness();
  const alpha = connect('alpha', 'G15');
  await alpha._handlers['set-automated-roles']({ gameCode: 'G15', team: 'alpha', automatedRoles: ['first-mate'] });
  await alpha._handlers['set-system-priority']({ gameCode: 'G15', team: 'alpha', systemPriority: 7 }); // ignored
  await alpha._handlers['set-system-priority']({ gameCode: 'G15', team: 'alpha', systemPriority: ['__proto__', 'warp', 'sonar', 'sonar', 'mine'] });
  await alpha._handlers['start-game']({ gameCode: 'G15' }); // carries the lobby setup into the match
  await alpha._handlers['captain-move']({ gameCode: 'G15', direction: 'S' });
  await new Promise((r) => setTimeout(r, 600)); // automation runs after AUTOMATION_DELAY_MS
  const charged = emitted.find((e) => e.ev === 'system-charged');
  assert.ok(charged, 'the automated first mate charged something');
  assert.strictEqual(charged.payload.system, 'sonar');
  const state = emitted.filter((e) => e.ev === 'game-state' && e.room === 'game:G15:alpha').pop();
  assert.deepStrictEqual(state.payload.systemPriority, ['sonar', 'mine']);
});
