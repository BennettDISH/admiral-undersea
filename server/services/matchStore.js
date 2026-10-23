// Matches in Postgres (table game_matches), so a restart does not wipe them. The sockets keep
// the live match in memory (sockets/game.js) and write it here as it changes; join-game and the
// first lobby setup after a restart read it back.
//
// A row holds the whole in-memory match, or only the lobby's automation setup before the game
// starts (automatedRoles, systemPriority). It goes with its game, 1 day after game-over, and 7
// days after the last change to it. Every call here logs a database failure and carries on: a
// match that cannot be saved is still played from memory.
const db = require('../config/database');

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long a finished game's match is kept, from the game-over. */
const FINISHED_TTL_MS = DAY_MS;
/** How long a match nobody has changed is kept. */
const IDLE_TTL_MS = 7 * DAY_MS;

/** Whether `state` is something the sockets can play from: a lobby setup, or a match with both boats. */
const isMatch = (state) => Boolean(state) && typeof state === 'object' && !Array.isArray(state)
  && (!state.submarines || (Boolean(state.submarines.alpha) && Boolean(state.submarines.bravo)));

/** Write the match for `gameCode`. A code with no game row writes nothing. Returns whether it ran. */
async function save(gameCode, state) {
  try {
    await db.query(
      `INSERT INTO game_matches (game_id, state, updated_at)
       SELECT g.id, $2::jsonb, NOW() FROM games g WHERE g.code = $1
       ON CONFLICT (game_id) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()`,
      [gameCode, JSON.stringify(state)],
    );
    return true;
  } catch (err) {
    console.error(`Failed to save match ${gameCode}:`, err.message);
    return false;
  }
}

/** The stored match for `gameCode`, or null when there is none (or it cannot be read). */
async function load(gameCode) {
  try {
    const res = await db.query(
      `SELECT gm.state FROM game_matches gm JOIN games g ON g.id = gm.game_id WHERE g.code = $1`,
      [gameCode],
    );
    const state = res.rows[0]?.state;
    return isMatch(state) ? state : null;
  } catch (err) {
    console.error(`Failed to load match ${gameCode}:`, err.message);
    return null;
  }
}

/** Drop the matches past their time: finished a day ago, or unchanged for a week. Returns how many went. */
async function purge() {
  try {
    const res = await db.query(
      `DELETE FROM game_matches gm USING games g
       WHERE g.id = gm.game_id
         AND ((g.status = 'finished' AND g.ended_at < NOW() - $1::double precision * INTERVAL '1 millisecond')
              OR gm.updated_at < NOW() - $2::double precision * INTERVAL '1 millisecond')`,
      [FINISHED_TTL_MS, IDLE_TTL_MS],
    );
    return res.rowCount ?? res.affectedRows ?? 0;
  } catch (err) {
    console.error('Failed to purge old matches:', err.message);
    return 0;
  }
}

module.exports = { FINISHED_TTL_MS, IDLE_TTL_MS, isMatch, save, load, purge };
