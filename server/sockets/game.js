// Socket.io adapter over the real-time rules engine (server/game/engine.js) and its auto-crew
// (server/game/ai.js). This file owns: sign-in on the socket, rooms, seats and stations, the
// clock that ticks every running match, who is aboard (a station whose people have all gone is
// handed to the auto-crew), and keeping matches in Postgres. Every game RULE lives in the engine.
const db = require('../config/database');
const { originAllowed } = require('fleet-kit/server');
const { wp } = require('../config/auth');
const { corsOrigin } = require('../config/origin');
const engine = require('../game/engine');
const ai = require('../game/ai');
const { STATIONS, TEAMS, TUNING } = require('../game/constants');
const { tokenBucket } = require('./rateLimit');
const matchStore = require('../services/matchStore');
const { modeOf } = require('../game/modes');

// In-memory matches, keyed by game code. Survives disconnects, and a restart: every change is
// written to Postgres (services/matchStore.js) a moment later, and a game with no entry here is
// read back from there (hydrate, below) before it is touched.
const gameStates = new Map();
const loading = new Map(); // game code -> the read of its stored match in progress
const running = new Set(); // codes the clock is ticking
const presence = new Map(); // game code -> Map(socket id -> { team, roles })

const roomName = (code) => `game:${code}`;
const TICK_MS = Math.round(TUNING.TICK_SECONDS * 1000);
const VIEW_EVERY_SECONDS = 0.2;     // each team's view goes out five times a second of play
const SAVE_RUNNING_EVERY_MS = 3000; // a running match is written this often
const PAUSE_AFTER_MS = 60 * 1000;   // a match with nobody aboard stops ticking after this

// ---- keeping matches in the database ---------------------------------------
// Changes are collected and written together after SAVE_DELAY_MS, one write per game however
// many landed. A restart loses at most that long; a shutdown writes what is waiting.
const SAVE_DELAY_MS = 750;
const dirty = new Set();
let saveTimer = null;
let writes = Promise.resolve(); // writes run one after another, so an old one never lands over a newer

function markDirty(gameCode) {
  const state = gameStates.get(gameCode);
  if (!state) return;
  state.touchedAt = Date.now();
  dirty.add(gameCode);
  if (!saveTimer) {
    saveTimer = setTimeout(() => { saveTimer = null; flushMatches(); }, SAVE_DELAY_MS);
    saveTimer.unref?.();
  }
}

// Write every match waiting to be written; resolves when they have been. Never rejects.
function flushMatches() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const codes = [...dirty];
  dirty.clear();
  writes = writes.then(() => Promise.all(codes.map((code) => {
    const state = gameStates.get(code);
    return state ? matchStore.save(code, state) : null;
  }))).catch((err) => console.error('match write error:', err));
  return writes;
}

// Let go of matches past their time: in memory (a finished game 1 day after its game-over, any
// other after 7 days unchanged) and in the database. Returns how many left memory.
async function sweepMatches(now = Date.now()) {
  let dropped = 0;
  for (const [code, state] of gameStates) {
    const touched = state.touchedAt ?? now;
    const finished = state.over && now - (state.endedAt ?? touched) > matchStore.FINISHED_TTL_MS;
    if (finished || now - touched > matchStore.IDLE_TTL_MS) {
      gameStates.delete(code);
      dirty.delete(code);
      running.delete(code);
      dropped += 1;
    }
  }
  for (const [code, here] of presence) if (here.size === 0 && !running.has(code)) presence.delete(code);
  await matchStore.purge();
  return dropped;
}

// Every play belongs to one station, and only a player who picked that station in the lobby
// makes it. A player may hold several (one person can run the whole boat). A refusal says whose
// job it is, so the player sees why nothing happened.
const STATION_NAMES = { helm: 'the Helm', listener: 'Listening', weapons: 'the Torpedo Room', chief: 'the Engine Room' };
const pickStations = (list) => (Array.isArray(list) ? [...new Set(list.filter((x) => STATIONS.includes(x)))] : null);
const isCell = (c) => Boolean(c) && Number.isInteger(c.x) && Number.isInteger(c.y);
const isIndex = (n, max) => Number.isInteger(n) && n >= 0 && n < max;

function setupGameSockets(io, { clock: runClock = true } = {}) {
  // ---- sending -------------------------------------------------------------
  function sendViews(gameCode, state, { contacts = false } = {}) {
    const room = roomName(gameCode);
    for (const team of TEAMS) io.to(`${room}:${team}`).emit('game-state', engine.teamView(state, team, { contacts }));
    state.viewT = state.t;
  }

  function emitEvents(gameCode, events) {
    const room = roomName(gameCode);
    for (const e of events || []) {
      if (e.scope === 'room') io.to(room).emit(e.event, e.payload);
      else if (e.scope === 'team') io.to(`${room}:${e.team}`).emit(e.event, e.payload);
    }
    const over = (events || []).find((e) => e.event === 'game-over');
    if (over) persistGameOver(gameCode, over.payload.winner);
  }

  // A player's action: its events go out, the views follow at once, and the match is saved soon.
  function apply(socket, gameCode, state, result) {
    if (!result.ok) {
      socket.emit('action-rejected', result.error);
      return false;
    }
    if (result.events.length) {
      emitEvents(gameCode, result.events);
      sendViews(gameCode, state);
      markDirty(gameCode);
    }
    return true;
  }

  async function persistGameOver(gameCode, winner) {
    const state = gameStates.get(gameCode);
    if (state) {
      if (state.persisted) return;
      state.persisted = true;
      state.endedAt = Date.now(); // the match is kept a day from here
    }
    running.delete(gameCode);
    try {
      // Only a game being played finishes: a result already recorded is never overwritten.
      await db.query(
        `UPDATE games SET status = 'finished', winner_team = $1, ended_at = NOW() WHERE code = $2 AND status = 'playing'`,
        [winner, gameCode],
      );
    } catch (err) { console.error('Failed to persist game result:', err); }
    markDirty(gameCode);
    flushMatches();
  }

  // ---- who is aboard -------------------------------------------------------
  function aboard(gameCode) {
    if (!presence.has(gameCode)) presence.set(gameCode, new Map());
    return presence.get(gameCode);
  }

  function leaveGame(socket) {
    const code = socket.gameCode;
    if (!code) return;
    const here = presence.get(code);
    if (!here) return;
    here.delete(socket.id);
    if (here.size === 0 && !running.has(code)) presence.delete(code);
  }

  // Hand a station to the auto-crew when nobody holding it has been aboard for a while, and give
  // it back the moment one of them returns. A player holding several stations works the one on
  // their screen: the auto-crew covers the others they hold (a moment after they look away), except
  // the helm, which keeps its last order. Returns whether anything changed.
  function updateAway(gameCode, state, now) {
    const here = [...aboard(gameCode).values()];
    let changed = false;
    state.awaySince = state.awaySince || { alpha: {}, bravo: {} };
    const attends = (p, s) => p.roles.includes(s) && (p.roles.length === 1 || s === 'helm' || !p.focus || p.focus === s);
    for (const team of TEAMS) {
      for (const s of STATIONS) {
        if (state.crew[team][s] !== 'human') continue;
        const holders = here.filter((p) => p.team === team && p.roles.includes(s));
        const manned = holders.some((p) => attends(p, s));
        const wait = holders.length ? TUNING.FOCUS_SECONDS : TUNING.AWAY_SECONDS;
        if (manned) {
          delete state.awaySince[team][s];
          if (state.away[team][s]) { state.away[team][s] = false; changed = true; }
        } else {
          state.awaySince[team][s] = state.awaySince[team][s] ?? now;
          if (!state.away[team][s] && now - state.awaySince[team][s] >= wait * 1000) {
            state.away[team][s] = true;
            changed = true;
          }
        }
      }
    }
    return changed;
  }

  // ---- the clock -------------------------------------------------------------
  function tickAll() {
    const now = Date.now();
    for (const code of running) {
      const state = gameStates.get(code);
      if (!state?.subs || state.over) { running.delete(code); continue; }
      const people = aboard(code).size;
      if (people === 0) {
        state.emptySince = state.emptySince ?? now;
        if (now - state.emptySince >= PAUSE_AFTER_MS) { running.delete(code); markDirty(code); continue; }
      } else state.emptySince = null;
      try {
        const awayChanged = updateAway(code, state, now);
        const events = engine.tick(state, TUNING.TICK_SECONDS, ai);
        emitEvents(code, events);
        // Five views a second of play, and one at once when the crew changes or something public happens.
        if (awayChanged || state.t - (state.viewT ?? -1) >= VIEW_EVERY_SECONDS - 1e-6 || events.some((e) => e.scope === 'room')) sendViews(code, state);
        if (now - (state.savedAt || 0) >= SAVE_RUNNING_EVERY_MS || state.over) { state.savedAt = now; markDirty(code); }
      } catch (err) {
        console.error(`tick error in ${code}:`, err);
        running.delete(code);
      }
    }
  }
  // Tests pass clock: false and call _tickAll themselves.
  const clock = runClock ? setInterval(tickAll, TICK_MS) : null;
  clock?.unref?.();

  function startTicking(gameCode) {
    const state = gameStates.get(gameCode);
    if (state?.subs && !state.over) { state.emptySince = null; running.add(gameCode); }
  }

  // ---- a match back from the database (after a restart) ----------------------
  // Resolves to the match, or undefined when there is none. Read once however many sockets ask.
  async function hydrate(gameCode) {
    if (gameStates.has(gameCode)) return gameStates.get(gameCode);
    if (!loading.has(gameCode)) {
      loading.set(gameCode, (async () => {
        const stored = await matchStore.load(gameCode);
        if (!gameStates.has(gameCode) && stored) {
          gameStates.set(gameCode, stored);
          if (stored.over && !stored.persisted) persistGameOver(gameCode, stored.over.winner);
        }
        return gameStates.get(gameCode);
      })().finally(() => loading.delete(gameCode)));
    }
    return loading.get(gameCode);
  }

  // The seats of a game as the engine's crew: per team, which stations people hold.
  async function crewOf(gameId) {
    const res = await db.query('SELECT user_id, team, roles FROM game_players WHERE game_id = $1 ORDER BY joined_at', [gameId]);
    const crew = { alpha: {}, bravo: {} };
    for (const seat of res.rows) {
      if (!crew[seat.team]) continue;
      for (const s of (seat.roles || '').split(',')) if (STATIONS.includes(s)) crew[seat.team][s] = 'human';
    }
    return crew;
  }

  function newMatch(gameCode, row, crew) {
    const mode = modeOf(row.game_mode);
    const state = engine.initMatch({
      seed: Math.floor(Math.random() * 2 ** 32),
      crew: mode.vsAi ? { alpha: crew.alpha, bravo: {} } : crew,
      vsAi: mode.vsAi,
      aiSkill: mode.aiSkill,
    });
    gameStates.set(gameCode, state);
    markDirty(gameCode);
    return state;
  }

  // A match to play for a game the database says is being played: the stored one, else a fresh
  // one (the server restarted before it was ever written, or the stored one is from an older
  // version of the game). Null for a game that is not being played.
  async function playableState(gameCode, row) {
    const state = await hydrate(gameCode);
    if (state?.subs) return state;
    if (!row || row.status !== 'playing') return null;
    return newMatch(gameCode, row, await crewOf(row.id));
  }

  // ---- socket sign-in ------------------------------------------------------
  // The same session cookie as the REST API, which the browser sends with the handshake. A page
  // on another site could open a socket that carries it, and CORS does not cover a WebSocket
  // upgrade, so the handshake's Origin has to be this game's own (fleet-kit's originAllowed), or
  // the FRONTEND_URL a client hosted elsewhere is allowed from (config/origin.js).
  const otherFrontEnd = corsOrigin();
  const fromHere = (req) => originAllowed(req) || (typeof otherFrontEnd === 'string' && req.headers.origin === otherFrontEnd);
  io.use(async (socket, next) => {
    try {
      if (!fromHere(socket.request)) return next(new Error('This game only takes connections from its own pages'));
      const found = await wp.session.resolve(socket.request);
      if (found.failed) return next(new Error('Could not check your session'));
      if (!found.user) return next(new Error('Authentication required'));
      socket.userId = found.user.id;
      socket.username = found.user.username;
      next();
    } catch (err) {
      next(new Error('Invalid or expired session'));
    }
  });

  io.on('connection', (socket) => {
    socket.roles = []; // no station until join-game reads this player's seat

    // Wrap handlers so a throw logs instead of crashing the process, and so a socket sending
    // faster than anyone plays has the excess dropped (sockets/rateLimit.js).
    const take = tokenBucket();
    const on = (event, handler) => {
      socket.on(event, async (payload) => {
        if (!take()) return;
        try { await handler(payload || {}); }
        catch (err) { console.error(`socket '${event}' handler error:`, err); }
      });
    };

    // Every action names its game, but socket.team was looked up for the game this socket
    // joined. Only honour the team for that game, or a player seated in one game could steer a
    // boat in any other game by code.
    const teamIn = (gameCode) => (gameCode && gameCode === socket.gameCode ? socket.team : null);
    const joined = (gameCode) => Boolean(gameCode) && gameCode === socket.gameCode;

    // The running match and team for a play at `station`, else null (and a refusal that says
    // whose job it is, for a seated player at the wrong station; anyone else hears nothing).
    const playAt = (gameCode, station, action) => {
      const team = teamIn(gameCode);
      if (!team) return null;
      if (!socket.roles.includes(station)) {
        socket.emit('action-rejected', { action, reason: 'not-your-station', station, message: `That is ${STATION_NAMES[station]}'s job.` });
        return null;
      }
      const state = gameStates.get(gameCode);
      if (!state?.subs?.[team]) return null;
      return { state, team };
    };

    on('join-game', async ({ gameCode }) => {
      if (typeof gameCode !== 'string' || !gameCode || gameCode.length > 12) return;
      const room = roomName(gameCode);
      // A socket plays one game at a time: drop what it held in a previous game.
      if (socket.gameCode) {
        const oldRoom = roomName(socket.gameCode);
        if (socket.team) socket.leave(`${oldRoom}:${socket.team}`);
        socket.leave(oldRoom);
        leaveGame(socket);
      }
      socket.team = null;
      socket.roles = [];
      socket.join(room);
      socket.gameCode = gameCode;

      const gameResult = await db.query('SELECT id, status, game_mode, same_room FROM games WHERE code = $1', [gameCode]);
      const row = gameResult.rows[0];
      if (row) {
        const playerResult = await db.query('SELECT team, roles FROM game_players WHERE game_id = $1 AND user_id = $2', [row.id, socket.userId]);
        if (playerResult.rows.length > 0) {
          socket.team = playerResult.rows[0].team;
          socket.roles = (playerResult.rows[0].roles || '').split(',').filter((r) => STATIONS.includes(r));
          if (socket.team) socket.join(`${room}:${socket.team}`);
        }
      }
      if (socket.gameCode !== gameCode) return; // joined another game meanwhile

      socket.to(room).emit('player-joined', { userId: socket.userId, username: socket.username });

      // A seated player gets the match back (from memory, from the database after a restart, or a
      // fresh one for a game being played that has none), and is counted aboard.
      const team = socket.team;
      if (!team || !row) return;
      aboard(gameCode).set(socket.id, { team, roles: socket.roles, focus: null });
      const state = await playableState(gameCode, row);
      if (!state?.subs || socket.gameCode !== gameCode || socket.team !== team) return;
      startTicking(gameCode);
      socket.emit('game-state', engine.teamView(state, team, { contacts: true }));
    });

    on('select-team', async ({ gameCode, team }) => {
      const room = roomName(gameCode);
      if (!joined(gameCode)) return;
      if (!TEAMS.includes(team)) return;
      const gameResult = await db.query('SELECT id, status, game_mode FROM games WHERE code = $1', [gameCode]);
      const row = gameResult.rows[0];
      if (!row) return;
      // Team selection is a LOBBY action only. Allowing it mid-game would let any signed-in user
      // join the enemy team's room and receive their private view.
      if (row.status !== 'lobby') return socket.emit('action-rejected', { action: 'select-team', reason: 'game-started' });
      // Against the AI every person crews the same boat.
      if (modeOf(row.game_mode).vsAi && team !== 'alpha') return socket.emit('action-rejected', { action: 'select-team', reason: 'ai-boat', message: 'The other boat is the AI\'s.' });
      await db.query(
        `INSERT INTO game_players (game_id, user_id, team, roles, joined_at)
         VALUES ($1, $2, $3, 'unassigned', NOW())
         ON CONFLICT (game_id, user_id) DO UPDATE SET team = $3`,
        [row.id, socket.userId, team],
      );
      if (socket.team) socket.leave(`${room}:${socket.team}`);
      socket.team = team;
      socket.join(`${room}:${team}`);
      io.to(room).emit('team-updated', { userId: socket.userId, username: socket.username, team });
    });

    on('select-roles', async ({ gameCode, roles: picked }) => {
      const room = roomName(gameCode);
      if (!joined(gameCode)) return;
      const roles = pickStations(picked);
      if (!roles) return;
      const gameResult = await db.query('SELECT id, status FROM games WHERE code = $1', [gameCode]);
      if (gameResult.rows.length === 0) return;
      if (gameResult.rows[0].status !== 'lobby') return; // stations are picked in the lobby
      const seat = await db.query(
        `UPDATE game_players SET roles = $1 WHERE game_id = $2 AND user_id = $3 RETURNING user_id`,
        [roles.join(',') || 'unassigned', gameResult.rows[0].id, socket.userId],
      );
      // Stations come with a seat: someone who has not picked a team yet holds none.
      if (seat.rows.length === 0) return;
      socket.roles = roles;
      io.to(room).emit('roles-updated', { userId: socket.userId, username: socket.username, roles });
    });

    on('start-game', async ({ gameCode }) => {
      const room = roomName(gameCode);
      if (!joined(gameCode)) return;
      // Only the creator starts a game, and only from the lobby: a second start would wipe the match.
      const g = await db.query('SELECT id, status, created_by, game_mode, same_room FROM games WHERE code = $1', [gameCode]);
      const row = g.rows[0];
      if (!row) return;
      if (row.created_by !== socket.userId) return socket.emit('action-rejected', { action: 'start-game', reason: 'not-creator' });
      if (row.status !== 'lobby') return socket.emit('action-rejected', { action: 'start-game', reason: 'game-started' });
      const started = await db.query(`UPDATE games SET status = 'playing', started_at = NOW() WHERE code = $1 AND status = 'lobby' RETURNING id`, [gameCode]);
      if (started.rowCount === 0) return; // another start won the race
      const state = newMatch(gameCode, row, await crewOf(row.id));
      for (const team of TEAMS) io.to(`${room}:${team}`).emit('game-started', engine.teamView(state, team, { contacts: true }));
      startTicking(gameCode);
    });

    // Which of this player's stations is on their screen (the auto-crew covers their others).
    on('focus', async ({ gameCode, station }) => {
      if (!joined(gameCode) || !socket.team) return;
      const entry = aboard(gameCode).get(socket.id);
      if (entry) entry.focus = socket.roles.includes(station) ? station : null;
    });

    // ---- the stations ------------------------------------------------------
    on('helm', async ({ gameCode, heading, turn, speed }) => {
      const at = playAt(gameCode, 'helm', 'helm');
      if (!at) return;
      if (turn !== undefined) apply(socket, gameCode, at.state, engine.turn(at.state, at.team, turn));
      if (heading !== undefined) apply(socket, gameCode, at.state, engine.setHeading(at.state, at.team, heading));
      if (speed !== undefined) apply(socket, gameCode, at.state, engine.setSpeed(at.state, at.team, speed));
    });

    on('mark', async ({ gameCode, cell }) => {
      const at = playAt(gameCode, 'listener', 'mark');
      if (!at) return;
      if (cell !== null && !isCell(cell)) return;
      apply(socket, gameCode, at.state, engine.setMarker(at.state, at.team, cell === null ? null : { x: cell.x, y: cell.y }));
    });

    on('ping', async ({ gameCode }) => {
      const at = playAt(gameCode, 'listener', 'ping');
      if (!at) return;
      apply(socket, gameCode, at.state, engine.ping(at.state, at.team));
    });

    on('load', async ({ gameCode, tube }) => {
      const at = playAt(gameCode, 'weapons', 'load');
      if (!at || !isIndex(tube, 2)) return;
      apply(socket, gameCode, at.state, engine.loadTube(at.state, at.team, tube));
    });

    on('fire', async ({ gameCode, tube, target }) => {
      const at = playAt(gameCode, 'weapons', 'fire');
      if (!at || !isIndex(tube, 2) || !isCell(target)) return;
      apply(socket, gameCode, at.state, engine.fire(at.state, at.team, tube, { x: target.x, y: target.y }));
    });

    on('guide', async ({ gameCode, id, target }) => {
      const at = playAt(gameCode, 'weapons', 'guide');
      if (!at || !Number.isInteger(id) || !isCell(target)) return;
      apply(socket, gameCode, at.state, engine.guide(at.state, at.team, id, { x: target.x, y: target.y }));
    });

    on('decoy', async ({ gameCode, heading }) => {
      const at = playAt(gameCode, 'weapons', 'decoy');
      if (!at) return;
      apply(socket, gameCode, at.state, engine.launchDecoy(at.state, at.team, heading));
    });

    on('power', async ({ gameCode, power }) => {
      const at = playAt(gameCode, 'chief', 'power');
      if (!at || !power || typeof power !== 'object') return;
      apply(socket, gameCode, at.state, engine.setPower(at.state, at.team, { engines: power.engines, sonar: power.sonar, tubes: power.tubes }));
    });

    on('repair', async ({ gameCode, faultId }) => {
      const at = playAt(gameCode, 'chief', 'repair');
      if (!at || !Number.isInteger(faultId)) return;
      apply(socket, gameCode, at.state, engine.startRepair(at.state, at.team, faultId));
    });

    on('vent', async ({ gameCode }) => {
      const at = playAt(gameCode, 'chief', 'vent');
      if (!at) return;
      apply(socket, gameCode, at.state, engine.vent(at.state, at.team));
    });

    // A crew call goes from a station this player holds.
    on('call', async ({ gameCode, station, call }) => {
      if (!STATIONS.includes(station)) return;
      const at = playAt(gameCode, station, 'call');
      if (!at) return;
      apply(socket, gameCode, at.state, engine.call(at.state, at.team, station, call));
    });

    socket.on('disconnect', () => {
      if (socket.gameCode) {
        leaveGame(socket);
        socket.to(roomName(socket.gameCode)).emit('player-left', { userId: socket.userId, username: socket.username });
      }
    });
  });

  // For index.js: write what is waiting at shutdown, and let go of old matches now and then.
  return {
    flushMatches,
    sweepMatches,
    stop: () => clearInterval(clock),
    // for tests: run the clock by hand
    _tickAll: tickAll,
    _states: gameStates,
  };
}

module.exports = setupGameSockets;
