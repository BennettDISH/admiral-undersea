import { SIMPLE_MAP, BOARD, sectorOf } from './constants'

const key = (x, y) => `${x},${y}`

// One map renderer for every station. `overlay` selects the targeting behaviour;
// `legalCells`/`onCellClick` drive per-system targeting; the sector grid is always drawn.
function MapBoard({
  map = SIMPLE_MAP,
  submarine = null,
  mines = [],
  overlay = 'none',
  legalCells = null,          // Set<"x,y"> of clickable cells
  onCellClick = null,
  onSectorClick = null,
  ghostStart = null,          // radio: hypothesized enemy start {x,y}
  ghostPath = [],             // radio: traced path [{x,y}]
  candidates = null,          // radio: Set<"x,y"> of possible starts
  annotations = null,         // radio: Set<"x,y"> of manual marks
  enemySurfacedSector = null, // highlight the enemy's announced sector
  small = false,
}) {
  const legal = legalCells instanceof Set ? legalCells : null
  const cand = candidates instanceof Set ? candidates : null
  const annot = annotations instanceof Set ? annotations : null
  const ghostSet = new Set(ghostPath.map((p) => key(p.x, p.y)))

  const handleClick = (x, y, cell) => {
    if (overlay === 'drone-sector' && onSectorClick) return onSectorClick(sectorOf(x, y))
    if (onCellClick) onCellClick(x, y, cell)
  }

  return (
    <div className={`map-board game-map ${small ? 'small' : ''} ${overlay !== 'none' ? `selecting selecting--${overlay}` : ''}`}>
      {map.map((row, y) => (
        <div key={y} className="map-row">
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

            return (
              <div
                key={x}
                className={`${classes} ${clickable ? 'clickable' : ''}`}
                onClick={clickable ? () => handleClick(x, y, cell) : undefined}
              >
                {label != null && <span className="sector-label">{label}</span>}
                {isMyPos && <span className="cell-icon">🔴</span>}
                {isMine && !isMyPos && <span className="cell-icon">◆</span>}
                {isGhostStart && !isMyPos && <span className="cell-icon">👻</span>}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

export default MapBoard
