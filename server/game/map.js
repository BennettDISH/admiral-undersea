// Pure map/geometry helpers. No socket, no DB, no game state — safe to unit test.
const { MAP, BOARD } = require('./constants');

const key = (x, y) => `${x},${y}`;

function inBounds(x, y) {
  return x >= 0 && y >= 0 && x < BOARD.width && y < BOARD.height;
}

// A cell is water (playable) when it's in bounds and not an island (1).
function isWater(x, y) {
  return inBounds(x, y) && MAP[y][x] === 0;
}

// Sectors: 5x5 blocks, numbered left-to-right, top-to-bottom, starting at 1.
// On the 15x10 board that's 3 cols x 2 rows = sectors 1-6.
function sectorOf(x, y) {
  const col = Math.floor(x / BOARD.sectorWidth);
  const row = Math.floor(y / BOARD.sectorHeight);
  return row * BOARD.sectorCols + col + 1;
}

const DELTAS = { N: { dx: 0, dy: -1 }, S: { dx: 0, dy: 1 }, E: { dx: 1, dy: 0 }, W: { dx: -1, dy: 0 } };

function step(pos, dir) {
  const d = DELTAS[dir];
  return { x: pos.x + d.dx, y: pos.y + d.dy };
}

function neighbors4(x, y) {
  return [
    { x: x + 1, y },
    { x: x - 1, y },
    { x, y: y + 1 },
    { x, y: y - 1 },
  ].filter((p) => inBounds(p.x, p.y));
}

const chebyshev = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const manhattan = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

// Shortest number of steps through water from `from` to `to` (4-connected).
// Returns Infinity if unreachable. Used for faithful torpedo range (can't shoot through land).
function bfsWaterDistance(from, to) {
  if (!isWater(from.x, from.y) || !isWater(to.x, to.y)) return Infinity;
  if (from.x === to.x && from.y === to.y) return 0;
  const seen = new Set([key(from.x, from.y)]);
  let frontier = [from];
  let dist = 0;
  while (frontier.length) {
    dist += 1;
    const next = [];
    for (const cell of frontier) {
      for (const nb of neighbors4(cell.x, cell.y)) {
        if (!isWater(nb.x, nb.y)) continue;
        const k = key(nb.x, nb.y);
        if (seen.has(k)) continue;
        if (nb.x === to.x && nb.y === to.y) return dist;
        seen.add(k);
        next.push(nb);
      }
    }
    frontier = next;
  }
  return Infinity;
}

// Blast damage a point P takes from a detonation at `origin`: 2 on the cell, 1 to the ring around it.
function blastDamageAt(point, origin) {
  if (point.x === origin.x && point.y === origin.y) return 2;
  if (chebyshev(point, origin) === 1) return 1;
  return 0;
}

module.exports = {
  key,
  inBounds,
  isWater,
  sectorOf,
  step,
  neighbors4,
  chebyshev,
  manhattan,
  bfsWaterDistance,
  blastDamageAt,
  DELTAS,
};
