const express = require('express');
const db = require('../config/database');
const { wp } = require('../config/auth');

const router = express.Router();

// All game routes require an authenticated user (the session cookie, fleet-kit).
router.use(wp.requireUser);

const GAME_MODES = ['turn-based', 'live'];

// Generate a random 6-character game code
function generateGameCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Create a new game
router.post('/create', async (req, res) => {
  const sameRoom = req.body?.sameRoom ?? false;
  const gameMode = req.body?.gameMode ?? 'turn-based';
  const userId = req.user.id;

  // The engine knows two modes, and same_room is a yes/no. Anything else used to be stored
  // as given (or failed as a database error) and then played as an unknown mode.
  if (!GAME_MODES.includes(gameMode)) {
    return res.status(400).json({ error: 'Game mode must be turn-based or live' });
  }
  if (typeof sameRoom !== 'boolean') {
    return res.status(400).json({ error: 'sameRoom must be true or false' });
  }

  try {
    let code = generateGameCode();

    // Ensure unique code
    let existing = await db.query('SELECT id FROM games WHERE code = $1', [code]);
    while (existing.rows.length > 0) {
      code = generateGameCode();
      existing = await db.query('SELECT id FROM games WHERE code = $1', [code]);
    }

    const result = await db.query(
      `INSERT INTO games (code, status, same_room, game_mode, created_by, created_at)
       VALUES ($1, 'lobby', $2, $3, $4, NOW())
       RETURNING id, code, status, same_room, game_mode, created_at`,
      [code, sameRoom, gameMode, userId]
    );

    res.status(201).json({
      success: true,
      game: result.rows[0]
    });
  } catch (error) {
    console.error('Create game error:', error);
    res.status(500).json({ error: 'Failed to create game' });
  }
});

// Get game by code
router.get('/:code', async (req, res) => {
  const { code } = req.params;

  try {
    const gameResult = await db.query(
      `SELECT g.*, u.username as creator_name
       FROM games g
       LEFT JOIN users u ON g.created_by = u.id
       WHERE g.code = $1`,
      [code.toUpperCase()]
    );

    if (gameResult.rows.length === 0) {
      return res.status(404).json({ error: 'Game not found' });
    }

    const playersResult = await db.query(
      `SELECT gp.*, u.username
       FROM game_players gp
       JOIN users u ON gp.user_id = u.id
       WHERE gp.game_id = $1`,
      [gameResult.rows[0].id]
    );

    res.json({
      game: gameResult.rows[0],
      players: playersResult.rows
    });
  } catch (error) {
    console.error('Get game error:', error);
    res.status(500).json({ error: 'Failed to get game' });
  }
});

module.exports = router;
