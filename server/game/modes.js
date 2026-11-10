// How a game is played, as stored in games.game_mode: the tutorial (a guided first dive against a
// training boat), against the AI's boat at Easy, Normal or Hard, or crew against crew (empty
// stations on either boat go to the auto-crew). Older games say 'vs-ai' (played as Easy),
// 'vs-ai-veteran' (Hard), or 'turn-based' / 'live' (played as crews).
const GAME_MODES = ['tutorial', 'vs-ai-easy', 'vs-ai-normal', 'vs-ai-hard', 'crews'];
const OLD_MODES = { 'vs-ai': 'vs-ai-easy', 'vs-ai-veteran': 'vs-ai-hard' };
const DEFAULT_MODE = 'vs-ai-normal';

// Own names only: 'constructor' or '__proto__' must not find Object's.
const oldName = (m) => (typeof m === 'string' && Object.hasOwn(OLD_MODES, m) ? OLD_MODES[m] : null);

/** The mode a game is made with: one we play, an old name for one, else null. */
function modeToStore(gameMode) {
  if (typeof gameMode !== 'string') return null;
  if (GAME_MODES.includes(gameMode)) return gameMode;
  return oldName(gameMode);
}

function modeOf(gameMode) {
  const id = oldName(gameMode) || gameMode;
  if (id === 'tutorial') return { id, vsAi: true, tutorial: true, aiSkill: 'easy' };
  const ai = /^vs-ai-(easy|normal|hard)$/.exec(id);
  if (ai) return { id, vsAi: true, tutorial: false, aiSkill: ai[1] };
  return { id: 'crews', vsAi: false, tutorial: false, aiSkill: 'normal' };
}

module.exports = { GAME_MODES, OLD_MODES, DEFAULT_MODE, modeToStore, modeOf };
