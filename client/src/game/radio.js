// Radio Operator deduction helpers. Pure functions over the enemy's public announcements.
// radioEvents is an ordered list of: {type:'move',dir} | {type:'surface',sector} | {type:'silence'}
import { SIMPLE_MAP, BOARD, isWater, stepCell, sectorOf, SILENCE_RANGE } from './constants'

const key = (x, y) => `${x},${y}`
const parse = (k) => { const [x, y] = k.split(',').map(Number); return { x, y } }

function allWaterKeys() {
  const set = new Set()
  for (let y = 0; y < BOARD.height; y++) {
    for (let x = 0; x < BOARD.width; x++) if (isWater(x, y)) set.add(key(x, y))
  }
  return set
}

// Cells reachable from p by moving 0..SILENCE_RANGE in one straight direction over water.
function silenceReach(p) {
  const out = new Set([key(p.x, p.y)])
  for (const dir of ['N', 'S', 'E', 'W']) {
    let c = { ...p }
    for (let i = 0; i < SILENCE_RANGE; i++) {
      c = stepCell(c, dir)
      if (!isWater(c.x, c.y)) break
      out.add(key(c.x, c.y))
    }
  }
  return out
}

// Set of the enemy's POSSIBLE CURRENT positions given everything heard so far.
// Over-approximates through silence (never wrongly eliminates the true cell).
export function computeCandidates(radioEvents) {
  let possible = allWaterKeys()
  for (const ev of radioEvents) {
    if (ev.type === 'move') {
      const next = new Set()
      for (const k of possible) {
        const q = stepCell(parse(k), ev.dir)
        if (isWater(q.x, q.y)) next.add(key(q.x, q.y))
      }
      possible = next
    } else if (ev.type === 'surface') {
      possible = new Set([...possible].filter((k) => { const p = parse(k); return sectorOf(p.x, p.y) === ev.sector }))
    } else if (ev.type === 'silence') {
      const next = new Set()
      for (const k of possible) for (const r of silenceReach(parse(k))) next.add(r)
      possible = next
    }
  }
  return possible
}

// Trace a hypothesized start through the heard move sequence. Stops (uncertain) at the
// first silence, since the enemy's silent move is unknown.
export function traceFrom(start, radioEvents) {
  if (!start || !isWater(start.x, start.y)) return { path: [], valid: false, uncertain: false }
  let pos = { ...start }
  let path = [{ ...pos }]
  const seen = new Set([key(pos.x, pos.y)])
  for (const ev of radioEvents) {
    if (ev.type === 'move') {
      pos = stepCell(pos, ev.dir)
      if (!isWater(pos.x, pos.y)) return { path, valid: false, uncertain: false }
      if (seen.has(key(pos.x, pos.y))) return { path, valid: false, uncertain: false }
      seen.add(key(pos.x, pos.y))
      path.push({ ...pos })
    } else if (ev.type === 'surface') {
      if (sectorOf(pos.x, pos.y) !== ev.sector) return { path, valid: false, uncertain: false }
      seen.clear() // trail cleared on surface
      seen.add(key(pos.x, pos.y))
    } else if (ev.type === 'silence') {
      return { path, valid: true, uncertain: true }
    }
  }
  return { path, valid: true, uncertain: false }
}

export const candidateKeyList = (set) => [...set]
export { SIMPLE_MAP }
