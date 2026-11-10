// Stations and seats: each play belongs to the station that makes it (helm, listening, torpedo
// room, engine room), and the server takes it only from a player who picked that station in the
// lobby, in the game they joined. Players are seated by join-game from a fake game_players table,
// as in the real game, and try what their seat should not allow. The clock is run by hand.
const test = require('node:test');
const assert = require('node:assert');
const { TUNING } = require('../game/constants');

// ---- a fake database: games, seats, and the game_matches table -----------------------------
const games = {};   // code -> games row
const seats = {};   // code -> { userId: { team, roles } }
const matches = {}; // code -> stored state, as JSON text
const finished = []; // codes whose result was written

// alpha: one player per station; bravo: a helm; 7 sits on alpha with no station; 6 has no seat
const CREW = () => ({
  1: { team: 'alpha', roles: 'helm' },
  2: { team: 'alpha', roles: 'listener' },
  3: { team: 'alpha', roles: 'weapons' },
  4: { team: 'alpha', roles: 'chief' },
  5: { team: 'bravo', roles: 'helm' },
  7: { team: 'alpha', roles: 'unassigned' },
});

function newGame(code, row = {}, seatList = CREW()) {
  games[code] = { id: Object.keys(games).length + 1, code, status: 'lobby', game_mode: 'crews', same_room: false, created_by: 1, ...row };
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
      if (/update games set status = 'finished'/i.test(text)) { finished.push(params[1]); return { rows: [], rowCount: 1 }; }
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
        const table = seats[codeOfId(params[0])] || {};
        if (params.length === 1) return { rows: Object.entries(table).map(([id, s]) => ({ user_id: Number(id), ...s })) };
        const seat = table[params[1]];
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
const server = require('./game')(io, { clock: false });

let sockets = 0;
function connect(userId) {
  const handlers = {};
  const socket = {
    id: `s-${userId}-${++sockets}`, userId, username: `u${userId}`,
    _rooms: new Set(),
    join(room) { socket._rooms.add(room) }, leave(room) { socket._rooms.delete(room) }, to: roomEmitter,
    on(ev, fn) { handlers[ev] = fn; },
    emit(ev, payload) { socket._emitted.push({ ev, payload }); },
    _emitted: [],
  };
  io._conn(socket);
  const call = (ev, payload) => handlers[ev](payload);
  return { socket, call, join: (gameCode) => call('join-game', { gameCode }), drop: () => handlers.disconnect() };
}
async function seated(code, ...userIds) {
  const players = userIds.map(connect);
  for (const p of players) await p.join(code);
  return players;
}
async function started(code, ...userIds) {
  const players = await seated(code, ...userIds);
  const creator = players.find((p) => p.socket.userId === games[code].created_by) || (await seated(code, games[code].created_by))[0];
  await creator.call('start-game', { gameCode: code });
  return players;
}

const rejections = (player) => player.socket._emitted.filter((e) => e.ev === 'action-rejected').map((e) => e.payload);
const lastRejection = (player) => rejections(player).pop();
const roomEvents = (code) => emitted.filter((e) => e.room.startsWith(`game:${code}`) && !['player-joined', 'player-left'].includes(e.ev));
const match = (code) => server._states.get(code);

// Every play, the station it belongs to, and the action name a refusal carries.
const PLAYS = [
  ['helm', { speed: 2 }, 'helm', 'helm'],
  ['helm', { turn: 1 }, 'helm', 'helm'],
  ['mark', { cell: { x: 3, y: 3 } }, 'listener', 'mark'],
  ['ping', {}, 'listener', 'ping'],
  ['load', { tube: 0 }, 'weapons', 'load'],
  ['fire', { tube: 0, target: { x: 3, y: 3 } }, 'weapons', 'fire'],
  ['guide', { id: 1, target: { x: 3, y: 3 } }, 'weapons', 'guide'],
  ['decoy', { heading: 2 }, 'weapons', 'decoy'],
  ['power', { power: { engines: 3, sonar: 2, tubes: 1 } }, 'chief', 'power'],
  ['repair', { faultId: 1 }, 'chief', 'repair'],
  ['vent', {}, 'chief', 'vent'],
];

test('each play is taken only from the station it belongs to, and anyone else is told whose job it is', async () => {
  const code = newGame('STAT01');
  const crew = await started(code, 1, 2, 3, 4);
  const before = JSON.stringify(match(code).subs.alpha);
  for (const player of crew) {
    const mine = player.socket.userId === 1 ? 'helm' : player.socket.userId === 2 ? 'listener' : player.socket.userId === 3 ? 'weapons' : 'chief';
    for (const [ev, payload, station, action] of PLAYS) {
      if (station === mine) continue;
      await player.call(ev, { gameCode: code, ...payload });
      const rej = lastRejection(player);
      assert.equal(rej?.action, action, `${ev} by user ${player.socket.userId}`);
      assert.equal(rej.reason, 'not-your-station');
      assert.equal(rej.station, station);
    }
  }
  assert.equal(JSON.stringify(match(code).subs.alpha), before, 'nothing on the boat changed');
});

test('a player at a station makes its plays: the helm steers, listening marks, the torpedo room loads, the engine room sets power', async () => {
  const code = newGame('STAT02');
  const [helm, listener, weapons, chief] = await started(code, 1, 2, 3, 4);
  await helm.call('helm', { gameCode: code, speed: 1, turn: -1 });
  await listener.call('mark', { gameCode: code, cell: { x: 4, y: 4 } });
  await weapons.call('load', { gameCode: code, tube: 1 });
  await chief.call('power', { gameCode: code, power: { engines: 1, sonar: 3, tubes: 2 } });
  const b = match(code).subs.alpha;
  assert.equal(b.ordered, 1);
  assert.deepEqual({ x: b.marker.x, y: b.marker.y }, { x: 4, y: 4 });
  assert.equal(b.tubes[1].state, 'loading');
  assert.deepEqual(b.power, { engines: 1, sonar: 3, tubes: 2 });
  // what reached the rooms went to alpha's room only
  const teamFx = roomEvents(code).filter((e) => e.ev === 'fx');
  assert.ok(teamFx.length > 0);
  assert.ok(teamFx.every((e) => e.room === `game:${code}:alpha`));
  // a malformed play is dropped without a word
  for (const bad of [{ cell: { x: 1.5, y: 2 } }, { cell: 'A1' }]) await listener.call('mark', { gameCode: code, ...bad });
  await weapons.call('load', { gameCode: code, tube: 5 });
  await chief.call('power', { gameCode: code, power: { engines: '4', sonar: 2, tubes: 2 } });
  assert.deepEqual(b.power, { engines: 1, sonar: 3, tubes: 2 });
});

test('a seat in one game plays nothing in another by naming its code, and no seat plays nothing at all', async () => {
  const a = newGame('STAT03');
  const b = newGame('STAT04', {}, { 1: { team: 'bravo', roles: 'helm' }, 5: { team: 'alpha', roles: 'helm' } });
  await started(b, 1, 5);
  const [helm] = await started(a, 1);
  const before = JSON.stringify(match(b).subs);
  await helm.call('helm', { gameCode: b, speed: 3 });
  const [stranger] = await seated(a, 6);
  await stranger.call('helm', { gameCode: a, speed: 3 });
  assert.equal(JSON.stringify(match(b).subs), before);
  assert.equal(match(a).subs.alpha.ordered, 0);
  assert.deepEqual(rejections(stranger), [], 'no seat: nothing to say');
  assert.equal(stranger.socket._emitted.filter((e) => e.ev === 'game-state').length, 0, 'and no view of the match');
});

test('naming the other boat\'s torpedo or fault does nothing to it', async () => {
  const code = newGame('STAT13', { created_by: 3 }, { 3: { team: 'alpha', roles: 'weapons,chief' }, 5: { team: 'bravo', roles: 'weapons,chief' } })
  const [ours] = await started(code, 3, 5)
  const s = match(code)
  // bravo has a torpedo running and a fire burning
  s.subs.bravo.tubes[0] = { state: 'ready', progress: 1 }
  s.torpedoes.push({ id: 900, team: 'bravo', tube: 0, x: s.subs.bravo.x, y: s.subs.bravo.y, tx: 8, ty: 6, run: 0, noiseIn: 1 })
  s.subs.bravo.faults.push({ id: 901, kind: 'fire' })
  await ours.call('guide', { gameCode: code, id: 900, target: { x: s.subs.alpha.x, y: s.subs.alpha.y } })
  await ours.call('repair', { gameCode: code, faultId: 901 })
  assert.deepEqual({ tx: s.torpedoes[0].tx, ty: s.torpedoes[0].ty }, { tx: 8, ty: 6 }, 'their torpedo goes where they sent it')
  assert.equal(s.subs.bravo.repair, null)
  assert.deepEqual(rejections(ours).map((r) => r.reason), ['no-torpedo', 'no-fault'])
})

test('someone with the code but no seat is only ever in the public room, never a boat\'s', async () => {
  const code = newGame('STAT14')
  await started(code, 1, 5)
  const [stranger] = await seated(code, 6)
  await stranger.call('select-team', { gameCode: code, team: 'bravo' })
  await stranger.call('focus', { gameCode: code, station: 'helm' })
  assert.deepEqual([...stranger.socket._rooms], [`game:${code}`])
  assert.equal(seats[code][6], undefined, 'no seat taken mid-game')
  assert.equal(stranger.socket._emitted.filter((e) => e.ev === 'game-state').length, 0)
})

test('a seat without a station sees its boat but plays nothing', async () => {
  const code = newGame('STAT05');
  await started(code, 1, 7);
  const [idle] = await seated(code, 7); // back after the start
  assert.equal(idle.socket._emitted.filter((e) => e.ev === 'game-state').length, 1, 'the view on joining');
  for (const [ev, payload] of PLAYS) await idle.call(ev, { gameCode: code, ...payload });
  assert.equal(rejections(idle).length, PLAYS.length);
  assert.equal(match(code).subs.alpha.ordered, 0);
});

test('start-game: only the creator, only once, and the crew comes from the seats', async () => {
  const code = newGame('STAT06');
  const [, two] = await seated(code, 1, 2);
  await two.call('start-game', { gameCode: code });
  assert.equal(lastRejection(two).reason, 'not-creator');
  assert.equal(match(code), undefined);
  const [creator] = await seated(code, 1);
  await creator.call('start-game', { gameCode: code });
  const first = match(code);
  assert.deepEqual(first.crew.alpha, { helm: 'human', listener: 'human', weapons: 'human', chief: 'human' });
  assert.deepEqual(first.crew.bravo, { helm: 'human', listener: 'auto', weapons: 'auto', chief: 'auto' });
  await creator.call('start-game', { gameCode: code });
  assert.equal(lastRejection(creator).reason, 'game-started');
  assert.equal(match(code), first, 'the match was not replaced');
  // each team's room got its own view only
  const starts = roomEvents(code).filter((e) => e.ev === 'game-started');
  assert.deepEqual(starts.map((e) => [e.room, e.payload.team]), [[`game:${code}:alpha`, 'alpha'], [`game:${code}:bravo`, 'bravo']]);
});

test('teams and stations are picked in the lobby only; against the AI everyone crews the one boat', async () => {
  const code = newGame('STAT07', {}, {});
  const [p] = await seated(code, 9);
  await p.call('select-roles', { gameCode: code, roles: ['helm'] });
  assert.equal(seats[code][9], undefined, 'no stations before a team');
  await p.call('select-team', { gameCode: code, team: 'bravo' });
  await p.call('select-roles', { gameCode: code, roles: ['helm', 'captain', 'helm', 'chief', 42] });
  assert.deepEqual(seats[code][9], { roles: 'helm,chief', team: 'bravo' });
  games[code].status = 'playing';
  await p.call('select-team', { gameCode: code, team: 'alpha' });
  assert.equal(lastRejection(p).reason, 'game-started');
  await p.call('select-roles', { gameCode: code, roles: ['listener'] });
  assert.equal(seats[code][9].roles, 'helm,chief');

  const solo = newGame('STAT08', { game_mode: 'vs-ai' }, {});
  const [q] = await seated(solo, 10);
  await q.call('select-team', { gameCode: solo, team: 'bravo' });
  assert.equal(lastRejection(q).reason, 'ai-boat');
  await q.call('select-team', { gameCode: solo, team: 'alpha' });
  assert.equal(seats[solo][10].team, 'alpha');
});

test('the clock ticks a running match and sends each team its own view and its own contacts', async () => {
  const code = newGame('STAT09', { game_mode: 'vs-ai' }, { 1: { team: 'alpha', roles: 'helm,listener,weapons,chief' } });
  const [me] = await started(code, 1);
  const s = match(code);
  assert.equal(s.vsAi, true);
  assert.deepEqual(s.crew.bravo, { helm: 'auto', listener: 'auto', weapons: 'auto', chief: 'auto' });
  await me.call('power', { gameCode: code, power: { engines: 3, sonar: 2, tubes: 1 } });
  await me.call('helm', { gameCode: code, speed: 3 });
  const from = emitted.length;
  for (let i = 0; i < 60; i++) server._tickAll();
  assert.ok(s.t >= 5.9, 'six seconds of play');
  const out = emitted.slice(from).filter((e) => e.room.startsWith(`game:${code}`));
  const views = out.filter((e) => e.ev === 'game-state');
  assert.ok(views.length >= 20, 'about five views a second for each team');
  for (const v of views) assert.equal(v.room, `game:${code}:${v.payload.team}`);
  for (const c of out.filter((e) => e.ev === 'fx' && e.payload.type === 'contact')) {
    assert.notEqual(c.room, `game:${code}`, 'a contact never goes to the whole room');
  }
});

test('a station whose people have all gone is handed to the auto-crew, and handed back when one returns', async () => {
  const code = newGame('STAT10', {}, { 1: { team: 'alpha', roles: 'helm,weapons' }, 5: { team: 'bravo', roles: 'helm' } });
  const [one, five] = await started(code, 1, 5);
  const s = match(code);
  server._tickAll();
  assert.equal(s.away.alpha.helm, undefined);
  one.drop();
  server._tickAll();
  assert.ok(!s.away.alpha.helm, 'not straight away');
  s.awaySince.alpha.helm -= TUNING.AWAY_SECONDS * 1000;
  s.awaySince.alpha.weapons -= TUNING.AWAY_SECONDS * 1000;
  server._tickAll();
  assert.equal(s.away.alpha.helm, true);
  const view = emitted.filter((e) => e.ev === 'game-state' && e.room === `game:${code}:alpha`).pop().payload;
  assert.equal(view.crew.helm, 'auto');
  const [back] = await seated(code, 1);
  server._tickAll();
  assert.equal(s.away.alpha.helm, false);
  assert.ok(back.socket._emitted.some((e) => e.ev === 'game-state'));
  five.drop();
});

test('one player at several stations works the one on screen; the auto-crew covers the others, never the helm', async () => {
  const code = newGame('STAT12', { game_mode: 'vs-ai' }, { 1: { team: 'alpha', roles: 'helm,listener,weapons,chief' } })
  const [me] = await started(code, 1)
  const s = match(code)
  await me.call('focus', { gameCode: code, station: 'listener' })
  server._tickAll()
  for (const st of ['weapons', 'chief']) s.awaySince.alpha[st] -= TUNING.FOCUS_SECONDS * 1000
  server._tickAll()
  assert.deepEqual({ ...s.away.alpha }, { weapons: true, chief: true }, 'the tubes and the engine room are covered')
  assert.ok(!s.awaySince.alpha.helm, 'the helm keeps its last order instead')
  await me.call('focus', { gameCode: code, station: 'weapons' })
  server._tickAll()
  assert.equal(s.away.alpha.weapons, false, 'back the moment they look')
  // a station they do not hold is not theirs to focus: then nothing is covered
  await me.call('focus', { gameCode: code, station: 'captain' })
  server._tickAll()
  assert.equal(s.away.alpha.chief, false)
  me.drop()
})

test('a match with nobody aboard stops ticking after a while, and starts again when someone joins', async () => {
  const code = newGame('STAT11', { game_mode: 'vs-ai' }, { 1: { team: 'alpha', roles: 'helm' } });
  const [me] = await started(code, 1);
  const s = match(code);
  me.drop();
  server._tickAll();
  const t = s.t;
  s.emptySince -= 61 * 1000;
  server._tickAll();
  server._tickAll();
  assert.equal(s.t, t, 'paused');
  await seated(code, 1);
  server._tickAll();
  assert.ok(s.t > t, 'running again');
});
