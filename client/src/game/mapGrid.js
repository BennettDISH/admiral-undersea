// What MapBoard needs to be a keyboard grid, kept apart from React so it can be tested in Node.
//
// The board is one tab stop (a roving tabindex): Tab lands on one cell, the arrow keys move
// between cells, Enter or Space picks the cell, Escape cancels a pick in progress.

/**
 * A cell is named the way the game's own text names it: the row is y and the column is x,
 * both counted from 0 (the sonar prompt asks for "Row (y)" and "Column (x)" and says "Our
 * position: row 3, col 7"), and the sector from 1 (the number printed on the map).
 * `notes` follow, comma-separated: what is in the cell, and what picking it would do.
 */
export function cellLabel(x, y, sector, notes = []) {
  return [`row ${y}, column ${x}, sector ${sector}`, ...notes.filter(Boolean)].join(', ')
}

/** What picking a cell does, for the pick in progress (the overlay MapBoard was given). */
export function pickNote(overlay, sector) {
  if (overlay === 'drone-sector') return `scan sector ${sector}`
  if (overlay === 'torpedo') return 'torpedo target'
  if (overlay === 'mine') return 'mine can go here'
  if (overlay === 'silence') return 'can move here silently'
  return 'valid target'
}

/**
 * The whole label of one cell. `cell` says what is in it: island, sub (your submarine), path
 * (your trail), mine, ghostStart / ghost (the radio operator's traced guess), candidate (a
 * possible enemy position), annotated (marked), enemySector (the enemy surfaced in its sector),
 * and pick (a note for what picking it does, or null when it cannot be picked).
 */
export function describeCell({ x, y, sector, island, sub, path, mine, ghostStart, ghost, candidate, annotated, enemySector, pick }) {
  return cellLabel(x, y, sector, [
    island ? 'island' : 'water',
    sub && 'your submarine',
    !sub && path && 'your trail',
    mine && 'your mine',
    ghostStart && 'guessed enemy start',
    !ghostStart && ghost && 'traced guess',
    candidate && 'possible enemy position',
    annotated && 'marked',
    enemySector && 'enemy surfaced in this sector',
    pick,
  ])
}

const ARROWS = {
  ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
}

/**
 * What a key does from the cell at `at`, on a board of `width` x `height` cells with sectors
 * `page` rows tall. Null when the key means nothing here (it is left alone, so Tab still leaves
 * the board). Otherwise one of:
 *   { type: 'focus', cell }  move to that cell (arrows; Home/End the row's ends, with Ctrl the
 *                            board's corners; PageUp/PageDown a sector up or down)
 *   { type: 'pick' }         Enter or Space
 *   { type: 'cancel' }       Escape
 * The edges stop the move: an arrow at the edge stays where it is.
 */
export function keyAction(event, at, { width, height, page = 5 }) {
  const { key, ctrlKey = false, altKey = false, metaKey = false } = event
  if (altKey || metaKey) return null
  const clamp = (v, size) => Math.min(size - 1, Math.max(0, v))
  const go = (x, y) => ({ type: 'focus', cell: { x: clamp(x, width), y: clamp(y, height) } })

  if (ctrlKey) {
    if (key === 'Home') return go(0, 0)
    if (key === 'End') return go(width - 1, height - 1)
    return null
  }
  if (ARROWS[key]) return go(at.x + ARROWS[key][0], at.y + ARROWS[key][1])
  if (key === 'Home') return go(0, at.y)
  if (key === 'End') return go(width - 1, at.y)
  if (key === 'PageUp') return go(at.x, at.y - page)
  if (key === 'PageDown') return go(at.x, at.y + page)
  if (key === 'Enter' || key === ' ' || key === 'Spacebar') return { type: 'pick' }
  if (key === 'Escape') return { type: 'cancel' }
  return null
}

/**
 * The cell that holds the tab stop before the player has moved around: the nearest of the cells
 * `prefer` names ("x,y" keys: the legal targets, or the radio's candidates) to the submarine,
 * the first of them in reading order on a tie or with no submarine; failing that the submarine's
 * own cell; failing that the top left.
 */
export function startCell({ position = null, prefer = null }) {
  if (prefer && prefer.size > 0) {
    let best = null
    for (const k of prefer) {
      const [x, y] = k.split(',').map(Number)
      const d = position ? Math.abs(x - position.x) + Math.abs(y - position.y) : 0
      const first = best === null || d < best.d || (d === best.d && (y < best.y || (y === best.y && x < best.x)))
      if (first) best = { x, y, d }
    }
    return { x: best.x, y: best.y }
  }
  if (position) return { x: position.x, y: position.y }
  return { x: 0, y: 0 }
}
