const express = require('express');
const db = require('../config/database');
const { wp } = require('../config/auth');

const router = express.Router();

// All game routes require an authenticated user (the session cookie, fleet-kit).
router.use(wp.requireUser);

const { GAME_MODES, DEFAULT_MODE, modeToStore } = require('../game/modes');

// One person may hold this many open lobbies (made in the last day and not started) at a time;
// past it, a new one waits until one is started or a day old. And one person makes at most
// DAY_CAP games in a day, started or not (the tutorial and a game against the AI start in a click,
// and every started match is kept in memory and the database). The create answer says how many
// of each, so the page can warn before a limit.
const LOBBY_CAP = 10;
const DAY_CAP = 60;

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
  // An old page may still ask for 'vs-ai' or 'vs-ai-veteran': they are stored as Easy and Hard.
  const gameMode = modeToStore(req.body?.gameMode ?? DEFAULT_MODE);
  const userId = req.user.id;

  // Only the modes the game plays, and same_room is a yes/no. Anything else used to be stored
  // as given (or failed as a database error) and then played as an unknown mode.
  if (!gameMode) {
    return res.status(400).json({ error: `Game mode must be one of ${GAME_MODES.join(', ')}` });
  }
  if (typeof sameRoom !== 'boolean') {
    return res.status(400).json({ error: 'sameRoom must be true or false' });
  }

  try {
    const counts = await db.query(
      `SELECT COUNT(*)::int AS made, (COUNT(*) FILTER (WHERE status = 'lobby'))::int AS open
       FROM games WHERE created_by = $1 AND created_at > NOW() - INTERVAL '1 day'`,
      [userId],
    );
    const openLobbies = counts.rows[0]?.open ?? 0;
    const madeToday = counts.rows[0]?.made ?? 0;
    const limits = { openLobbies, lobbyCap: LOBBY_CAP, madeToday, dayCap: DAY_CAP };
    if (madeToday >= DAY_CAP) {
      return res.status(429).json({
        error: `You have made ${DAY_CAP} games today, the most in a day. Come back tomorrow, or join a friend's game with its code.`,
        ...limits,
      });
    }
    if (openLobbies >= LOBBY_CAP) {
      return res.status(429).json({
        error: `You have ${LOBBY_CAP} open lobbies, the most at once. Start one, or wait a day for the oldest to lapse.`,
        ...limits,
      });
    }

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
      game: result.rows[0],
      ...limits,
      openLobbies: openLobbies + 1,
      madeToday: madeToday + 1,
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
