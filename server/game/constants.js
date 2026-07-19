// Single-sourced game data (shared with the client via ../../shared/gameConstants.json).
// This module adds server-side derived values + tunables on top of the raw data.
const DATA = require('../../shared/gameConstants.json');

const SYSTEM_MAX = DATA.systemMax;
const getSystemMax = (system) => SYSTEM_MAX[system] || 3;

const REQUIRED_ROLES = ['first-mate', 'engineer', 'radio-operator'];
const DIRECTIONS = ['N', 'S', 'E', 'W'];

// Pacing tunables. Turn-based ignores the real-time ones.
const TUNABLES = {
  MOVE_COOLDOWN_MS: 1500,          // real-time captain move cooldown (online)
  MOVE_COOLDOWN_MS_SAME_ROOM: 1000, // shorter when everyone shares a room
  MAX_PENDING_BREAKDOWNS: 3,       // real-time backpressure: engineer can't fall further behind
  ACTION_COOLDOWN_MS: 500,         // debounce accidental double-activation of a system
  SURFACE_SECONDS: 15,             // real-time: how long a sub is stuck on the surface
  SURFACE_PENALTY_TURNS: 1,        // turn-based: turns lost while surfaced
  SONAR_RESPONSE_TIMEOUT_MS: 8000, // auto-answer a sonar if the target stalls
  AUTOMATION_DELAY_MS: 500,        // let the UI update before automated crew acts
  TURN_WATCHDOG_MS: 30000,         // auto-confirm missing human roles so a drop can't hang a turn
  SURFACE_REPAIRS_HULL: false,     // faithful: surface clears breakdowns + trail, NOT hull HP
};

module.exports = {
  DATA,
  BOARD: DATA.board,
  MAP: DATA.map,
  START_POSITIONS: DATA.startPositions,
  MAX_HEALTH: DATA.maxHealth,
  SYSTEM_MAX,
  getSystemMax,
  ENGINEER_SLOTS: DATA.engineerSlots,
  CIRCUITS: DATA.circuits,
  DEFAULT_PRIORITY: DATA.defaultPriority,
  TORPEDO_RANGE: DATA.torpedoRange,
  SILENCE_RANGE: DATA.silenceRange,
  MINE_RANGE: DATA.mineRange,
  REQUIRED_ROLES,
  DIRECTIONS,
  TUNABLES,
};
