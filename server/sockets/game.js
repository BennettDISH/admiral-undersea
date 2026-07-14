const db = require('../config/database');
const { verifyToken } = require('../config/jwt');

// In-memory game state (for real-time updates)
const gameStates = new Map();

// Default system priority for First Mate automation
const DEFAULT_PRIORITY = ['torpedo', 'mine', 'drone', 'sonar', 'silence'];

// Return an existing playable state (one with submarines) or create a fresh one,
// preserving any automation/priority that was configured in the lobby before start.
// Single-sourcing init here kills the partial-state crashes: set-automated-roles /
// set-system-priority can create a submarine-less state, and every downstream handler
// used to assume submarines existed.
function ensurePlayableState(gameCode) {
  let state = gameStates.get(gameCode);
  if (state && state.submarines) return state;

  const prevAutomated = (state && state.automatedRoles) || {};
  const prevPriority = (state && state.systemPriority) || {};

  state = initGameState();
  state.automatedRoles = prevAutomated;
  state.systemPriority = prevPriority;
  if (prevAutomated.alpha) state.submarines.alpha.automatedRoles = prevAutomated.alpha;
  if (prevAutomated.bravo) state.submarines.bravo.automatedRoles = prevAutomated.bravo;

  gameStates.set(gameCode, state);
  return state;
}

function setupGameSockets(io) {
  // Socket authentication: every connection must present the same signed session
  // token the REST API uses. This replaces trusting a client-supplied user id.
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

    // Wrap every handler so a throw logs instead of crashing the socket/process.
    const on = (event, handler) => {
      socket.on(event, async (payload) => {
        try {
          await handler(payload || {});
        } catch (err) {
          console.error(`socket '${event}' handler error:`, err);
        }
      });
    };

    // Join a game room
    on('join-game', async ({ gameCode }) => {
      const roomName = `game:${gameCode}`;
      const userId = socket.userId;
      const username = socket.username;
      socket.join(roomName);
      socket.gameCode = gameCode;

      console.log(`${username} joined game ${gameCode}`);

      // Look up existing team/roles from database
      const gameResult = await db.query('SELECT id FROM games WHERE code = $1', [gameCode]);
      if (gameResult.rows.length > 0) {
        const playerResult = await db.query(
          'SELECT team, role, roles FROM game_players WHERE game_id = $1 AND user_id = $2',
          [gameResult.rows[0].id, userId]
        );
        if (playerResult.rows.length > 0) {
          socket.team = playerResult.rows[0].team;
          // Parse roles - use roles column if available, fall back to role
          const rolesStr = playerResult.rows[0].roles || playerResult.rows[0].role || '';
          socket.roles = rolesStr.split(',').filter(r => r && r !== 'unassigned');
          // Join team-specific room for targeted messages
          if (socket.team) {
            socket.join(`${roomName}:${socket.team}`);
          }
        }
      }

      // Notify others in the room
      socket.to(roomName).emit('player-joined', { userId, username });

      // Send current game state if a playable one exists (filtered for this team)
      const state = gameStates.get(gameCode);
      if (state && state.submarines && socket.team) {
        const visibleState = getTeamVisibleState(state, socket.team);
        visibleState.automatedRoles = state.automatedRoles?.[socket.team] || [];
        visibleState.systemPriority = state.systemPriority?.[socket.team] || DEFAULT_PRIORITY;
        socket.emit('game-state', visibleState);
      }
    });

    // Select team
    on('select-team', async ({ gameCode, team }) => {
      const roomName = `game:${gameCode}`;
      const userId = socket.userId;

      if (team !== 'alpha' && team !== 'bravo') return;

      const gameResult = await db.query('SELECT id FROM games WHERE code = $1', [gameCode]);
      if (gameResult.rows.length === 0) return;

      const gameId = gameResult.rows[0].id;

      // Update or insert player
      await db.query(
        `INSERT INTO game_players (game_id, user_id, team, role, joined_at)
         VALUES ($1, $2, $3, 'unassigned', NOW())
         ON CONFLICT (game_id, user_id)
         DO UPDATE SET team = $3`,
        [gameId, userId, team]
      );

      // Leave old team room, join new team room
      if (socket.team) {
        socket.leave(`${roomName}:${socket.team}`);
      }
      socket.team = team;
      socket.join(`${roomName}:${team}`);

      // Broadcast team update
      io.to(roomName).emit('team-updated', { userId, username: socket.username, team });
    });

    // Select roles (multiple)
    on('select-roles', async ({ gameCode, roles }) => {
      const roomName = `game:${gameCode}`;
      const userId = socket.userId;

      if (!Array.isArray(roles)) return;

      const gameResult = await db.query('SELECT id FROM games WHERE code = $1', [gameCode]);
      if (gameResult.rows.length === 0) return;

      const gameId = gameResult.rows[0].id;

      // Store roles as comma-separated string (role kept in sync for legacy reads)
      const rolesStr = roles.join(',');

      await db.query(
        `UPDATE game_players SET role = $1, roles = $1 WHERE game_id = $2 AND user_id = $3`,
        [rolesStr, gameId, userId]
      );

      socket.roles = roles;

      io.to(roomName).emit('roles-updated', { userId, username: socket.username, roles });
    });

    // Set automated roles for a team
    on('set-automated-roles', async ({ gameCode, team, automatedRoles }) => {
      const roomName = `game:${gameCode}`;
      if (team !== 'alpha' && team !== 'bravo') return;

      // Store in game state (does NOT create submarines — ensurePlayableState preserves this)
      let state = gameStates.get(gameCode);
      if (!state) {
        state = { automatedRoles: {}, systemPriority: {} };
        gameStates.set(gameCode, state);
      }
      if (!state.automatedRoles) state.automatedRoles = {};
      state.automatedRoles[team] = automatedRoles;

      // Also update the submarine's automatedRoles array if the game is live
      if (state.submarines && state.submarines[team]) {
        state.submarines[team].automatedRoles = automatedRoles;
      }

      io.to(roomName).emit('automated-roles-updated', { team, automatedRoles });
    });

    // Set system priority for auto-charging (First Mate automation)
    on('set-system-priority', async ({ gameCode, team, systemPriority }) => {
      if (team !== 'alpha' && team !== 'bravo') return;
      let state = gameStates.get(gameCode);
      if (!state) {
        state = { systemPriority: {} };
        gameStates.set(gameCode, state);
      }
      if (!state.systemPriority) state.systemPriority = {};
      state.systemPriority[team] = systemPriority;
    });

    // Captain moves
    on('captain-move', async ({ gameCode, direction }) => {
      const roomName = `game:${gameCode}`;
      const team = socket.team;
      if (!team) return;
      if (!['N', 'S', 'E', 'W'].includes(direction)) return;

      const state = ensurePlayableState(gameCode);
      const sub = state.submarines[team];
      if (!sub) return;

      // Server-side pacing: cannot move again until the crew has confirmed the last move.
      if (sub.awaitingConfirmation) return;

      // Update submarine position
      const newPos = { ...sub.position };
      switch (direction) {
        case 'N': newPos.y -= 1; break;
        case 'S': newPos.y += 1; break;
        case 'E': newPos.x += 1; break;
        case 'W': newPos.x -= 1; break;
      }

      // Add to path
      sub.path.push({ ...sub.position });
      sub.position = newPos;
      sub.awaitingConfirmation = true;
      sub.confirmedRoles = [];
      sub.chargedThisMove = false;

      // Send updated game state to the team that moved (filtered)
      io.to(`${roomName}:${team}`).emit('game-state', getTeamVisibleState(state, team));

      // Broadcast move announcement to everyone
      io.to(roomName).emit('move-announced', {
        team,
        direction,
        awaitingConfirmation: true
      });

      // Play sound for enemy team's radio operator only
      const enemyTeam = team === 'alpha' ? 'bravo' : 'alpha';
      io.to(`${roomName}:${enemyTeam}`).emit('play-move-sound', { team, direction });

      // Handle automation after a short delay to let UI update
      const automatedRoles = state.automatedRoles?.[team] || sub.automatedRoles || [];
      if (automatedRoles.length > 0) {
        setTimeout(() => {
          try {
            performAutomation(io, gameCode, team, direction, state, automatedRoles);
          } catch (err) {
            console.error('automation error:', err);
          }
        }, 500);
      }
    });

    // Role confirms (Aye Captain)
    on('aye-captain', async ({ gameCode, role }) => {
      const roomName = `game:${gameCode}`;
      const team = socket.team;
      if (!team) return;

      const state = gameStates.get(gameCode);
      const sub = state?.submarines?.[team];
      if (!sub) return;

      if (!sub.confirmedRoles.includes(role)) {
        sub.confirmedRoles.push(role);
      }

      io.to(roomName).emit('role-confirmed', { team, role, userId: socket.userId });

      // Check if all required roles confirmed
      const requiredRoles = ['first-mate', 'engineer', 'radio-operator'];
      const allConfirmed = requiredRoles.every(r =>
        sub.confirmedRoles.includes(r) || sub.automatedRoles.includes(r)
      );

      if (allConfirmed) {
        sub.awaitingConfirmation = false;
        sub.confirmedRoles = [];
        io.to(roomName).emit('turn-complete', { team });
      }
    });

    // Engineer marks damage
    on('mark-damage', async ({ gameCode, slotId, direction }) => {
      const roomName = `game:${gameCode}`;
      const team = socket.team;
      if (!team) return;

      const state = gameStates.get(gameCode);
      const sub = state?.submarines?.[team];
      if (!sub) return;

      // Track damage in game state (could affect systems later)
      if (!sub.damage) sub.damage = [];
      sub.damage.push({ slotId, direction });

      // Notify team that damage was marked
      io.to(`${roomName}:${team}`).emit('damage-marked', { team, slotId, direction });
    });

    // First mate charges system
    on('charge-system', async ({ gameCode, system }) => {
      const roomName = `game:${gameCode}`;
      const team = socket.team;
      if (!team) return;

      const state = gameStates.get(gameCode);
      const sub = state?.submarines?.[team];
      if (!sub) return;

      // Charging is tied to a move: exactly one system per confirmed move.
      if (!sub.awaitingConfirmation) return;
      if (sub.chargedThisMove) return;
      if (sub.systems[system] === undefined) return;

      sub.systems[system] = Math.min(sub.systems[system] + 1, getSystemMax(system));
      sub.chargedThisMove = true;

      // Only notify own team about system charging
      io.to(`${roomName}:${team}`).emit('system-charged', { team, system, value: sub.systems[system] });
      io.to(`${roomName}:${team}`).emit('game-state', getTeamVisibleState(state, team));
    });

    // Fire torpedo
    on('fire-torpedo', async ({ gameCode, target }) => {
      const roomName = `game:${gameCode}`;
      const team = socket.team;
      if (!team) return;
      if (!target || typeof target.x !== 'number' || typeof target.y !== 'number') return;

      const state = gameStates.get(gameCode);
      const sub = state?.submarines?.[team];
      if (!sub) return;
      if (sub.systems.torpedo < 3) return; // Not charged

      const enemyTeam = team === 'alpha' ? 'bravo' : 'alpha';
      const enemySub = state.submarines[enemyTeam];
      if (!enemySub) return;

      sub.systems.torpedo = 0;

      // Reflect the spent torpedo on the firing team's own UI (resets the FIRE affordance).
      io.to(`${roomName}:${team}`).emit('game-state', getTeamVisibleState(state, team));

      // Check for hit
      const distance = Math.abs(target.x - enemySub.position.x) + Math.abs(target.y - enemySub.position.y);

      let damage = 0;
      if (distance === 0) damage = 2; // Direct hit
      else if (distance === 1) damage = 1; // Adjacent hit

      if (damage > 0) {
        enemySub.health = Math.max(0, enemySub.health - damage);
        io.to(roomName).emit('torpedo-hit', { team, target, damage, enemyHealth: enemySub.health });

        if (enemySub.health <= 0) {
          state.winner = team;
          io.to(roomName).emit('game-over', { winner: team });
          try {
            await db.query(
              `UPDATE games SET status = 'finished', winner_team = $1, ended_at = NOW() WHERE code = $2`,
              [team, gameCode]
            );
          } catch (err) {
            console.error('Failed to persist game result:', err);
          }
        }
      } else {
        io.to(roomName).emit('torpedo-miss', { team, target });
      }
    });

    // Start game
    on('start-game', async ({ gameCode }) => {
      const roomName = `game:${gameCode}`;

      await db.query(
        `UPDATE games SET status = 'playing', started_at = NOW() WHERE code = $1`,
        [gameCode]
      );

      // Preserve any automation settings from lobby
      const existingState = gameStates.get(gameCode);
      const automatedRoles = existingState?.automatedRoles || {};
      const systemPriority = existingState?.systemPriority || {};

      const state = initGameState();
      state.automatedRoles = automatedRoles;
      state.systemPriority = systemPriority;

      // Apply automation settings to submarines
      if (automatedRoles.alpha) {
        state.submarines.alpha.automatedRoles = automatedRoles.alpha;
      }
      if (automatedRoles.bravo) {
        state.submarines.bravo.automatedRoles = automatedRoles.bravo;
      }

      gameStates.set(gameCode, state);

      // Send filtered state to each team, including their automation settings
      const alphaState = getTeamVisibleState(state, 'alpha');
      alphaState.automatedRoles = automatedRoles.alpha || [];
      alphaState.systemPriority = systemPriority.alpha || DEFAULT_PRIORITY;

      const bravoState = getTeamVisibleState(state, 'bravo');
      bravoState.automatedRoles = automatedRoles.bravo || [];
      bravoState.systemPriority = systemPriority.bravo || DEFAULT_PRIORITY;

      io.to(`${roomName}:alpha`).emit('game-started', alphaState);
      io.to(`${roomName}:bravo`).emit('game-started', bravoState);
    });

    socket.on('disconnect', () => {
      if (socket.gameCode) {
        const roomName = `game:${socket.gameCode}`;
        socket.to(roomName).emit('player-left', {
          userId: socket.userId,
          username: socket.username
        });
      }
      console.log('Client disconnected:', socket.id);
    });
  });
}

function initGameState() {
  return {
    submarines: {
      alpha: {
        position: { x: 1, y: 1 },
        path: [],
        health: 4,
        systems: {
          torpedo: 0,
          mine: 0,
          drone: 0,
          sonar: 0,
          silence: 0
        },
        awaitingConfirmation: false,
        confirmedRoles: [],
        automatedRoles: [],
        chargedThisMove: false,
        damage: []
      },
      bravo: {
        position: { x: 14, y: 9 },
        path: [],
        health: 4,
        systems: {
          torpedo: 0,
          mine: 0,
          drone: 0,
          sonar: 0,
          silence: 0
        },
        awaitingConfirmation: false,
        confirmedRoles: [],
        automatedRoles: [],
        chargedThisMove: false,
        damage: []
      }
    },
    currentTurn: 'alpha',
    winner: null
  };
}

function getSystemMax(system) {
  const maxValues = {
    torpedo: 3,
    mine: 3,
    drone: 4,
    sonar: 3,
    silence: 6
  };
  return maxValues[system] || 3;
}

// Filter game state to only show what a team should see
function getTeamVisibleState(state, team) {
  const enemyTeam = team === 'alpha' ? 'bravo' : 'alpha';

  return {
    submarines: {
      [team]: state.submarines[team], // Full info for own sub
      [enemyTeam]: {
        // Only show enemy health (they announce damage)
        health: state.submarines[enemyTeam].health,
        // Hide position, path, and systems
        position: null,
        path: [],
        systems: {}
      }
    },
    currentTurn: state.currentTurn,
    winner: state.winner
  };
}

// Engineer circuit board - based on Captain Sonar rules
const ENGINEER_SLOTS = [
  // North section (4 slots)
  { id: 'n1', dir: 'N', system: 'torpedo', circuit: 'A' },
  { id: 'n2', dir: 'N', system: 'mine', circuit: 'B' },
  { id: 'n3', dir: 'N', system: 'drone', circuit: 'C' },
  { id: 'n4', dir: 'N', system: 'sonar', circuit: 'D' },
  // South section (4 slots)
  { id: 's1', dir: 'S', system: 'silence', circuit: 'A' },
  { id: 's2', dir: 'S', system: 'torpedo', circuit: 'B' },
  { id: 's3', dir: 'S', system: 'mine', circuit: 'C' },
  { id: 's4', dir: 'S', system: 'drone', circuit: 'D' },
  // East section (4 slots)
  { id: 'e1', dir: 'E', system: 'sonar', circuit: 'A' },
  { id: 'e2', dir: 'E', system: 'silence', circuit: 'B' },
  { id: 'e3', dir: 'E', system: 'torpedo', circuit: 'C' },
  { id: 'e4', dir: 'E', system: 'mine', circuit: 'D' },
  // West section (4 slots)
  { id: 'w1', dir: 'W', system: 'drone', circuit: 'A' },
  { id: 'w2', dir: 'W', system: 'sonar', circuit: 'B' },
  { id: 'w3', dir: 'W', system: 'silence', circuit: 'C' },
  { id: 'w4', dir: 'W', system: 'mine', circuit: 'D' },
];

// Circuits - when all 4 slots in a circuit are marked, they auto-clear
const CIRCUITS = {
  A: ['n1', 's1', 'e1', 'w1'],
  B: ['n2', 's2', 'e2', 'w2'],
  C: ['n3', 's3', 'e3', 'w3'],
  D: ['n4', 's4', 'e4', 'w4'],
};

const getSlotsForDirection = (dir) => ENGINEER_SLOTS.filter(s => s.dir === dir);

// Perform automated actions after captain moves
function performAutomation(io, gameCode, team, direction, state, automatedRoles) {
  const roomName = `game:${gameCode}`;
  const sub = state.submarines[team];
  if (!sub) return;

  // First Mate automation - charge system based on priority
  if (automatedRoles.includes('first-mate')) {
    const priority = state.systemPriority?.[team] || DEFAULT_PRIORITY;
    const systemToCharge = findNextSystemToCharge(sub.systems, priority);

    if (systemToCharge) {
      sub.systems[systemToCharge] = Math.min(sub.systems[systemToCharge] + 1, getSystemMax(systemToCharge));
      sub.chargedThisMove = true;
      io.to(`${roomName}:${team}`).emit('system-charged', {
        team,
        system: systemToCharge,
        value: sub.systems[systemToCharge]
      });
      io.to(`${roomName}:${team}`).emit('automation-action', {
        role: 'first-mate',
        action: 'charged',
        details: { system: systemToCharge }
      });
    }

    // Auto-confirm first mate
    if (!sub.confirmedRoles.includes('first-mate')) {
      sub.confirmedRoles.push('first-mate');
      io.to(roomName).emit('role-confirmed', { team, role: 'first-mate', userId: 'auto' });
    }
  }

  // Engineer automation - mark damage and check circuit completion
  if (automatedRoles.includes('engineer')) {
    const dirSlots = getSlotsForDirection(direction);
    if (!sub.damage) sub.damage = [];
    const damagedSlotIds = sub.damage.map(d => d.slotId);

    // Find first available slot in this direction
    const availableSlot = dirSlots.find(s => !damagedSlotIds.includes(s.id));
    if (availableSlot) {
      sub.damage.push({ slotId: availableSlot.id, direction });
      const newDamagedIds = sub.damage.map(d => d.slotId);

      // Check for completed circuits
      const completedCircuits = [];
      Object.entries(CIRCUITS).forEach(([circuitId, slotIds]) => {
        if (slotIds.every(id => newDamagedIds.includes(id))) {
          completedCircuits.push(circuitId);
        }
      });

      // Clear completed circuits
      if (completedCircuits.length > 0) {
        const slotsToRemove = completedCircuits.flatMap(c => CIRCUITS[c]);
        sub.damage = sub.damage.filter(d => !slotsToRemove.includes(d.slotId));
      }

      io.to(`${roomName}:${team}`).emit('damage-marked', {
        team,
        slotId: availableSlot.id,
        direction,
        completedCircuits,
        finalDamagedSlots: sub.damage.map(d => d.slotId)
      });
      io.to(`${roomName}:${team}`).emit('automation-action', {
        role: 'engineer',
        action: 'marked-damage',
        details: { slotId: availableSlot.id, direction, completedCircuits }
      });
    }

    // Auto-confirm engineer
    if (!sub.confirmedRoles.includes('engineer')) {
      sub.confirmedRoles.push('engineer');
      io.to(roomName).emit('role-confirmed', { team, role: 'engineer', userId: 'auto' });
    }
  }

  // Radio Operator automation - just auto-confirm (no action needed)
  if (automatedRoles.includes('radio-operator')) {
    if (!sub.confirmedRoles.includes('radio-operator')) {
      sub.confirmedRoles.push('radio-operator');
      io.to(roomName).emit('role-confirmed', { team, role: 'radio-operator', userId: 'auto' });
      io.to(`${roomName}:${team}`).emit('automation-action', {
        role: 'radio-operator',
        action: 'confirmed',
        details: {}
      });
    }
  }

  // Check if all required roles are now confirmed
  const requiredRoles = ['first-mate', 'engineer', 'radio-operator'];
  const allConfirmed = requiredRoles.every(r =>
    sub.confirmedRoles.includes(r) || automatedRoles.includes(r)
  );

  if (allConfirmed) {
    sub.awaitingConfirmation = false;
    sub.confirmedRoles = [];
    io.to(roomName).emit('turn-complete', { team });
  }

  // Send updated game state
  io.to(`${roomName}:${team}`).emit('game-state', getTeamVisibleState(state, team));
}

// Find next system to charge based on priority
function findNextSystemToCharge(systems, priority) {
  for (const system of priority) {
    if ((systems[system] || 0) < getSystemMax(system)) {
      return system;
    }
  }
  return null;
}

module.exports = setupGameSockets;
