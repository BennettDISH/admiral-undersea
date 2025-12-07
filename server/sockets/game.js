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

      // Look up existing team/role from database
      try {
        const gameResult = await db.query('SELECT id FROM games WHERE code = $1', [gameCode]);
        if (gameResult.rows.length > 0) {
          const playerResult = await db.query(
            'SELECT team, role FROM game_players WHERE game_id = $1 AND user_id = $2',
            [gameResult.rows[0].id, userId]
          );
          if (playerResult.rows.length > 0) {
            socket.team = playerResult.rows[0].team;
            socket.role = playerResult.rows[0].role;
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

      // Send current game state if exists
      if (gameStates.has(gameCode)) {
        socket.emit('game-state', gameStates.get(gameCode));
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

    // Select role
    socket.on('select-role', async ({ gameCode, userId, role }) => {
      const roomName = `game:${gameCode}`;

      try {
        const gameResult = await db.query('SELECT id FROM games WHERE code = $1', [gameCode]);
        if (gameResult.rows.length === 0) return;

        const gameId = gameResult.rows[0].id;

        await db.query(
          `UPDATE game_players SET role = $1 WHERE game_id = $2 AND user_id = $3`,
          [role, gameId, userId]
        );

        socket.role = role;

        io.to(roomName).emit('role-updated', { userId, username: socket.username, role });
      } catch (error) {
        console.error('Select role error:', error);
      }
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

      // Broadcast move to own team (they see everything)
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

      io.to(roomName).emit('system-charged', { team, system, value: sub.systems[system] });
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

        io.to(roomName).emit('game-started', state);
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

module.exports = setupGameSockets;
