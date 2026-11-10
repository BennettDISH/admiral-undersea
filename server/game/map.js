// Pure grid helpers: the charts, steps, bearings and paths. No sockets, no game state.
const { MAPS, BOARD, HEADINGS } = require('./constants');

// One step per heading (N, NE, E, SE, S, SW, W, NW); y grows southwards.
const DELTAS = [
  { dx: 0, dy: -1 }, { dx: 1, dy: -1 }, { dx: 1, dy: 0 }, { dx: 1, dy: 1 },
  { dx: 0, dy: 1 }, { dx: -1, dy: 1 }, { dx: -1, dy: 0 }, { dx: -1, dy: -1 },
];

const key = (x, y) => `${x},${y}`;

/** A chart from its rows: '.' open water, '#' rock, '~' a thermal vent field (water, and it hides noise). */
function parseMap(def) {
  const rows = def.rows;
  const at = (x, y) => (Number.isInteger(x) && Number.isInteger(y) && y >= 0 && y < rows.length && x >= 0 && x < rows[y].length ? rows[y][x] : null);
  return {
    id: def.id,
    name: def.name,
    width: BOARD.width,
    height: BOARD.height,
    rows,
    starts: def.starts,
    whales: def.whales || [],
    inBounds: (x, y) => at(x, y) !== null,
    isWater: (x, y) => { const c = at(x, y); return c === '.' || c === '~'; },
    isRock: (x, y) => at(x, y) === '#',
    isVent: (x, y) => at(x, y) === '~',
  };
}

const CHARTS = new Map(MAPS.map((m) => [m.id, parseMap(m)]));
const MAP_IDS = [...CHARTS.keys()];
const getMap = (id) => CHARTS.get(id) || CHARTS.get(MAP_IDS[0]);

/** The cell one step along `heading` from `from`, and whether a boat can go there (no rock, no edge, no cutting a rock's corner). */
function stepFrom(map, from, heading) {
  const d = DELTAS[heading];
  const to = { x: from.x + d.dx, y: from.y + d.dy };
  let ok = map.isWater(to.x, to.y);
  if (ok && d.dx !== 0 && d.dy !== 0) {
    ok = map.isWater(from.x + d.dx, from.y) && map.isWater(from.x, from.y + d.dy);
  }
  return { to, ok };
}

/** Compass bearing from a to b in degrees: 0 north, 90 east, clockwise. Points may be fractional. */
function bearing(a, b) {
  const deg = (Math.atan2(b.x - a.x, -(b.y - a.y)) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** The signed gap from angle a to angle b, in -180..180. */
function angleDiff(a, b) {
  return ((b - a + 540) % 360) - 180;
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const chebyshev = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const sameCell = (a, b) => a.x === b.x && a.y === b.y;
const cellOf = (p) => ({ x: Math.round(p.x), y: Math.round(p.y) });

/** 'A1'-style grid name for a cell (column letter, row from 1). */
function cellName(x, y) {
  return `${BOARD.cols[x] ?? '?'}${y + 1}`;
}

/** The heading nearest a compass bearing. */
const headingFor = (deg) => Math.round((((deg % 360) + 360) % 360) / 45) % 8;

/**
 * Shortest boat route from `from` to `to` over water, as { heading, steps } for its first step, or
 * null when there is none (or they are the same cell). Diagonal steps count one, like straight ones.
 */
function routeTo(map, from, to) {
  if (sameCell(from, to) || !map.isWater(to.x, to.y)) return null;
  const prev = new Map([[key(from.x, from.y), null]]);
  let frontier = [from];
  while (frontier.length) {
    const next = [];
    for (const cell of frontier) {
      for (let h = 0; h < 8; h++) {
        const s = stepFrom(map, cell, h);
        if (!s.ok) continue;
        const k = key(s.to.x, s.to.y);
        if (prev.has(k)) continue;
        prev.set(k, { cell, h });
        if (sameCell(s.to, to)) {
          // walk back to the first step
          let cur = k;
          let steps = 0;
          let first = null;
          while (prev.get(cur)) {
            const p = prev.get(cur);
            first = p.h;
            steps += 1;
            cur = key(p.cell.x, p.cell.y);
          }
          return { heading: first, steps };
        }
        next.push(s.to);
      }
    }
    frontier = next;
  }
  return null;
}

/** Every water cell of a chart, in row order. */
function waterCells(map) {
  const out = [];
  for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) if (map.isWater(x, y)) out.push({ x, y });
  return out;
}

/** The cells a straight run from `a` to `b` passes through (sampled every quarter cell), for line-of-fire checks. */
function cellsAlong(a, b) {
  const n = Math.max(1, Math.ceil(dist(a, b) * 4));
  const seen = new Set();
  const out = [];
  for (let i = 0; i <= n; i++) {
    const c = cellOf({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n });
    const k = key(c.x, c.y);
    if (!seen.has(k)) { seen.add(k); out.push(c); }
  }
  return out;
}

module.exports = {
  DELTAS,
  HEADINGS,
  MAP_IDS,
  key,
  parseMap,
  getMap,
  stepFrom,
  bearing,
  angleDiff,
  dist,
  chebyshev,
  sameCell,
  cellOf,
  cellName,
  headingFor,
  routeTo,
  waterCells,
  cellsAlong,
};
