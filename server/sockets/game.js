const db = require('../config/database');

// In-memory game state (for real-time updates)
const gameStates = new Map();

function setupGameSockets(io) {
  io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    // Join a game room
    socket.on('join-game', async ({ gameCode, userId, username }) => {
      const roomName = `game:${gameCode}`;
      socket.join(roomName);
      socket.gameCode = gameCode;
      socket.userId = userId;
      socket.username = username;

      console.log(`${username} joined game ${gameCode}`);

      // Look up existing team/roles from database
      try {
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
      } catch (error) {
        console.error('Error loading player data:', error);
      }

      // Notify others in the room
      socket.to(roomName).emit('player-joined', { userId, username });

      // Send current game state if exists (filtered for this team)
      if (gameStates.has(gameCode) && socket.team) {
        socket.emit('game-state', getTeamVisibleState(gameStates.get(gameCode), socket.team));
      }
    });

    // Select team
    socket.on('select-team', async ({ gameCode, userId, team }) => {
      const roomName = `game:${gameCode}`;

      try {
        // Get game ID
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
      } catch (error) {
        console.error('Select team error:', error);
      }
    });

    // Select roles (multiple)
    socket.on('select-roles', async ({ gameCode, userId, roles }) => {
      const roomName = `game:${gameCode}`;

      try {
        const gameResult = await db.query('SELECT id FROM games WHERE code = $1', [gameCode]);
        if (gameResult.rows.length === 0) return;

        const gameId = gameResult.rows[0].id;

        // Store roles as comma-separated string
        const rolesStr = roles.join(',');

        await db.query(
          `UPDATE game_players SET role = $1, roles = $1 WHERE game_id = $2 AND user_id = $3`,
          [rolesStr, gameId, userId]
        );

        socket.roles = roles;

        io.to(roomName).emit('roles-updated', { userId, username: socket.username, roles });
      } catch (error) {
        console.error('Select roles error:', error);
      }
    });

    // Set automated roles for a team
    socket.on('set-automated-roles', async ({ gameCode, team, automatedRoles }) => {
      const roomName = `game:${gameCode}`;

      // Store in game state
      let state = gameStates.get(gameCode);
      if (!state) {
        state = { automatedRoles: {} };
        gameStates.set(gameCode, state);
      }
      if (!state.automatedRoles) state.automatedRoles = {};
      state.automatedRoles[team] = automatedRoles;

      io.to(roomName).emit('automated-roles-updated', { team, automatedRoles });
    });

    // Captain moves
    socket.on('captain-move', ({ gameCode, direction }) => {
      const roomName = `game:${gameCode}`;

      let state = gameStates.get(gameCode);
      if (!state) {
        state = initGameState();
        gameStates.set(gameCode, state);
      }

      const team = socket.team;
      if (!team) return;

      // Update submarine position
      const sub = state.submarines[team];
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
    });

    // Role confirms (Aye Captain)
    socket.on('aye-captain', ({ gameCode, role }) => {
      const roomName = `game:${gameCode}`;

      const state = gameStates.get(gameCode);
      if (!state) return;

      const team = socket.team;
      if (!team) return;

      const sub = state.submarines[team];
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
    socket.on('mark-damage', ({ gameCode, slotId, direction }) => {
      const roomName = `game:${gameCode}`;

      const state = gameStates.get(gameCode);
      if (!state) return;

      const team = socket.team;
      if (!team) return;

      // Track damage in game state (could affect systems later)
      if (!state.submarines[team].damage) {
        state.submarines[team].damage = [];
      }
      state.submarines[team].damage.push({ slotId, direction });

      // Notify team that damage was marked
      io.to(`${roomName}:${team}`).emit('damage-marked', { team, slotId, direction });
    });

    // First mate charges system
    socket.on('charge-system', ({ gameCode, system }) => {
      const roomName = `game:${gameCode}`;

      const state = gameStates.get(gameCode);
      if (!state) return;

      const team = socket.team;
      if (!team) return;

      const sub = state.submarines[team];
      if (sub.systems[system] !== undefined) {
        sub.systems[system] = Math.min(sub.systems[system] + 1, getSystemMax(system));
      }

      // Only notify own team about system charging
      io.to(`${roomName}:${team}`).emit('system-charged', { team, system, value: sub.systems[system] });
      io.to(`${roomName}:${team}`).emit('game-state', getTeamVisibleState(state, team));
    });

    // Fire torpedo
    socket.on('fire-torpedo', ({ gameCode, target }) => {
      const roomName = `game:${gameCode}`;

      const state = gameStates.get(gameCode);
      if (!state) return;

      const team = socket.team;
      const enemyTeam = team === 'alpha' ? 'bravo' : 'alpha';

      const sub = state.submarines[team];
      if (sub.systems.torpedo < 3) return; // Not charged

      sub.systems.torpedo = 0;

      // Check for hit
      const enemySub = state.submarines[enemyTeam];
      const distance = Math.abs(target.x - enemySub.position.x) + Math.abs(target.y - enemySub.position.y);

      let damage = 0;
      if (distance === 0) damage = 2; // Direct hit
      else if (distance === 1) damage = 1; // Adjacent hit

      if (damage > 0) {
        enemySub.health -= damage;
        io.to(roomName).emit('torpedo-hit', { team, target, damage, enemyHealth: enemySub.health });

        if (enemySub.health <= 0) {
          state.winner = team;
          io.to(roomName).emit('game-over', { winner: team });
        }
      } else {
        io.to(roomName).emit('torpedo-miss', { team, target });
      }
    });

    // Start game
    socket.on('start-game', async ({ gameCode }) => {
      const roomName = `game:${gameCode}`;

      try {
        await db.query(
          `UPDATE games SET status = 'playing', started_at = NOW() WHERE code = $1`,
          [gameCode]
        );

        const state = initGameState();
        gameStates.set(gameCode, state);

        // Send filtered state to each team
        io.to(`${roomName}:alpha`).emit('game-started', getTeamVisibleState(state, 'alpha'));
        io.to(`${roomName}:bravo`).emit('game-started', getTeamVisibleState(state, 'bravo'));
      } catch (error) {
        console.error('Start game error:', error);
      }
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
        automatedRoles: []
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
        automatedRoles: []
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

module.exports = setupGameSockets;
