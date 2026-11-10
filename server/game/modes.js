// How a game is played, as stored in games.game_mode: against the AI's boat (a green or a
// veteran crew), or crew against crew (empty stations on either boat go to the auto-crew).
// Games made before the overhaul say 'turn-based' or 'live'; both are played as crews now.
const GAME_MODES = ['vs-ai', 'vs-ai-veteran', 'crews'];

function modeOf(gameMode) {
  if (gameMode === 'vs-ai') return { id: 'vs-ai', vsAi: true, aiSkill: 'green' };
  if (gameMode === 'vs-ai-veteran') return { id: 'vs-ai-veteran', vsAi: true, aiSkill: 'veteran' };
  return { id: 'crews', vsAi: false, aiSkill: 'green' };
}

module.exports = { GAME_MODES, modeOf };
