import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import api from '../services/api'
import socket, { connectSocket } from '../services/socket'

// Simple 15x10 map with islands (1 = island, 0 = water)
const SIMPLE_MAP = [
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  [0,0,1,0,0,0,0,0,0,0,0,0,1,0,0],
  [0,0,1,0,0,0,1,1,0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0,1,0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0,0,0,0,1,0,0,0,0],
  [0,0,0,1,0,0,0,0,0,0,1,0,0,0,0],
  [0,0,0,1,1,0,0,0,0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0,1,1,0,0,0,0,0,0],
  [0,0,0,0,0,0,0,0,0,0,0,0,1,0,0],
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
]

const SYSTEMS = [
  { id: 'torpedo', name: 'Torpedo', max: 3, icon: '💣' },
  { id: 'mine', name: 'Mine', max: 3, icon: '💥' },
  { id: 'drone', name: 'Drone', max: 4, icon: '📡' },
  { id: 'sonar', name: 'Sonar', max: 3, icon: '🔊' },
  { id: 'silence', name: 'Silence', max: 6, icon: '🤫' },
]

// Engineer circuit board - each direction has damage slots
const CIRCUIT_BOARD = {
  N: [
    { id: 'n1', system: 'torpedo' },
    { id: 'n2', system: 'mine' },
    { id: 'n3', system: 'sonar' },
  ],
  S: [
    { id: 's1', system: 'drone' },
    { id: 's2', system: 'silence' },
    { id: 's3', system: 'torpedo' },
  ],
  E: [
    { id: 'e1', system: 'mine' },
    { id: 'e2', system: 'drone' },
    { id: 'e3', system: 'silence' },
  ],
  W: [
    { id: 'w1', system: 'sonar' },
    { id: 'w2', system: 'torpedo' },
    { id: 'w3', system: 'mine' },
  ],
}

function Game({ user }) {
  const { code } = useParams()
  const navigate = useNavigate()

  const [game, setGame] = useState(null)
  const [myTeam, setMyTeam] = useState(null)
  const [myRoles, setMyRoles] = useState([])
  const [activeRole, setActiveRole] = useState(null)
  const [gameState, setGameState] = useState(null)
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false)
  const [confirmedRoles, setConfirmedRoles] = useState([])
  const [enemyPath, setEnemyPath] = useState([])
  const [lastMove, setLastMove] = useState(null)

  // Track if role has completed their action this turn
  const [hasChargedSystem, setHasChargedSystem] = useState(false)
  const [hasMarkedDamage, setHasMarkedDamage] = useState(false)

  // Engineer's damage tracking
  const [damagedSlots, setDamagedSlots] = useState([])

  // Automation settings (controlled by Captain)
  const [automatedRoles, setAutomatedRoles] = useState([])
  const [systemPriority, setSystemPriority] = useState(['torpedo', 'mine', 'drone', 'sonar', 'silence'])

  useEffect(() => {
    loadGame()
    connectSocket()

    socket.emit('join-game', { gameCode: code, userId: user.id, username: user.username })

    socket.on('game-state', (state) => {
      setGameState(state)
      // Update automation settings if included
      if (state.automatedRoles) {
        setAutomatedRoles(state.automatedRoles)
      }
      if (state.systemPriority) {
        setSystemPriority(state.systemPriority)
      }
    })
    socket.on('game-started', (state) => {
      setGameState(state)
      // Load automation settings from game start
      if (state.automatedRoles) {
        setAutomatedRoles(state.automatedRoles)
      }
      if (state.systemPriority) {
        setSystemPriority(state.systemPriority)
      }
    })

    socket.on('move-announced', ({ team, direction, awaitingConfirmation: awaiting }) => {
      setLastMove({ team, direction })
      if (team === myTeam) {
        setAwaitingConfirmation(awaiting)
        // Reset action flags for new turn
        setHasChargedSystem(false)
        setHasMarkedDamage(false)
      }
    })

    socket.on('play-move-sound', ({ team, direction }) => {
      if (myRoles.includes('radio-operator')) {
        playMoveSound(direction)
      }
    })

    socket.on('role-confirmed', ({ team, role }) => {
      if (team === myTeam) {
        setConfirmedRoles(prev => [...prev, role])
      }
    })

    socket.on('turn-complete', ({ team }) => {
      if (team === myTeam) {
        setAwaitingConfirmation(false)
        setConfirmedRoles([])
        setLastMove(null)
      }
    })

    socket.on('system-charged', ({ team, system, value }) => {
      if (team === myTeam) {
        setHasChargedSystem(true)
      }
      setGameState(prev => {
        if (!prev) return prev
        return {
          ...prev,
          submarines: {
            ...prev.submarines,
            [team]: {
              ...prev.submarines[team],
              systems: {
                ...prev.submarines[team].systems,
                [system]: value
              }
            }
          }
        }
      })
    })

    socket.on('damage-marked', ({ team }) => {
      if (team === myTeam) {
        setHasMarkedDamage(true)
      }
    })

    socket.on('torpedo-hit', ({ team, damage, enemyHealth }) => {
      alert(`Torpedo hit! ${damage} damage dealt!`)
    })

    socket.on('torpedo-miss', ({ team }) => {
      alert('Torpedo missed!')
    })

    socket.on('game-over', ({ winner }) => {
      alert(`Game Over! Team ${winner.toUpperCase()} wins!`)
      navigate('/')
    })

    socket.on('automated-roles-updated', ({ team, automatedRoles: roles }) => {
      if (team === myTeam) {
        setAutomatedRoles(roles)
      }
    })

    socket.on('automation-action', ({ role, action, details }) => {
      // Show what automated roles did
      console.log(`Auto ${role}: ${action}`, details)
    })

    return () => {
      socket.off('game-state')
      socket.off('game-started')
      socket.off('move-announced')
      socket.off('play-move-sound')
      socket.off('role-confirmed')
      socket.off('turn-complete')
      socket.off('system-charged')
      socket.off('damage-marked')
      socket.off('torpedo-hit')
      socket.off('torpedo-miss')
      socket.off('game-over')
      socket.off('automated-roles-updated')
      socket.off('automation-action')
    }
  }, [code, user, myTeam, myRoles])

  const loadGame = async () => {
    try {
      const response = await api.get(`/games/${code}`)
      setGame(response.data.game)

      const myPlayer = response.data.players.find(p => p.user_id === user.id)
      if (myPlayer) {
        setMyTeam(myPlayer.team)
        // Parse roles
        const rolesStr = myPlayer.roles || myPlayer.role || ''
        const roles = rolesStr.split(',').filter(r => r && r !== 'unassigned')
        setMyRoles(roles)
        // Set initial active role
        if (roles.length > 0 && !activeRole) {
          setActiveRole(roles[0])
        }
        socket.team = myPlayer.team
      }
    } catch (err) {
      console.error('Failed to load game')
    }
  }

  const playMoveSound = (direction) => {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const oscillator = ctx.createOscillator()
    const gainNode = ctx.createGain()

    const frequencies = { N: 440, S: 330, E: 550, W: 220 }
    oscillator.frequency.value = frequencies[direction]
    oscillator.type = 'sine'

    gainNode.gain.setValueAtTime(0.3, ctx.currentTime)
    gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5)

    oscillator.connect(gainNode)
    gainNode.connect(ctx.destination)

    oscillator.start(ctx.currentTime)
    oscillator.stop(ctx.currentTime + 0.5)
  }

  const handleMove = (direction) => {
    if (!myRoles.includes('captain') || awaitingConfirmation) return
    socket.emit('captain-move', { gameCode: code, direction })
  }

  const handleAyeCaptain = (role) => {
    socket.emit('aye-captain', { gameCode: code, role })
  }

  const handleChargeSystem = (system) => {
    if (!myRoles.includes('first-mate') || hasChargedSystem) return
    socket.emit('charge-system', { gameCode: code, system })
  }

  const handleMarkDamage = (slotId) => {
    if (!myRoles.includes('engineer') || hasMarkedDamage || !lastMove) return

    const direction = lastMove.direction
    const validSlots = CIRCUIT_BOARD[direction].map(s => s.id)
    if (!validSlots.includes(slotId)) return
    if (damagedSlots.includes(slotId)) return

    setDamagedSlots(prev => [...prev, slotId])
    socket.emit('mark-damage', { gameCode: code, slotId, direction })
  }

  const handleMarkEnemyMove = (direction) => {
    setEnemyPath(prev => [...prev, direction])
  }

  const handleFireTorpedo = (x, y) => {
    const mySub = gameState?.submarines[myTeam]
    if (!mySub || mySub.systems.torpedo < 3) return
    socket.emit('fire-torpedo', { gameCode: code, target: { x, y } })
  }

  // Update system priority order (drag & drop or buttons)
  const moveSystemPriority = (systemId, direction) => {
    const idx = systemPriority.indexOf(systemId)
    if (idx === -1) return
    const newIdx = direction === 'up' ? idx - 1 : idx + 1
    if (newIdx < 0 || newIdx >= systemPriority.length) return

    const newPriority = [...systemPriority]
    newPriority.splice(idx, 1)
    newPriority.splice(newIdx, 0, systemId)
    setSystemPriority(newPriority)
    socket.emit('set-system-priority', { gameCode: code, team: myTeam, systemPriority: newPriority })
  }

  // Calculate engineer board status per direction
  const getEngineerBoardStatus = () => {
    const status = {}
    Object.entries(CIRCUIT_BOARD).forEach(([direction, slots]) => {
      const availableSlots = slots.filter(s => !damagedSlots.includes(s.id)).length
      const totalSlots = slots.length
      status[direction] = {
        available: availableSlots,
        total: totalSlots,
        danger: availableSlots <= 1 ? 'high' : availableSlots === totalSlots ? 'safe' : 'medium'
      }
    })
    return status
  }

  // Get next system to charge based on priority (for automation display)
  const getNextSystemToCharge = () => {
    const mySub = gameState?.submarines[myTeam]
    if (!mySub) return null

    for (const systemId of systemPriority) {
      const sys = SYSTEMS.find(s => s.id === systemId)
      if (sys && (mySub.systems[systemId] || 0) < sys.max) {
        return systemId
      }
    }
    return null
  }

  const engineerStatus = getEngineerBoardStatus()
  const nextAutoCharge = getNextSystemToCharge()

  if (!gameState) {
    return <div className="loading">Loading game...</div>
  }

  const mySub = gameState.submarines[myTeam]

  // Check which roles need to act
  const roleNeedsAction = (role) => {
    if (!awaitingConfirmation) return false
    if (confirmedRoles.includes(role)) return false
    if (role === 'first-mate' && !hasChargedSystem) return true
    if (role === 'engineer' && !hasMarkedDamage) return true
    if (role === 'radio-operator') return true
    return false
  }

  const roleCanConfirm = (role) => {
    if (!awaitingConfirmation) return false
    if (confirmedRoles.includes(role)) return false
    if (role === 'first-mate') return hasChargedSystem
    if (role === 'engineer') return hasMarkedDamage
    if (role === 'radio-operator') return true
    return false
  }

  return (
    <div className="game-page">
      <header className="game-header">
        <div className="team-info">
          <span className={`team-badge ${myTeam}`}>Team {myTeam?.toUpperCase()}</span>
          <span className="roles-badge">{myRoles.join(', ')}</span>
        </div>
        <div className="health-display">
          <span>Health: {'❤️'.repeat(mySub?.health || 0)}{'🖤'.repeat(4 - (mySub?.health || 0))}</span>
        </div>
      </header>

      {/* Role tabs for players with multiple roles */}
      {myRoles.length > 1 && (
        <div className="role-tabs">
          {myRoles.map(role => (
            <button
              key={role}
              className={`role-tab ${activeRole === role ? 'active' : ''} ${roleNeedsAction(role) ? 'needs-action' : ''}`}
              onClick={() => setActiveRole(role)}
            >
              {role}
              {roleNeedsAction(role) && <span className="action-dot">!</span>}
            </button>
          ))}
        </div>
      )}

      <div className="game-content">
        {/* Captain View */}
        {(myRoles.length === 1 ? myRoles.includes('captain') : activeRole === 'captain') && (
          <div className="captain-panel">
            <h2>Captain's Controls</h2>
            <div className="map-container">
              <div className="game-map">
                {SIMPLE_MAP.map((row, y) => (
                  <div key={y} className="map-row">
                    {row.map((cell, x) => {
                      const isMyPos = mySub?.position?.x === x && mySub?.position?.y === y
                      const isPath = mySub?.path?.some(p => p.x === x && p.y === y)
                      return (
                        <div
                          key={x}
                          className={`map-cell ${cell ? 'island' : 'water'} ${isMyPos ? 'submarine' : ''} ${isPath ? 'path' : ''}`}
                          onClick={() => mySub?.systems?.torpedo >= 3 && handleFireTorpedo(x, y)}
                        >
                          {isMyPos && '🔴'}
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>
            </div>

            <div className="movement-controls">
              <button onClick={() => handleMove('N')} disabled={awaitingConfirmation}>
                ⬆️ North
              </button>
              <div className="horizontal-controls">
                <button onClick={() => handleMove('W')} disabled={awaitingConfirmation}>
                  ⬅️ West
                </button>
                <button onClick={() => handleMove('E')} disabled={awaitingConfirmation}>
                  East ➡️
                </button>
              </div>
              <button onClick={() => handleMove('S')} disabled={awaitingConfirmation}>
                ⬇️ South
              </button>
            </div>

            {awaitingConfirmation && (
              <div className="waiting-confirmation">
                <p>Waiting for crew confirmation...</p>
                <div className="confirmed-roles">
                  {confirmedRoles.map(r => <span key={r} className="confirmed">✓ {r}</span>)}
                </div>
              </div>
            )}

            <div className="systems-display">
              <h3>Systems</h3>
              {SYSTEMS.map(sys => (
                <div key={sys.id} className="system-row">
                  <span>{sys.icon} {sys.name}</span>
                  <div className="charge-bar">
                    {Array(sys.max).fill(0).map((_, i) => (
                      <span key={i} className={`charge-pip ${i < (mySub?.systems?.[sys.id] || 0) ? 'filled' : ''}`} />
                    ))}
                  </div>
                  {sys.id === 'torpedo' && mySub?.systems?.torpedo >= 3 && (
                    <button className="fire-btn">FIRE!</button>
                  )}
                </div>
              ))}
            </div>

            {/* Automation Control Panel - only show if there are automated roles */}
            {automatedRoles.length > 0 && (
              <div className="automation-panel">
                <h3>Automation Control</h3>

                {/* First Mate automation - System Priority */}
                {automatedRoles.includes('first-mate') && (
                  <div className="auto-section first-mate-auto">
                    <h4>First Mate Priority</h4>
                    <p className="auto-hint">Systems will be charged in this order:</p>
                    <div className="priority-list">
                      {systemPriority.map((sysId, idx) => {
                        const sys = SYSTEMS.find(s => s.id === sysId)
                        const isFull = (mySub?.systems?.[sysId] || 0) >= sys.max
                        const isNext = sysId === nextAutoCharge
                        return (
                          <div key={sysId} className={`priority-item ${isFull ? 'full' : ''} ${isNext ? 'next' : ''}`}>
                            <span className="priority-rank">{idx + 1}</span>
                            <span className="priority-system">{sys.icon} {sys.name}</span>
                            <span className="priority-status">
                              {mySub?.systems?.[sysId] || 0}/{sys.max}
                            </span>
                            <div className="priority-controls">
                              <button onClick={() => moveSystemPriority(sysId, 'up')} disabled={idx === 0}>▲</button>
                              <button onClick={() => moveSystemPriority(sysId, 'down')} disabled={idx === systemPriority.length - 1}>▼</button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                    {nextAutoCharge && (
                      <p className="next-charge">Next charge: <strong>{SYSTEMS.find(s => s.id === nextAutoCharge)?.name}</strong></p>
                    )}
                  </div>
                )}

                {/* Engineer automation - Direction Status */}
                {automatedRoles.includes('engineer') && (
                  <div className="auto-section engineer-auto">
                    <h4>Engineering Status</h4>
                    <p className="auto-hint">Circuit board damage per direction:</p>
                    <div className="direction-status">
                      {Object.entries(engineerStatus).map(([dir, status]) => (
                        <div key={dir} className={`direction-item ${status.danger}`}>
                          <span className="direction-label">{dir}</span>
                          <div className="damage-indicator">
                            {Array(status.total).fill(0).map((_, i) => (
                              <span key={i} className={`damage-dot ${i >= status.available ? 'damaged' : ''}`} />
                            ))}
                          </div>
                          <span className="danger-label">
                            {status.danger === 'high' ? '⚠️' : status.danger === 'safe' ? '✓' : ''}
                          </span>
                        </div>
                      ))}
                    </div>
                    <div className="direction-recommendation">
                      <strong>Recommended:</strong>{' '}
                      {Object.entries(engineerStatus)
                        .filter(([_, s]) => s.danger === 'safe')
                        .map(([dir]) => dir)
                        .join(', ') || 'All directions have some damage'}
                    </div>
                  </div>
                )}

                {/* Radio Operator automation */}
                {automatedRoles.includes('radio-operator') && (
                  <div className="auto-section radio-auto">
                    <h4>Radio Operator</h4>
                    <p className="auto-status">Auto-confirming moves</p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* First Mate View */}
        {(myRoles.length === 1 ? myRoles.includes('first-mate') : activeRole === 'first-mate') && (
          <div className="first-mate-panel">
            <h2>First Mate's Station</h2>

            {!awaitingConfirmation && (
              <div className="waiting-captain">
                <p>Waiting for Captain to move...</p>
              </div>
            )}

            {awaitingConfirmation && (
              <>
                <div className="move-alert">
                  <p>Captain moved: <strong>{lastMove?.direction}</strong></p>
                  {!hasChargedSystem ? (
                    <p className="action-required">Select a system to charge!</p>
                  ) : (
                    <p className="action-done">✓ System charged</p>
                  )}
                </div>

                <div className="systems-grid">
                  {SYSTEMS.map(sys => (
                    <button
                      key={sys.id}
                      className={`system-btn ${mySub?.systems?.[sys.id] >= sys.max ? 'full' : ''} ${hasChargedSystem ? 'disabled' : ''}`}
                      onClick={() => handleChargeSystem(sys.id)}
                      disabled={hasChargedSystem || mySub?.systems?.[sys.id] >= sys.max}
                    >
                      <span className="system-icon">{sys.icon}</span>
                      <span className="system-name">{sys.name}</span>
                      <div className="charge-bar">
                        {Array(sys.max).fill(0).map((_, i) => (
                          <span key={i} className={`charge-pip ${i < (mySub?.systems?.[sys.id] || 0) ? 'filled' : ''}`} />
                        ))}
                      </div>
                    </button>
                  ))}
                </div>

                {roleCanConfirm('first-mate') && (
                  <button className="aye-btn" onClick={() => handleAyeCaptain('first-mate')}>
                    ⚓ Aye Captain!
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {/* Engineer View */}
        {(myRoles.length === 1 ? myRoles.includes('engineer') : activeRole === 'engineer') && (
          <div className="engineer-panel">
            <h2>Engineer's Station</h2>

            {!awaitingConfirmation && (
              <div className="waiting-captain">
                <p>Waiting for Captain to move...</p>
              </div>
            )}

            {awaitingConfirmation && (
              <>
                <div className="move-alert">
                  <p>Captain moved: <strong>{lastMove?.direction}</strong></p>
                  {!hasMarkedDamage ? (
                    <p className="action-required">Mark damage in the {lastMove?.direction} section!</p>
                  ) : (
                    <p className="action-done">✓ Damage marked</p>
                  )}
                </div>

                <div className="circuit-board">
                  {Object.entries(CIRCUIT_BOARD).map(([direction, slots]) => (
                    <div
                      key={direction}
                      className={`circuit-section ${direction.toLowerCase()} ${lastMove?.direction === direction ? 'active' : ''}`}
                    >
                      <h4>{direction}</h4>
                      <div className="damage-slots">
                        {slots.map(slot => (
                          <button
                            key={slot.id}
                            className={`damage-slot ${damagedSlots.includes(slot.id) ? 'damaged' : ''} ${slot.system}`}
                            onClick={() => handleMarkDamage(slot.id)}
                            disabled={
                              hasMarkedDamage ||
                              damagedSlots.includes(slot.id) ||
                              lastMove?.direction !== direction
                            }
                            title={slot.system}
                          >
                            {damagedSlots.includes(slot.id) ? '✗' : '○'}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="circuit-legend">
                  <span className="legend-item torpedo">Torpedo</span>
                  <span className="legend-item mine">Mine</span>
                  <span className="legend-item drone">Drone</span>
                  <span className="legend-item sonar">Sonar</span>
                  <span className="legend-item silence">Silence</span>
                </div>

                {roleCanConfirm('engineer') && (
                  <button className="aye-btn" onClick={() => handleAyeCaptain('engineer')}>
                    ⚓ Aye Captain!
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {/* Radio Operator View */}
        {(myRoles.length === 1 ? myRoles.includes('radio-operator') : activeRole === 'radio-operator') && (
          <div className="radio-operator-panel">
            <h2>Radio Operator's Station</h2>

            {!awaitingConfirmation && (
              <div className="listening-status">
                <p>🎧 Listening for enemy movements...</p>
              </div>
            )}

            <div className="tracking-controls">
              <h3>Mark Enemy Move</h3>
              <div className="direction-buttons">
                <button onClick={() => handleMarkEnemyMove('N')}>⬆️ N</button>
                <button onClick={() => handleMarkEnemyMove('S')}>⬇️ S</button>
                <button onClick={() => handleMarkEnemyMove('E')}>➡️ E</button>
                <button onClick={() => handleMarkEnemyMove('W')}>⬅️ W</button>
              </div>
            </div>

            <div className="enemy-path">
              <h3>Tracked Path</h3>
              <div className="path-display">
                {enemyPath.length === 0 ? (
                  <span className="no-path">No movements tracked yet</span>
                ) : (
                  enemyPath.map((dir, i) => <span key={i} className="path-step">{dir}</span>)
                )}
              </div>
              <button className="clear-path" onClick={() => setEnemyPath([])}>Clear</button>
            </div>

            <div className="tracking-map">
              <div className="game-map small">
                {SIMPLE_MAP.map((row, y) => (
                  <div key={y} className="map-row">
                    {row.map((cell, x) => (
                      <div
                        key={x}
                        className={`map-cell ${cell ? 'island' : 'water'}`}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </div>

            {roleCanConfirm('radio-operator') && (
              <button className="aye-btn" onClick={() => handleAyeCaptain('radio-operator')}>
                ⚓ Aye Captain!
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default Game
