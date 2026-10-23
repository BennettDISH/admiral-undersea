import { useEffect, useRef, useState } from 'react'
import { SIMPLE_MAP, BOARD, sectorOf } from './constants'
import { describeCell, keyAction, pickNote, startCell } from './mapGrid'

const key = (x, y) => `${x},${y}`

// One map renderer for every station. `overlay` selects the targeting behaviour;
// `legalCells`/`onCellClick` drive per-system targeting; the sector grid is always drawn.
//
// The board is also a keyboard grid (see mapGrid.js): one tab stop that moves with the arrow
// keys, Enter or Space picks the cell a click would, and Escape calls `onCancel`. Every cell
// has a label such as "row 3, column 7, sector 2, water, torpedo target".
function MapBoard({
  map = SIMPLE_MAP,
  submarine = null,
  mines = [],
  overlay = 'none',
  legalCells = null,          // Set<"x,y"> of clickable cells
  onCellClick = null,
  onSectorClick = null,
  onCancel = null,            // Escape on a cell, while a pick is in progress
  ghostStart = null,          // radio: hypothesized enemy start {x,y}
  ghostPath = [],             // radio: traced path [{x,y}]
  candidates = null,          // radio: Set<"x,y"> of possible starts
  annotations = null,         // radio: Set<"x,y"> of manual marks
  enemySurfacedSector = null, // highlight the enemy's announced sector
  small = false,
  ariaLabel = 'Map',          // what the grid is called to a screen reader
}) {
  const legal = legalCells instanceof Set ? legalCells : null
  const cand = candidates instanceof Set ? candidates : null
  const annot = annotations instanceof Set ? annotations : null
  const ghostSet = new Set(ghostPath.map((p) => key(p.x, p.y)))
  const selecting = overlay !== 'none' && overlay !== 'radio'
  const dims = { width: BOARD.width, height: BOARD.height, page: BOARD.sectorHeight }

  // The cell holding the tab stop: where the player last was on the board, else where a pick
  // would most likely begin (startCell).
  const grid = useRef(null)
  const [active, setActive] = useState(null)
  const start = startCell({ position: submarine?.position, prefer: legal && legal.size > 0 ? legal : cand })
  const tabStop = active || start

  const focusCell = (c) => grid.current?.querySelector(`[data-x="${c.x}"][data-y="${c.y}"]`)?.focus()

  // A new pick starts the tab stop afresh, and starting one moves focus onto the board so the
  // keyboard follows the player from the USE button to the cells. (:focus-visible keeps a mouse
  // user from seeing a ring.)
  const wasSelecting = useRef(false)
  useEffect(() => {
    setActive(null)
    if (selecting && !wasSelecting.current) focusCell(start)
    wasSelecting.current = selecting
  }, [overlay]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleClick = (x, y, cell) => {
    if (overlay === 'drone-sector' && onSectorClick) return onSectorClick(sectorOf(x, y))
    if (onCellClick) onCellClick(x, y, cell)
  }

  const handleKeyDown = (e, x, y, cell, pickable) => {
    const action = keyAction(e, { x, y }, dims)
    if (!action) return
    if (action.type === 'cancel' && !(selecting && onCancel)) return
    e.preventDefault() // the arrows, Space and the page keys would scroll the page
    if (action.type === 'focus') { setActive(action.cell); focusCell(action.cell) }
    else if (action.type === 'pick') { if (pickable) handleClick(x, y, cell) }
    else onCancel()
  }

  return (
    <div className={`sonar-scope ${small ? 'small' : ''}`}>
    <div
      ref={grid}
      role="grid"
      aria-label={ariaLabel}
      aria-rowcount={map.length}
      aria-colcount={map[0]?.length}
      className={`map-board game-map ${small ? 'small' : ''} ${overlay !== 'none' ? `selecting selecting--${overlay}` : ''}`}
    >
      {map.map((row, y) => (
        <div key={y} role="row" aria-rowindex={y + 1} className="map-row">
          {row.map((cell, x) => {
            const k = key(x, y)
            const isMyPos = submarine?.position?.x === x && submarine?.position?.y === y
            const isPath = submarine?.path?.some((p) => p.x === x && p.y === y)
            const isMine = mines.some((m) => m.x === x && m.y === y)
            const isLegal = legal ? legal.has(k) : false
            const isGhostStart = ghostStart && ghostStart.x === x && ghostStart.y === y
            const isGhost = ghostSet.has(k)
            const isCandidate = cand ? cand.has(k) : false
            const isAnnotated = annot ? annot.has(k) : false
            const inEnemySector = enemySurfacedSector && sectorOf(x, y) === enemySurfacedSector
            // Sector grid lines (5x5 blocks).
            const edgeR = x + 1 < BOARD.width && sectorOf(x, y) !== sectorOf(x + 1, y)
            const edgeB = y + 1 < BOARD.height && sectorOf(x, y) !== sectorOf(x, y + 1)
            const label = x % BOARD.sectorWidth === 0 && y % BOARD.sectorHeight === 0 ? sectorOf(x, y) : null

            const classes = [
              'map-cell',
              cell ? 'island' : 'water',
              isMyPos ? 'submarine' : '',
              isPath ? 'path' : '',
              isMine ? 'mine' : '',
              isLegal ? 'legal-target' : '',
              isGhostStart ? 'ghost-start' : '',
              isGhost ? 'ghost' : '',
              isCandidate ? 'candidate' : '',
              isAnnotated ? 'annotated' : '',
              inEnemySector ? 'enemy-sector' : '',
              edgeR ? 'sector-edge-r' : '',
              edgeB ? 'sector-edge-b' : '',
            ].filter(Boolean).join(' ')

            const clickable = (legal && isLegal) || overlay === 'drone-sector' || (overlay === 'radio' && onCellClick)
            const sector = sectorOf(x, y)
            const pick = clickable && selecting ? pickNote(overlay, sector) : null

            return (
              <div
                key={x}
                role="gridcell"
                aria-colindex={x + 1}
                aria-label={describeCell({
                  x, y, sector, island: Boolean(cell), sub: isMyPos, path: isPath, mine: isMine,
                  ghostStart: isGhostStart, ghost: isGhost, candidate: isCandidate, annotated: isAnnotated,
                  enemySector: inEnemySector, pick,
                })}
                aria-disabled={selecting && !clickable ? true : undefined}
                tabIndex={tabStop.x === x && tabStop.y === y ? 0 : -1}
                data-x={x}
                data-y={y}
                className={`${classes} ${clickable ? 'clickable' : ''}`}
                onClick={clickable ? () => handleClick(x, y, cell) : undefined}
                onFocus={() => setActive((a) => (a && a.x === x && a.y === y ? a : { x, y }))}
                onKeyDown={(e) => handleKeyDown(e, x, y, cell, Boolean(clickable))}
              >
                {label != null && <span className="sector-label" aria-hidden="true">{label}</span>}
                {isMyPos && <span className="cell-icon" aria-hidden="true">🔴</span>}
                {isMine && !isMyPos && <span className="cell-icon" aria-hidden="true">◆</span>}
                {isGhostStart && !isMyPos && <span className="cell-icon" aria-hidden="true">👻</span>}
              </div>
            )
          })}
        </div>
      ))}
    </div>
    </div>
  )
}

export default MapBoard
