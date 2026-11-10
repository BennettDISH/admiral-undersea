// The client's side of the rules: the charts, the stations and the numbers the screens show,
// single-sourced with the server through shared/gameConstants.json. Pure: no DOM, no React.
import DATA from '../../../shared/gameConstants.json' with { type: 'json' }

export const BOARD = DATA.board
export const HEADINGS = DATA.headings
export const SPEEDS = DATA.speeds
export const HULL_MAX = DATA.hullMax
export const MATCH_SECONDS = DATA.matchSeconds
export const POWER = DATA.power
export const TORPEDO = DATA.torpedo
export const PING = DATA.ping
export const DECOY = DATA.decoy
export const VENT = DATA.vent
export const FAULTS = DATA.faults
export const CALLS = DATA.calls
export const STATIONS = DATA.stations

export const SPEED_NAMES = ['All stop', 'Slow', 'Half', 'Full']
export const HEADING_NAMES = ['North', 'North-east', 'East', 'South-east', 'South', 'South-west', 'West', 'North-west']

// What each station is called on the boat, and what it does, in one line each.
export const STATION_INFO = {
  helm: {
    name: 'Helm', room: 'The Helm', who: 'Helmsman', key: '1',
    job: 'Steer and set the speed. Faster is louder, and rocks hurt at speed.',
  },
  listener: {
    name: 'Listening', room: 'Listening Post', who: 'Listener', key: '2',
    job: 'Hear the enemy on the hydrophones, plot where the bearings cross, mark the target, ping when you must.',
  },
  weapons: {
    name: 'Torpedoes', room: 'Torpedo Room', who: 'Torpedoman', key: '3',
    job: 'Load the tubes, fire on the mark, steer a running torpedo onto the target, throw decoys.',
  },
  chief: {
    name: 'Engine Room', room: 'Engine Room', who: 'Chief', key: '4',
    job: 'Share the reactor\'s power, keep it from overheating, and repair whatever breaks.',
  },
}

export const TEAM_INFO = {
  alpha: { boat: 'Marlin', colour: 'blue' },
  bravo: { boat: 'Barracuda', colour: 'red' },
}

// What a contact is, as the listener's plot shows it.
export const CONTACT_INFO = {
  hull: { label: 'Machinery', note: 'a boat under way' },
  bio: { label: 'Biologic', note: 'whale song' },
  launch: { label: 'Launch transient', note: 'a torpedo leaving a tube' },
  torpedo: { label: 'TORPEDO', note: 'a torpedo running' },
  ping: { label: 'Active ping', note: 'they pinged: exact' },
  vent: { label: 'Steam transient', note: 'a reactor venting' },
  scrape: { label: 'Hull scrape', note: 'a boat hit rock' },
}

export const enemyOf = (team) => (team === 'alpha' ? 'bravo' : 'alpha')

const CHARTS = new Map(DATA.maps.map((m) => [m.id, m]))

/** A chart's rows and tests: '.' open water, '#' rock, '~' a vent field. */
export function chart(id) {
  const def = CHARTS.get(id) || DATA.maps[0]
  const at = (x, y) => (Number.isInteger(x) && Number.isInteger(y) && y >= 0 && y < def.rows.length && x >= 0 && x < def.rows[y].length ? def.rows[y][x] : null)
  return {
    id: def.id,
    name: def.name,
    width: BOARD.width,
    height: BOARD.height,
    rows: def.rows,
    inBounds: (x, y) => at(x, y) !== null,
    isWater: (x, y) => at(x, y) === '.' || at(x, y) === '~',
    isRock: (x, y) => at(x, y) === '#',
    isVent: (x, y) => at(x, y) === '~',
  }
}

const DELTAS = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]]
export const delta = (heading) => ({ dx: DELTAS[heading][0], dy: DELTAS[heading][1] })

/** Whether one step along `heading` is open water (no rock, no edge, no cutting a rock's corner). */
export function canStep(map, from, heading) {
  const { dx, dy } = delta(heading)
  const to = { x: from.x + dx, y: from.y + dy }
  if (!map.isWater(to.x, to.y)) return false
  if (dx && dy) return map.isWater(from.x + dx, from.y) && map.isWater(from.x, from.y + dy)
  return true
}

/** Compass bearing from a to b: 0 north, 90 east, clockwise. */
export function bearing(a, b) {
  const deg = (Math.atan2(b.x - a.x, -(b.y - a.y)) * 180) / Math.PI
  return (deg + 360) % 360
}

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
export const cellName = (x, y) => `${BOARD.cols[x] ?? '?'}${y + 1}`
export const headingFor = (deg) => Math.round((((deg % 360) + 360) % 360) / 45) % 8
export const bearingText = (deg) => String(Math.round(((deg % 360) + 360) % 360)).padStart(3, '0')

/** The cells a straight run passes through (every quarter cell), to warn of a rock in the way. */
export function cellsAlong(a, b) {
  const n = Math.max(1, Math.ceil(dist(a, b) * 4))
  const seen = new Set()
  const out = []
  for (let i = 0; i <= n; i++) {
    const c = { x: Math.round(a.x + ((b.x - a.x) * i) / n), y: Math.round(a.y + ((b.y - a.y) * i) / n) }
    const k = `${c.x},${c.y}`
    if (!seen.has(k)) { seen.add(k); out.push(c) }
  }
  return out
}

/**
 * Where two bearing lines cross, in cells, or null: they must come from spots at least a cell and a
 * half apart, meet at a real angle (12 degrees or more), and cross ahead of both.
 */
export function crossing(a, b) {
  if (Math.hypot(a.ox - b.ox, a.oy - b.oy) < 1.5) return null
  const ra = (a.bearing * Math.PI) / 180
  const rb = (b.bearing * Math.PI) / 180
  const da = { x: Math.sin(ra), y: -Math.cos(ra) }
  const db = { x: Math.sin(rb), y: -Math.cos(rb) }
  const den = da.x * db.y - da.y * db.x
  if (Math.abs(den) < Math.sin((12 * Math.PI) / 180)) return null
  const t = ((b.ox - a.ox) * db.y - (b.oy - a.oy) * db.x) / den
  const u = ((b.ox - a.ox) * da.y - (b.oy - a.oy) * da.x) / den
  if (t <= 0 || u <= 0) return null
  return { x: a.ox + da.x * t, y: a.oy + da.y * t }
}

/** Why a shot at `target` would not go as planned, or null when it is clean. */
export function shotProblem(map, from, target) {
  if (!target) return 'No target'
  if (from.x === target.x && from.y === target.y) return 'That is our own position'
  if (dist(from, target) > TORPEDO.range) return `Out of range (${TORPEDO.range} cells)`
  if (cellsAlong(from, target).some((c) => !map.isWater(c.x, c.y))) return 'Rock in the way: it will blow on the rock'
  if (Math.max(Math.abs(from.x - target.x), Math.abs(from.y - target.y)) <= 1) return 'Too close: the blast would hit us'
  return null
}

/** Seconds to load one tube at `power` on tubes, with `loading` tubes sharing it. */
export const loadSeconds = (power, loading = 1) => (power > 0 ? (TORPEDO.loadSecondsAtOnePower * loading) / power : Infinity)

/** The total the engine room has asked of the reactor. */
export const totalPower = (p) => (p ? p.engines + p.sonar + p.tubes : 0)

/** mm:ss for the match clock. */
export function clockText(seconds) {
  const s = Math.max(0, Math.ceil(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
