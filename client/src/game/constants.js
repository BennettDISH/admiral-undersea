// Client game constants. Board/systems data is single-sourced from the server via
// ../../../shared/gameConstants.json (Vite imports JSON natively; see vite.config fs.allow).
import DATA from '../../../shared/gameConstants.json'

export const BOARD = DATA.board
export const SIMPLE_MAP = DATA.map
export const ENGINEER_SLOTS = DATA.engineerSlots
export const CIRCUITS = DATA.circuits
export const SYSTEM_MAX = DATA.systemMax
export const START_POSITIONS = DATA.startPositions
export const MAX_HEALTH = DATA.maxHealth
export const TORPEDO_RANGE = DATA.torpedoRange
export const SILENCE_RANGE = DATA.silenceRange

// Presentation metadata (icons/names) layered on top of the shared data.
export const SYSTEMS = [
  { id: 'torpedo', name: 'Torpedo', max: SYSTEM_MAX.torpedo, icon: '💣' },
  { id: 'mine', name: 'Mine', max: SYSTEM_MAX.mine, icon: '💥' },
  { id: 'drone', name: 'Drone', max: SYSTEM_MAX.drone, icon: '📡' },
  { id: 'sonar', name: 'Sonar', max: SYSTEM_MAX.sonar, icon: '🔊' },
  { id: 'silence', name: 'Silence', max: SYSTEM_MAX.silence, icon: '🤫' },
]

export const NUM_SECTORS = BOARD.sectorCols * Math.ceil(BOARD.height / BOARD.sectorHeight)

// Left-to-right, top-to-bottom 5x5 sectors, starting at 1. Mirrors server/game/map.js.
export function sectorOf(x, y) {
  const col = Math.floor(x / BOARD.sectorWidth)
  const row = Math.floor(y / BOARD.sectorHeight)
  return row * BOARD.sectorCols + col + 1
}

export const getSlotsForDirection = (dir) => ENGINEER_SLOTS.filter((s) => s.dir === dir)

export const inBounds = (x, y) => x >= 0 && y >= 0 && x < BOARD.width && y < BOARD.height
export const isWater = (x, y) => inBounds(x, y) && SIMPLE_MAP[y][x] === 0

const DELTAS = { N: { dx: 0, dy: -1 }, S: { dx: 0, dy: 1 }, E: { dx: 1, dy: 0 }, W: { dx: -1, dy: 0 } }
export const stepCell = (pos, dir) => ({ x: pos.x + DELTAS[dir].dx, y: pos.y + DELTAS[dir].dy })

// Water cells with BFS distance 1..maxDist from `pos` (mirrors server torpedo range check).
export function reachableWithin(pos, maxDist) {
  const out = new Set()
  if (!isWater(pos.x, pos.y)) return out
  const key = (x, y) => `${x},${y}`
  const seen = new Set([key(pos.x, pos.y)])
  let frontier = [pos]
  for (let d = 1; d <= maxDist; d++) {
    const next = []
    for (const c of frontier) {
      for (const dir of ['N', 'S', 'E', 'W']) {
        const q = stepCell(c, dir)
        if (!isWater(q.x, q.y) || seen.has(key(q.x, q.y))) continue
        seen.add(key(q.x, q.y))
        out.add(key(q.x, q.y))
        next.push(q)
      }
    }
    frontier = next
  }
  return out
}
