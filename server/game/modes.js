// How a game is played, as stored in games.game_mode: the tutorial (a guided first dive against a
// training boat), against the AI's boat at Easy, Normal or Hard, or crew against crew (empty
// stations on either boat go to the auto-crew). Games stored under the older names are renamed
// on boot (database/schema.sql).
const GAME_MODES = ['tutorial', 'vs-ai-easy', 'vs-ai-normal', 'vs-ai-hard', 'crews'];
const DEFAULT_MODE = 'vs-ai-normal';

/** The mode a game is made with: one we play, else null. */
function modeToStore(gameMode) {
  return typeof gameMode === 'string' && GAME_MODES.includes(gameMode) ? gameMode : null;
}

function modeOf(gameMode) {
  if (gameMode === 'tutorial') return { id: gameMode, vsAi: true, tutorial: true, aiSkill: 'easy' };
  const ai = typeof gameMode === 'string' ? /^vs-ai-(easy|normal|hard)$/.exec(gameMode) : null;
  if (ai) return { id: gameMode, vsAi: true, tutorial: false, aiSkill: ai[1] };
  return { id: 'crews', vsAi: false, tutorial: false, aiSkill: 'normal' };
}

module.exports = { GAME_MODES, DEFAULT_MODE, modeToStore, modeOf };
