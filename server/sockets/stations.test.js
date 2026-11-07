// Crew stations: each play belongs to the station that makes it (captain, first mate, engineer,
// radio operator), and the server takes it only from a player who picked that station in the
// lobby. Players here are seated by join-game from a fake game_players table, as in the real
// game, and try what their seat should not allow. The DB is mocked as in matchPersistence.test.js.
const test = require('node:test');
const assert = require('node:assert');
const engine = require('../game/engine');
const { ENGINEER_SLOTS } = require('../game/constants');

// ---- a fake database: games, seats, and the game_matches table -----------------------------
const games = {};   // code -> games row
const seats = {};   // code -> { userId: { team, roles } }
const matches = {}; // code -> stored state, as JSON text

const ALL = 'captain,first-mate,engineer,radio-operator';
// alpha has a full crew of four, bravo a captain; 7 sits on alpha with no station; 6 has no seat
const CREW = () => ({
  1: { team: 'alpha', roles: 'captain' },
  2: { team: 'alpha', roles: 'first-mate' },
  3: { team: 'alpha', roles: 'engineer' },
  4: { team: 'alpha', roles: 'radio-operator' },
  5: { team: 'bravo', roles: 'captain' },
  7: { team: 'alpha', roles: 'unassigned' },
});

function newGame(code, row = {}, seatList = CREW()) {
  games[code] = { id: Object.keys(games).length + 1, code, status: 'playing', game_mode: 'turn-based', same_room: false, created_by: 1, ...row };
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
      if (/update games set status = 'playing'/i.test(text)) { games[params[0]].status = 'playing'; return { rows: [] }; }
      if (/update games set status = 'finished'/i.test(text)) return { rows: [] };
      if (/insert into game_players/i.test(text)) {
        const table = seats[codeOfId(params[0])];
        table[params[1]] = { roles: 'unassigned', ...table[params[1]], team: params[2] };
        return { rows: [] };
      }
      if (/update game_players set roles/i.test(text)) {
        const seat = seats[codeOfId(params[1])]?.[params[2]];
        if (!seat) return { rows: [] };
        seat.roles = params[0];
        return { rows: [{ user_id: params[2] }] };
      }
      if (/from game_players/i.test(text)) {
        const seat = seats[codeOfId(params[0])]?.[params[1]];
        return { rows: seat ? [seat] : [] };
      }
      if (/from games/i.test(text)) return { rows: games[params[0]] ? [games[params[0]]] : [] };
      return { rows: [] };
    },
  },
};

// ---- the server, and players connecting to it ----------------------------------------------
const emitted = []; // every room emit
const roomEmitter = (room) => ({ emit: (ev, payload) => emitted.push({ room, ev, payload }) });
const io = { use() {}, on(ev, fn) { if (ev === 'connection') io._conn = fn; }, to: roomEmitter };
require('./game')(io);

// A socket for `userId`, in no game until it joins one.
function connect(userId) {
  const handlers = {};
  const socket = {
    id: `s-${userId}`, userId, username: `u${userId}`,
    join() {}, leave() {}, to: roomEmitter,
    on(ev, fn) { handlers[ev] = fn; },
    emit(ev, payload) { socket._emitted.push({ ev, payload }); },
    _emitted: [],
  };
  io._conn(socket);
  const call = (ev, payload) => handlers[ev](payload);
  return { socket, call, join: (gameCode) => call('join-game', { gameCode }) };
}
async function seated(code, ...userIds) {
  const players = userIds.map(connect);
  for (const p of players) await p.join(code);
  return players;
}

const rejections = (player) => player.socket._emitted.filter((e) => e.ev === 'action-rejected').map((e) => e.payload);
const lastRejection = (player) => rejections(player).pop();
const roomEvents = (code) => emitted.filter((e) => e.room.startsWith(`game:${code}`) && e.ev !== 'player-joined');
const happened = (code, ev) => roomEvents(code).some((e) => e.ev === ev);
const stateOf = (player) => player.socket._emitted.filter((e) => e.ev === 'game-state').pop()?.payload;

// Every play a captain makes, with the action name a refusal carries.
const CAPTAIN_PLAYS = [
  ['captain-move', { direction: 'S' }, 'move'],
  ['fire-torpedo', { target: { x: 1, y: 3 } }, 'fire-torpedo'],
  ['place-mine', { target: { x: 1, y: 2 } }, 'place-mine'],
  ['detonate-mine', { target: { x: 1, y: 2 } }, 'detonate-mine'],
  ['launch-drone', { sector: 1 }, 'launch-drone'],
  ['use-sonar', {}, 'use-sonar'],
  ['use-silence', { direction: 'S', distance: 1 }, 'use-silence'],
  ['surface', {}, 'surface'],
];

test('the crew cannot make the captain\'s plays, and each is told why', async () => {
  const code = newGame('CAPT01');
  const crew = await seated(code, 2, 3, 4);
  for (const player of crew) {
    for (const [ev, payload, action] of CAPTAIN_PLAYS) {
      await player.call(ev, { gameCode: code, ...payload });
      const rej = lastRejection(player);
      assert.strictEqual(rej?.action, action, `${ev} by user ${player.socket.userId}`);
      assert.strictEqual(rej.reason, 'not-your-station');
      assert.strictEqual(rej.station, 'captain');
      assert.match(rej.message, /^Only the Captain can [a-z ]+\.$/);
    }
    assert.strictEqual(rejections(player).length, CAPTAIN_PLAYS.length, 'one refusal per try, nothing else');
  }
  assert.deepStrictEqual(roomEvents(code), [], 'the sub never moved, fired or surfaced');
});

test('the captain cannot charge, mark breakdowns, or say aye for the crew', async () => {
  const code = newGame('CAPT02');
  const [captain] = await seated(code, 1);
  await captain.call('captain-move', { gameCode: code, direction: 'S' });
  assert.ok(happened(code, 'move-announced'), 'the captain steers');

  await captain.call('charge-system', { gameCode: code, system: 'torpedo' });
  assert.deepStrictEqual(lastRejection(captain), {
    action: 'charge', reason: 'not-your-station', station: 'first-mate', message: 'Only the First Mate can charge systems.',
  });
  await captain.call('mark-damage', { gameCode: code, slotId: 's1' });
  assert.deepStrictEqual(lastRejection(captain), {
    action: 'mark-damage', reason: 'not-your-station', station: 'engineer', message: 'Only the Engineer can mark breakdowns.',
  });
  for (const role of ['first-mate', 'engineer', 'radio-operator']) {
    await captain.call('aye-captain', { gameCode: code, role });
    const rej = lastRejection(captain);
    assert.strictEqual(rej.station, role, 'the station named in the payload is the one checked');
    assert.strictEqual(rej.action, 'confirm');
  }
  for (const ev of ['system-charged', 'damage-marked', 'role-confirmed', 'turn-complete']) {
    assert.ok(!happened(code, ev), `no ${ev}`);
  }
});

test('a crew member cannot say aye, charge or mark for another station', async () => {
  const code = newGame('CREW01');
  const [captain, mate, engineer, radio] = await seated(code, 1, 2, 3, 4);
  await captain.call('captain-move', { gameCode: code, direction: 'S' });

  await radio.call('aye-captain', { gameCode: code, role: 'engineer' });
  assert.strictEqual(lastRejection(radio).station, 'engineer');
  await radio.call('aye-captain', { gameCode: code, role: 'first-mate' });
  assert.strictEqual(lastRejection(radio).station, 'first-mate');
  await engineer.call('charge-system', { gameCode: code, system: 'torpedo' });
  assert.strictEqual(lastRejection(engineer).station, 'first-mate');
  await mate.call('mark-damage', { gameCode: code, slotId: 's1' });
  assert.strictEqual(lastRejection(mate).station, 'engineer');
  await mate.call('aye-captain', { gameCode: code, role: 'radio-operator' });
  assert.strictEqual(lastRejection(mate).station, 'radio-operator');
  assert.ok(!happened(code, 'role-confirmed'));

  // a name that is no crew station gets the engine's answer, not a station check
  await radio.call('aye-captain', { gameCode: code, role: 'captain' });
  assert.deepStrictEqual(lastRejection(radio), { action: 'confirm', reason: 'bad-role' });
  await radio.call('aye-captain', { gameCode: code, role: { toString: () => 'radio-operator' } });
  assert.deepStrictEqual(lastRejection(radio), { action: 'confirm', reason: 'bad-role' });
});

test('each station plays its own part and the turn completes', async () => {
  const code = newGame('CREW02');
  const [captain, mate, engineer, radio] = await seated(code, 1, 2, 3, 4);
  await captain.call('captain-move', { gameCode: code, direction: 'S' });
  await mate.call('charge-system', { gameCode: code, system: 'torpedo' });
  await engineer.call('mark-damage', { gameCode: code, slotId: 's1' });
  assert.ok(happened(code, 'system-charged'));
  assert.ok(happened(code, 'damage-marked'));
  await mate.call('aye-captain', { gameCode: code, role: 'first-mate' });
  await engineer.call('aye-captain', { gameCode: code, role: 'engineer' });
  assert.ok(!happened(code, 'turn-complete'));
  await radio.call('aye-captain', { gameCode: code, role: 'radio-operator' });
  assert.ok(happened(code, 'turn-complete'));
  for (const p of [captain, mate, engineer, radio]) assert.deepStrictEqual(rejections(p), []);
});

test('one device holding every station plays the whole turn (a same-room table)', async () => {
  const code = newGame('ROOM01', { same_room: true }, { 8: { team: 'alpha', roles: ALL }, 5: { team: 'bravo', roles: 'captain,engineer' } });
  const [table, bravo] = await seated(code, 8, 5);
  await table.call('captain-move', { gameCode: code, direction: 'S' });
  await table.call('charge-system', { gameCode: code, system: 'torpedo' });
  await table.call('mark-damage', { gameCode: code, slotId: 's1' });
  for (const role of ['first-mate', 'engineer', 'radio-operator']) await table.call('aye-captain', { gameCode: code, role });
  assert.ok(happened(code, 'turn-complete'));
  assert.deepStrictEqual(rejections(table), []);

  // two stations on one device: both work, and the ones it lacks still do not
  const dir = stateOf(bravo).legalMoves[0];
  await bravo.call('captain-move', { gameCode: code, direction: dir });
  await bravo.call('mark-damage', { gameCode: code, slotId: ENGINEER_SLOTS.find((s) => s.dir === dir).id });
  assert.ok(roomEvents(code).some((e) => e.ev === 'damage-marked' && e.payload.team === 'bravo'));
  await bravo.call('charge-system', { gameCode: code, system: 'torpedo' });
  assert.strictEqual(lastRejection(bravo).station, 'first-mate');
});

test('a player on the other team plays only their own sub, whatever the payload names', async () => {
  const code = newGame('ENEMY1');
  const [alphaCaptain, bravo] = await seated(code, 1, 5);
  const before = stateOf(alphaCaptain).submarines.alpha.position;
  const dir = stateOf(bravo).legalMoves[0];
  await bravo.call('captain-move', { gameCode: code, direction: dir, team: 'alpha' });
  const moves = roomEvents(code).filter((e) => e.ev === 'move-announced');
  assert.deepStrictEqual(moves.map((e) => e.payload.team), ['bravo']);
  const after = emitted.filter((e) => e.ev === 'game-state' && e.room === `game:${code}:alpha`).pop().payload;
  assert.deepStrictEqual(after.submarines.alpha.position, before, 'alpha did not move');

  // bravo's captain is not alpha's: setting alpha's charging order is not theirs to do
  emitted.length = 0;
  await bravo.call('set-system-priority', { gameCode: code, team: 'alpha', systemPriority: ['mine'] });
  await alphaCaptain.call('captain-move', { gameCode: code, direction: 'S' });
  const alphaState = emitted.filter((e) => e.ev === 'game-state' && e.room === `game:${code}:alpha`).pop().payload;
  assert.notDeepStrictEqual(alphaState.systemPriority, ['mine']);
});

test('only the captain sets the automated first mate\'s charging order', async () => {
  const code = newGame('PRIO01');
  const [captain, radio] = await seated(code, 1, 4);
  await radio.call('set-system-priority', { gameCode: code, team: 'alpha', systemPriority: ['mine'] });
  assert.deepStrictEqual(lastRejection(radio), {
    action: 'set-priority', reason: 'not-your-station', station: 'captain', message: 'Only the Captain can set the First Mate\'s charging order.',
  });
  await captain.call('set-system-priority', { gameCode: code, team: 'alpha', systemPriority: ['sonar', 'mine'] });
  assert.deepStrictEqual(rejections(captain), []);
  await captain.call('captain-move', { gameCode: code, direction: 'S' });
  const state = emitted.filter((e) => e.ev === 'game-state' && e.room === `game:${code}:alpha`).pop().payload;
  assert.deepStrictEqual(state.systemPriority, ['sonar', 'mine']);
});

test('a spectator with no seat is ignored outright', async () => {
  const code = newGame('WATCH1');
  const [watcher] = await seated(code, 6);
  assert.strictEqual(watcher.socket.team, null);
  for (const [ev, payload] of CAPTAIN_PLAYS) await watcher.call(ev, { gameCode: code, ...payload });
  await watcher.call('charge-system', { gameCode: code, system: 'torpedo' });
  await watcher.call('mark-damage', { gameCode: code, slotId: 's1' });
  for (const role of ['first-mate', 'engineer', 'radio-operator']) await watcher.call('aye-captain', { gameCode: code, role });
  await watcher.call('sonar-response', { gameCode: code, facts: [] });
  await watcher.call('set-system-priority', { gameCode: code, team: 'alpha', systemPriority: ['mine'] });
  assert.deepStrictEqual(watcher.socket._emitted, [], 'not even a game-state: they are on no team');
  assert.deepStrictEqual(roomEvents(code), []);
});

test('a seat with no station plays nothing, sonar replies included', async () => {
  const code = newGame('IDLE01');
  matches[code] = JSON.stringify((() => {
    const s = engine.initGameState('turn-based', false);
    s.submarines.alpha.pendingSonar = { askingTeam: 'bravo', id: 9001 };
    return s;
  })());
  const [idle, radio] = await seated(code, 7, 4);
  assert.strictEqual(idle.socket.team, 'alpha');
  await idle.call('captain-move', { gameCode: code, direction: 'S' });
  assert.strictEqual(lastRejection(idle).reason, 'not-your-station');
  const facts = engine.autoSonarFacts(stateOf(idle).submarines.alpha);
  await idle.call('sonar-response', { gameCode: code, facts });
  assert.deepStrictEqual(lastRejection(idle), {
    action: 'sonar-response', reason: 'no-station', message: 'Only crew with a station can answer the sonar.',
  });
  assert.ok(!happened(code, 'sonar-answered'));

  // any crew station may answer the ping
  await radio.call('sonar-response', { gameCode: code, facts });
  assert.deepStrictEqual(rejections(radio), []);
  assert.ok(happened(code, 'sonar-answered'));
});

test('a player who leaves for another game takes no station with them, and has it back on return', async () => {
  const code = newGame('LEFT01');
  newGame('LEFT02', {}, {});
  const [captain] = await seated(code, 1);
  await captain.join('LEFT02'); // not seated there
  assert.deepStrictEqual(captain.socket.roles, []);
  await captain.call('captain-move', { gameCode: code, direction: 'S' });
  await captain.call('captain-move', { gameCode: 'LEFT02', direction: 'S' });
  assert.deepStrictEqual(rejections(captain), []);
  assert.ok(!happened(code, 'move-announced') && !happened('LEFT02', 'move-announced'));

  // the old socket is gone (a closed tab); a new one joins and is captain again
  const back = connect(1);
  await back.join(code);
  await back.call('captain-move', { gameCode: code, direction: 'S' });
  assert.ok(happened(code, 'move-announced'));
});

test('stations are picked in the lobby only, and only with a seat', async () => {
  const code = newGame('LOBBY1', { status: 'lobby' }, { 1: { team: 'alpha', roles: 'captain' }, 5: { team: 'bravo', roles: 'captain' } });
  const [creator, newcomer] = await seated(code, 1, 9);
  // picking a station before a team gives none
  await newcomer.call('select-roles', { gameCode: code, roles: ['captain'] });
  assert.deepStrictEqual(newcomer.socket.roles, []);
  assert.ok(!happened(code, 'roles-updated'));
  await newcomer.call('select-team', { gameCode: code, team: 'alpha' });
  assert.deepStrictEqual(newcomer.socket.roles, []);
  await newcomer.call('select-roles', { gameCode: code, roles: ['radio-operator'] });
  assert.deepStrictEqual(newcomer.socket.roles, ['radio-operator']);
  assert.strictEqual(seats[code][9].roles, 'radio-operator');

  await creator.call('start-game', { gameCode: code });
  assert.ok(happened(code, 'game-started'));
  // once the game is on, nobody promotes themselves to captain
  await newcomer.call('select-roles', { gameCode: code, roles: ['captain'] });
  assert.deepStrictEqual(newcomer.socket.roles, ['radio-operator']);
  await newcomer.call('captain-move', { gameCode: code, direction: 'S' });
  assert.strictEqual(lastRejection(newcomer).station, 'captain');
  assert.ok(!happened(code, 'move-announced'));
});

test('live mode: the first mate spends charge tokens and the engineer works the breakdown queue', async () => {
  const code = newGame('LIVE01', { game_mode: 'live' });
  const [captain, mate, engineer, radio] = await seated(code, 1, 2, 3, 4);
  await captain.call('captain-move', { gameCode: code, direction: 'S' });
  await captain.call('charge-system', { gameCode: code, system: 'torpedo' });
  assert.strictEqual(lastRejection(captain).station, 'first-mate');
  await radio.call('mark-damage', { gameCode: code, slotId: 's1' });
  assert.strictEqual(lastRejection(radio).station, 'engineer');
  assert.ok(!happened(code, 'system-charged') && !happened(code, 'damage-marked'));

  await mate.call('charge-system', { gameCode: code, system: 'torpedo' });
  await engineer.call('mark-damage', { gameCode: code, slotId: 's1' });
  assert.ok(happened(code, 'system-charged'));
  assert.ok(happened(code, 'damage-marked'));
  const sub = emitted.filter((e) => e.ev === 'game-state' && e.room === `game:${code}:alpha`).pop().payload.submarines.alpha;
  assert.strictEqual(sub.chargeTokens, 0);
  assert.deepStrictEqual(sub.breakdownQueue, []);
});
