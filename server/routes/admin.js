const express = require('express');
const db = require('../config/database');
const { wp } = require('../config/auth');
const { guestSweepOff } = require('../services/guestSweep');

// Look-only admin views of every account and game. GET only: nothing here writes.
// The site admin is a Waypoint central id in ADMIN_CENTRAL_USER_IDS, read on every request
// (fleet-kit); never a guest, never a local-only account.
const router = express.Router();

const PAGE_SIZE = 50;

router.use(wp.requireUser);

// Lets the client decide whether to show the admin link. Any signed-in user may ask.
router.get('/me', (req, res) => {
  res.json({ isAdmin: Boolean(req.user.is_admin) });
});

router.use(wp.requireAdmin);

// The switches that live in the server's environment, shown read-only: on or off, never a
// value. Changing one is a Railway variable, not something this page does.
router.get('/switches', (req, res) => {
  const sweepOff = guestSweepOff();
  res.json({
    switches: [
      { name: 'Waypoint sign-in', env: 'AUTH_SERVICE_URL, SSO_CLIENT_ID, SSO_CLIENT_SECRET', on: wp.client.configured() },
      { name: 'Guest sweep', env: 'GUEST_CLEANUP_ENABLED', on: !sweepOff, note: sweepOff || null }
    ]
  });
});

function pageOf(req) {
  const n = parseInt(req.query.page, 10);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

// Search text for ILIKE, with % and _ taken literally.
function likePattern(req) {
  const q = String(req.query.q || '').trim().slice(0, 100);
  return q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
}

const paged = (total, page) => ({
  total,
  page,
  pageSize: PAGE_SIZE,
  totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
});

// Every account, newest first. Never the password hash.
router.get('/users', async (req, res) => {
  const page = pageOf(req);
  const params = [];
  let where = '';
  const like = likePattern(req);
  if (like) {
    params.push(like);
    where = `WHERE u.username ILIKE $1 ESCAPE '\\' OR u.email ILIKE $1 ESCAPE '\\'`;
  }

  try {
    const count = await db.query(`SELECT COUNT(*)::int AS n FROM users u ${where}`, params);
    const rows = await db.query(
      `SELECT u.id, u.username, u.email, u.role, u.is_active, u.created_at,
              (u.central_user_id IS NOT NULL) AS waypoint,
              (SELECT COUNT(*)::int FROM game_players gp WHERE gp.user_id = u.id) AS games_played,
              (SELECT COUNT(*)::int FROM game_players gp JOIN games g ON g.id = gp.game_id
                WHERE gp.user_id = u.id AND g.winner_team IS NOT NULL AND g.winner_team = gp.team) AS games_won,
              (SELECT COUNT(*)::int FROM games g WHERE g.created_by = u.id) AS games_created
       FROM users u ${where}
       ORDER BY u.created_at DESC, u.id DESC
       LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`,
      params
    );
    res.json({ users: rows.rows, ...paged(count.rows[0].n, page) });
  } catch (error) {
    console.error('Admin users error:', error);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

const STATUSES = ['lobby', 'playing', 'finished'];

// Every game, newest first, with its players and winner. Filters: q (code, creator or a
// player's name), status, and user (games that account created or played in).
router.get('/games', async (req, res) => {
  const page = pageOf(req);
  const params = [];
  const conds = [];

  const like = likePattern(req);
  if (like) {
    params.push(like);
    const n = params.length;
    conds.push(`(g.code ILIKE $${n} ESCAPE '\\' OR c.username ILIKE $${n} ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM game_players sp JOIN users su ON su.id = sp.user_id
                 WHERE sp.game_id = g.id AND su.username ILIKE $${n} ESCAPE '\\'))`);
  }
  if (req.query.status) {
    if (!STATUSES.includes(req.query.status)) {
      return res.status(400).json({ error: 'Unknown status' });
    }
    params.push(req.query.status);
    conds.push(`g.status = $${params.length}`);
  }
  if (req.query.user) {
    const userId = parseInt(req.query.user, 10);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: 'Bad user id' });
    }
    params.push(userId);
    const n = params.length;
    conds.push(`(g.created_by = $${n} OR EXISTS (SELECT 1 FROM game_players up WHERE up.game_id = g.id AND up.user_id = $${n}))`);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  try {
    const count = await db.query(
      `SELECT COUNT(*)::int AS n FROM games g LEFT JOIN users c ON c.id = g.created_by ${where}`,
      params
    );
    const rows = await db.query(
      `SELECT g.id, g.code, g.status, g.game_mode, g.same_room, g.team_alpha_name, g.team_bravo_name,
              g.winner_team, g.created_at, g.started_at, g.ended_at,
              g.created_by, c.username AS creator_name,
              COALESCE((SELECT json_agg(json_build_object(
                          'user_id', p.user_id, 'username', pu.username, 'team', p.team, 'roles', p.roles)
                          ORDER BY p.team, p.joined_at)
                        FROM game_players p JOIN users pu ON pu.id = p.user_id
                        WHERE p.game_id = g.id), '[]'::json) AS players
       FROM games g LEFT JOIN users c ON c.id = g.created_by
       ${where}
       ORDER BY g.created_at DESC, g.id DESC
       LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`,
      params
    );
    res.json({ games: rows.rows, ...paged(count.rows[0].n, page) });
  } catch (error) {
    console.error('Admin games error:', error);
    res.status(500).json({ error: 'Failed to list games' });
  }
});

module.exports = router;
