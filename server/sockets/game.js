// Socket.io adapter over the pure rules engine (server/game/engine.js).
// This file owns: auth, rooms, DB reads/writes, timers, automation, and mapping
// engine event lists to io emits. All game RULES live in the engine and are unit-tested.
const db = require('../config/database');
const { verifyToken } = require('../config/jwt');
const engine = require('../game/engine');
const { getSystemMax, DEFAULT_PRIORITY, REQUIRED_ROLES, TUNABLES } = require('../game/constants');
const { tokenBucket } = require('./rateLimit');

// In-memory game state, keyed by game code. Survives disconnects (not tied to a socket).
const gameStates = new Map();

const roomName = (code) => `game:${code}`;

// What a client may name: the stations a player picks (captain plus the crew, which are also
// the ones automation can run) and the systems the automated first mate charges. A list from
// the client keeps only these, each once, in its order; anything but an array gives null.
const ROLE_IDS = ['captain', ...REQUIRED_ROLES];
const pickFrom = (list, allowed) => (Array.isArray(list) ? [...new Set(list.filter((x) => allowed.includes(x)))] : null);

// Create or reuse a playable state, preserving automation/priority set in the lobby.
function ensurePlayableState(gameCode, mode = 'turn-based', sameRoom = false) {
  let state = gameStates.get(gameCode);
  if (state && state.submarines) return state;

  const prevAutomated = (state && state.automatedRoles) || {};
  const prevPriority = (state && state.systemPriority) || {};

  state = engine.initGameState(mode, sameRoom);
  state.automatedRoles = prevAutomated;
  state.systemPriority = prevPriority;
  if (prevAutomated.alpha) state.submarines.alpha.automatedRoles = prevAutomated.alpha;
  if (prevAutomated.bravo) state.submarines.bravo.automatedRoles = prevAutomated.bravo;

  gameStates.set(gameCode, state);
  return state;
}

function setupGameSockets(io) {
  // ---- emit helpers --------------------------------------------------------
  function emitEvents(socket, gameCode, events) {
    const room = roomName(gameCode);
    for (const e of events || []) {
      if (e.scope === 'room') io.to(room).emit(e.event, e.payload);
      else if (e.scope === 'team') io.to(`${room}:${e.team}`).emit(e.event, e.payload);
      else if (e.scope === 'actor') socket.emit(e.event, e.payload);
    }
    // Persist a finished game exactly once.
    const over = (events || []).find((e) => e.event === 'game-over');
    if (over) persistGameOver(gameCode, over.payload.winner);
  }

  function attachMeta(view, state, team) {
    view.automatedRoles = state.automatedRoles?.[team] || [];
    view.systemPriority = state.systemPriority?.[team] || DEFAULT_PRIORITY;
    return view;
  }

  function broadcastState(gameCode, state) {
    const room = roomName(gameCode);
    io.to(`${room}:alpha`).emit('game-state', attachMeta(engine.getTeamVisibleState(state, 'alpha'), state, 'alpha'));
    io.to(`${room}:bravo`).emit('game-state', attachMeta(engine.getTeamVisibleState(state, 'bravo'), state, 'bravo'));
  }

  // Run an engine action, emit its events (or an action-rejected), refresh state.
  function apply(socket, gameCode, state, result) {
    if (!result.ok) {
      socket.emit('action-rejected', result.error);
      return false;
    }
    emitEvents(socket, gameCode, result.events);
    broadcastState(gameCode, state);
    return true;
  }

  // ---- timers --------------------------------------------------------------
  function scheduleResurface(gameCode, state, team) {
    setTimeout(() => {
      try {
        const cur = gameStates.get(gameCode);
        if (!cur || !cur.submarines?.[team]?.surfaced) return;
        const r = engine.resurface(cur, team);
        emitEvents(null, gameCode, r.events);
        broadcastState(gameCode, cur);
      } catch (err) { console.error('resurface error:', err); }
    }, TUNABLES.SURFACE_SECONDS * 1000);
  }

  // `sonarId` pins this timeout to a specific ping so it can't auto-answer a newer one early.
  function scheduleSonarTimeout(gameCode, respondingTeam, sonarId) {
    setTimeout(() => {
      try {
        const cur = gameStates.get(gameCode);
        const sub = cur?.submarines?.[respondingTeam];
        if (!sub?.pendingSonar || sub.pendingSonar.id !== sonarId) return; // answered or superseded
        const facts = engine.autoSonarFacts(sub);
        const r = engine.resolveSonar(cur, respondingTeam, facts);
        emitEvents(null, gameCode, r.ok ? r.events : []);
        broadcastState(gameCode, cur);
      } catch (err) { console.error('sonar timeout error:', err); }
    }, TUNABLES.SONAR_RESPONSE_TIMEOUT_MS);
  }

  // Turn-based safety net: if a human role never confirms (e.g. disconnected), auto-confirm
  // the stragglers after a timeout so the captain isn't stuck forever. `seq` pins it to the
  // move it was scheduled for, so a stale watchdog can't force-confirm a newer turn early.
  function scheduleTurnWatchdog(gameCode, team, seq) {
    setTimeout(() => {
      try {
        const cur = gameStates.get(gameCode);
        const sub = cur?.submarines?.[team];
        if (!sub || !sub.awaitingConfirmation || sub.turnSeq !== seq) return;
        const all = [];
        for (const role of REQUIRED_ROLES) {
          if (!sub.awaitingConfirmation) break;
          if (!sub.confirmedRoles.includes(role)) all.push(...engine.confirmRole(cur, team, role).events);
        }
        emitEvents(null, gameCode, all);
        broadcastState(gameCode, cur);
      } catch (err) { console.error('watchdog error:', err); }
    }, TUNABLES.TURN_WATCHDOG_MS);
  }

  // Live safety net: if the engineer is an idle/disconnected human (not automated), the
  // breakdown queue would fill and permanently block the captain (backpressure cap). After a
  // timeout, drain the queue so the captain can keep moving instead of soft-deadlocking.
  function scheduleLiveEngineerWatchdog(gameCode, team) {
    setTimeout(() => {
      try {
        const cur = gameStates.get(gameCode);
        const sub = cur?.submarines?.[team];
        if (!cur || cur.mode !== 'live' || !sub || sub.breakdownQueue.length === 0) return;
        const all = [];
        while (sub.breakdownQueue.length > 0) {
          const dir = sub.breakdownQueue[0];
          const r = engine.markBreakdown(cur, team, dir, undefined, team);
          if (r.ok) { all.push(...r.events); sub.breakdownQueue.shift(); } else break;
        }
        emitEvents(null, gameCode, all);
        broadcastState(gameCode, cur);
      } catch (err) { console.error('live engineer watchdog error:', err); }
    }, TUNABLES.TURN_WATCHDOG_MS);
  }

  async function persistGameOver(gameCode, winner) {
    const state = gameStates.get(gameCode);
    if (state) {
      if (state.persisted) return;
      state.persisted = true;
    }
    try {
      // Only a game being played finishes: a result already recorded is never overwritten.
      await db.query(
        `UPDATE games SET status = 'finished', winner_team = $1, ended_at = NOW() WHERE code = $2 AND status = 'playing'`,
        [winner, gameCode],
      );
    } catch (err) { console.error('Failed to persist game result:', err); }
  }

  // ---- turn-based automation (drives the crew the humans didn't take) -------
  function findNextSystemToCharge(systems, priority) {
    for (const system of priority) {
      if ((systems[system] || 0) < getSystemMax(system)) return system;
    }
    return null;
  }

  // Drive whichever crew roles the humans left automated. Mode-aware: turn-based confirms
  // the loop; live drains the charge-token / breakdown-queue that a move just produced.
  function performAutomation(socket, gameCode, team, direction, state, automatedRoles) {
    const sub = state.submarines[team];
    if (!sub) return;
    const live = state.mode === 'live';
    const all = [];

    if (automatedRoles.includes('first-mate')) {
      const priority = state.systemPriority?.[team] || DEFAULT_PRIORITY;
      const system = findNextSystemToCharge(sub.systems, priority);
      if (system) {
        const r = engine.chargeSystem(state, team, system);
        if (r.ok) {
          all.push(...r.events);
          all.push({ scope: 'team', team, event: 'automation-action', payload: { role: 'first-mate', action: 'charged', details: { system } } });
        }
      }
      if (!live) all.push(...engine.confirmRole(state, team, 'first-mate').events);
    }

    if (automatedRoles.includes('engineer')) {
      const markDir = live ? sub.breakdownQueue[0] : direction;
      if (markDir) {
        const r = engine.markBreakdown(state, team, markDir, undefined, team);
        if (r.ok) {
          all.push(...r.events);
          all.push({ scope: 'team', team, event: 'automation-action', payload: { role: 'engineer', action: 'marked-damage', details: { direction: markDir } } });
          if (live) sub.breakdownQueue.shift();
        }
      }
      if (!live) all.push(...engine.confirmRole(state, team, 'engineer').events);
    }

    if (automatedRoles.includes('radio-operator') && !live) {
      all.push(...engine.confirmRole(state, team, 'radio-operator').events);
      all.push({ scope: 'team', team, event: 'automation-action', payload: { role: 'radio-operator', action: 'confirmed', details: {} } });
    }

    emitEvents(socket, gameCode, all);
    broadcastState(gameCode, state);
  }

  // ---- socket auth ---------------------------------------------------------
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth && socket.handshake.auth.token;
      if (!token) return next(new Error('Authentication required'));
      const payload = verifyToken(token);
      socket.userId = payload.id;
      socket.username = payload.username;
      next();
    } catch (err) {
      next(new Error('Invalid or expired session'));
    }
  });

  io.on('connection', (socket) => {
    console.log('Client connected:', socket.id, 'user', socket.userId);

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
    // joined. Only honour the team for that game, or a player seated in one game could steer
    // a submarine (or set up a team) in any other game by code.
    const teamIn = (gameCode) => (gameCode && gameCode === socket.gameCode ? socket.team : null);
    const joined = (gameCode) => Boolean(gameCode) && gameCode === socket.gameCode;

    on('join-game', async ({ gameCode }) => {
      if (typeof gameCode !== 'string' || !gameCode) return;
      const room = roomName(gameCode);
      // A socket plays one game at a time: drop the team it held in a previous game so it
      // can't carry over into a game this user isn't seated in.
      if (socket.gameCode && socket.gameCode !== gameCode) {
        const oldRoom = roomName(socket.gameCode);
        if (socket.team) socket.leave(`${oldRoom}:${socket.team}`);
        socket.leave(oldRoom);
      }
      socket.team = null;
      socket.roles = [];
      socket.join(room);
      socket.gameCode = gameCode;
      console.log(`${socket.username} joined game ${gameCode}`);

      const gameResult = await db.query('SELECT id FROM games WHERE code = $1', [gameCode]);
      if (gameResult.rows.length > 0) {
        const playerResult = await db.query(
          'SELECT team, roles FROM game_players WHERE game_id = $1 AND user_id = $2',
          [gameResult.rows[0].id, socket.userId],
        );
        if (playerResult.rows.length > 0) {
          socket.team = playerResult.rows[0].team;
          const rolesStr = playerResult.rows[0].roles || '';
          socket.roles = rolesStr.split(',').filter((r) => r && r !== 'unassigned');
          if (socket.team) socket.join(`${room}:${socket.team}`);
        }
      }

      socket.to(room).emit('player-joined', { userId: socket.userId, username: socket.username });

      const state = gameStates.get(gameCode);
      if (state && state.submarines && socket.team) {
        socket.emit('game-state', attachMeta(engine.getTeamVisibleState(state, socket.team), state, socket.team));
        // On reconnect, re-prompt an open sonar this player's team owes.
        if (state.submarines[socket.team].pendingSonar) {
          socket.emit('sonar-request', { askingTeam: state.submarines[socket.team].pendingSonar.askingTeam });
        }
      }
    });

    on('select-team', async ({ gameCode, team }) => {
      const room = roomName(gameCode);
      if (!joined(gameCode)) return;
      if (team !== 'alpha' && team !== 'bravo') return;
      const gameResult = await db.query('SELECT id, status FROM games WHERE code = $1', [gameCode]);
      if (gameResult.rows.length === 0) return;
      // Team selection is a LOBBY action only. Allowing it mid-game would let any authed user
      // join the enemy team's socket room and receive their private game-state.
      if (gameResult.rows[0].status !== 'lobby') return socket.emit('action-rejected', { action: 'select-team', reason: 'game-started' });
      const gameId = gameResult.rows[0].id;
      await db.query(
        `INSERT INTO game_players (game_id, user_id, team, roles, joined_at)
         VALUES ($1, $2, $3, 'unassigned', NOW())
         ON CONFLICT (game_id, user_id) DO UPDATE SET team = $3`,
        [gameId, socket.userId, team],
      );
      if (socket.team) socket.leave(`${room}:${socket.team}`);
      socket.team = team;
      socket.join(`${room}:${team}`);
      io.to(room).emit('team-updated', { userId: socket.userId, username: socket.username, team });
    });

    on('select-roles', async ({ gameCode, roles: picked }) => {
      const room = roomName(gameCode);
      if (!joined(gameCode)) return;
      const roles = pickFrom(picked, ROLE_IDS);
      if (!roles) return;
      const gameResult = await db.query('SELECT id, status FROM games WHERE code = $1', [gameCode]);
      if (gameResult.rows.length === 0) return;
      if (gameResult.rows[0].status !== 'lobby') return; // role assignment is a lobby action
      const rolesStr = roles.join(',');
      await db.query(
        `UPDATE game_players SET roles = $1 WHERE game_id = $2 AND user_id = $3`,
        [rolesStr, gameResult.rows[0].id, socket.userId],
      );
      socket.roles = roles;
      io.to(room).emit('roles-updated', { userId: socket.userId, username: socket.username, roles });
    });

    on('set-automated-roles', async ({ gameCode, team, automatedRoles: picked }) => {
      const room = roomName(gameCode);
      if (team !== 'alpha' && team !== 'bravo') return;
      if (teamIn(gameCode) !== team) return; // only configure your own team, in your own game
      const automatedRoles = pickFrom(picked, REQUIRED_ROLES); // the captain is never automated
      if (!automatedRoles) return;
      let state = gameStates.get(gameCode);
      if (!state) { state = { automatedRoles: {}, systemPriority: {} }; gameStates.set(gameCode, state); }
      if (!state.automatedRoles) state.automatedRoles = {};
      state.automatedRoles[team] = automatedRoles;
      if (state.submarines && state.submarines[team]) state.submarines[team].automatedRoles = automatedRoles;
      io.to(room).emit('automated-roles-updated', { team, automatedRoles });
    });

    on('set-system-priority', async ({ gameCode, team, systemPriority: picked }) => {
      if (team !== 'alpha' && team !== 'bravo') return;
      if (teamIn(gameCode) !== team) return; // only configure your own team, in your own game
      const systemPriority = pickFrom(picked, DEFAULT_PRIORITY);
      if (!systemPriority) return;
      let state = gameStates.get(gameCode);
      if (!state) { state = { systemPriority: {} }; gameStates.set(gameCode, state); }
      if (!state.systemPriority) state.systemPriority = {};
      state.systemPriority[team] = systemPriority;
    });

    on('start-game', async ({ gameCode }) => {
      const room = roomName(gameCode);
      if (!joined(gameCode)) return;
      // Only the creator starts a game (the Lobby only shows them the button), and only from
      // the lobby: a second start-game would wipe the match in progress.
      const g = await db.query('SELECT status, created_by, game_mode, same_room FROM games WHERE code = $1', [gameCode]);
      if (g.rows.length === 0) return;
      if (g.rows[0].created_by !== socket.userId) return socket.emit('action-rejected', { action: 'start-game', reason: 'not-creator' });
      if (g.rows[0].status !== 'lobby') return socket.emit('action-rejected', { action: 'start-game', reason: 'game-started' });
      const mode = g.rows[0].game_mode || 'turn-based';
      const sameRoom = !!g.rows[0].same_room;
      try {
        await db.query(`UPDATE games SET status = 'playing', started_at = NOW() WHERE code = $1`, [gameCode]);
      } catch (err) { console.error('start-game DB error:', err); }

      const existing = gameStates.get(gameCode);
      const automatedRoles = existing?.automatedRoles || {};
      const systemPriority = existing?.systemPriority || {};

      const state = engine.initGameState(mode, sameRoom);
      state.automatedRoles = automatedRoles;
      state.systemPriority = systemPriority;
      if (automatedRoles.alpha) state.submarines.alpha.automatedRoles = automatedRoles.alpha;
      if (automatedRoles.bravo) state.submarines.bravo.automatedRoles = automatedRoles.bravo;
      gameStates.set(gameCode, state);

      io.to(`${room}:alpha`).emit('game-started', attachMeta(engine.getTeamVisibleState(state, 'alpha'), state, 'alpha'));
      io.to(`${room}:bravo`).emit('game-started', attachMeta(engine.getTeamVisibleState(state, 'bravo'), state, 'bravo'));
    });

    // ---- captain: move -----------------------------------------------------
    on('captain-move', async ({ gameCode, direction }) => {
      const team = teamIn(gameCode);
      if (!team) return;
      if (!['N', 'S', 'E', 'W'].includes(direction)) return;
      let state = gameStates.get(gameCode);
      if (!state?.submarines) {
        // No match in memory: the server restarted (every deploy does) or the game never
        // started. Only a game the database says is being played gets a fresh board, in the
        // mode it was made with. A lobby or finished game is not played here: a finished one
        // would otherwise be replayed and its stored winner overwritten.
        const g = await db.query('SELECT status, game_mode, same_room FROM games WHERE code = $1', [gameCode]);
        const row = g.rows[0];
        if (!row || row.status !== 'playing') return socket.emit('action-rejected', { action: 'move', reason: 'not-playing' });
        state = ensurePlayableState(gameCode, row.game_mode === 'live' ? 'live' : 'turn-based', !!row.same_room);
      }
      const sub = state.submarines[team];
      if (!sub) return;

      // Trapped (no legal move) -> forced surface.
      if (engine.legalMoves(state, team).length === 0 && !sub.surfaced) {
        const r = engine.surface(state, team, { forced: true });
        if (apply(socket, gameCode, state, r)) scheduleResurface(gameCode, state, team);
        return;
      }

      const r = engine.applyMove(state, team, direction);
      if (!apply(socket, gameCode, state, r)) return;

      const automatedRoles = state.automatedRoles?.[team] || sub.automatedRoles || [];
      if (automatedRoles.length > 0) {
        setTimeout(() => {
          try { performAutomation(socket, gameCode, team, direction, state, automatedRoles); }
          catch (err) { console.error('automation error:', err); }
        }, TUNABLES.AUTOMATION_DELAY_MS);
      }
      if (state.mode !== 'live') {
        scheduleTurnWatchdog(gameCode, team, sub.turnSeq);
      } else if (!automatedRoles.includes('engineer')) {
        // Human engineer in live mode: keep the breakdown queue from soft-deadlocking the captain.
        scheduleLiveEngineerWatchdog(gameCode, team);
      }
    });

    // ---- crew: confirm / charge / mark ------------------------------------
    on('aye-captain', async ({ gameCode, role }) => {
      const team = teamIn(gameCode);
      if (!team) return;
      const state = gameStates.get(gameCode);
      if (!state?.submarines?.[team]) return;
      apply(socket, gameCode, state, engine.confirmRole(state, team, role));
    });

    on('charge-system', async ({ gameCode, system }) => {
      const team = teamIn(gameCode);
      if (!team) return;
      const state = gameStates.get(gameCode);
      if (!state?.submarines?.[team]) return;
      apply(socket, gameCode, state, engine.chargeSystem(state, team, system));
    });

    on('mark-damage', async ({ gameCode, slotId }) => {
      const team = teamIn(gameCode);
      if (!team) return;
      const state = gameStates.get(gameCode);
      const sub = state?.submarines?.[team];
      if (!sub) return;
      const direction = state.mode === 'live' ? sub.breakdownQueue[0] : sub.lastMoveDir;
      if (!direction) return;
      const r = engine.markBreakdown(state, team, direction, slotId, team);
      if (apply(socket, gameCode, state, r) && state.mode === 'live') sub.breakdownQueue.shift();
    });

    // ---- captain: systems --------------------------------------------------
    on('fire-torpedo', async ({ gameCode, target }) => {
      const team = teamIn(gameCode);
      if (!team || !target || typeof target.x !== 'number' || typeof target.y !== 'number') return;
      const state = gameStates.get(gameCode);
      if (!state?.submarines?.[team]) return;
      apply(socket, gameCode, state, engine.fireTorpedo(state, team, target));
    });

    on('place-mine', async ({ gameCode, target }) => {
      const team = teamIn(gameCode);
      if (!team || !target || typeof target.x !== 'number' || typeof target.y !== 'number') return;
      const state = gameStates.get(gameCode);
      if (!state?.submarines?.[team]) return;
      apply(socket, gameCode, state, engine.placeMine(state, team, target));
    });

    on('detonate-mine', async ({ gameCode, target }) => {
      const team = teamIn(gameCode);
      if (!team || !target || typeof target.x !== 'number' || typeof target.y !== 'number') return;
      const state = gameStates.get(gameCode);
      if (!state?.submarines?.[team]) return;
      apply(socket, gameCode, state, engine.detonateMine(state, team, target));
    });

    on('launch-drone', async ({ gameCode, sector }) => {
      const team = teamIn(gameCode);
      if (!team) return;
      const state = gameStates.get(gameCode);
      if (!state?.submarines?.[team]) return;
      apply(socket, gameCode, state, engine.launchDrone(state, team, sector));
    });

    on('use-sonar', async ({ gameCode }) => {
      const team = teamIn(gameCode);
      if (!team) return;
      const state = gameStates.get(gameCode);
      if (!state?.submarines?.[team]) return;
      const enemyTeam = engine.enemyOf(team);
      if (apply(socket, gameCode, state, engine.useSonar(state, team))) {
        scheduleSonarTimeout(gameCode, enemyTeam, state.submarines[enemyTeam].pendingSonar?.id);
      }
    });

    on('sonar-response', async ({ gameCode, facts }) => {
      const team = teamIn(gameCode);
      if (!team) return;
      const state = gameStates.get(gameCode);
      if (!state?.submarines?.[team]) return;
      apply(socket, gameCode, state, engine.resolveSonar(state, team, facts));
    });

    on('use-silence', async ({ gameCode, direction, distance }) => {
      const team = teamIn(gameCode);
      if (!team) return;
      const state = gameStates.get(gameCode);
      if (!state?.submarines?.[team]) return;
      apply(socket, gameCode, state, engine.applySilence(state, team, direction, Number(distance)));
    });

    on('surface', async ({ gameCode }) => {
      const team = teamIn(gameCode);
      if (!team) return;
      const state = gameStates.get(gameCode);
      if (!state?.submarines?.[team]) return;
      const r = engine.surface(state, team);
      if (apply(socket, gameCode, state, r)) scheduleResurface(gameCode, state, team);
    });

    socket.on('disconnect', () => {
      if (socket.gameCode) {
        socket.to(roomName(socket.gameCode)).emit('player-left', {
          userId: socket.userId, username: socket.username,
        });
      }
      console.log('Client disconnected:', socket.id);
    });
  });
}

module.exports = setupGameSockets;
