import { useState, useEffect, useRef } from 'react'
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

function Game({ user }) {
  const { code } = useParams()
  const navigate = useNavigate()
  const audioRef = useRef(null)

  const [game, setGame] = useState(null)
  const [myTeam, setMyTeam] = useState(null)
  const [myRole, setMyRole] = useState(null)
  const [gameState, setGameState] = useState(null)
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false)
  const [confirmedRoles, setConfirmedRoles] = useState([])
  const [enemyPath, setEnemyPath] = useState([]) // Radio operator tracking
  const [lastMove, setLastMove] = useState(null)

  useEffect(() => {
    loadGame()
    connectSocket()

    socket.emit('join-game', { gameCode: code, userId: user.id, username: user.username })

    socket.on('game-state', (state) => setGameState(state))
    socket.on('game-started', (state) => setGameState(state))

    socket.on('move-announced', ({ team, direction, awaitingConfirmation: awaiting }) => {
      setLastMove({ team, direction })
      if (team === myTeam) {
        setAwaitingConfirmation(awaiting)
      }
    })

    socket.on('play-move-sound', ({ team, direction }) => {
      // Server only sends this to enemy team, so just check if we're radio operator
      if (myRole === 'radio-operator') {
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
      }
    })

    socket.on('system-charged', ({ team, system, value }) => {
      setGameState(prev => ({
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
      }))
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

    return () => {
      socket.off('game-state')
      socket.off('game-started')
      socket.off('move-announced')
      socket.off('play-move-sound')
      socket.off('role-confirmed')
      socket.off('turn-complete')
      socket.off('system-charged')
      socket.off('torpedo-hit')
      socket.off('torpedo-miss')
      socket.off('game-over')
    }
  }, [code, user, myTeam, myRole])

  const loadGame = async () => {
    try {
      const response = await api.get(`/games/${code}`)
      setGame(response.data.game)

      const myPlayer = response.data.players.find(p => p.user_id === user.id)
      if (myPlayer) {
        setMyTeam(myPlayer.team)
        setMyRole(myPlayer.role)
        socket.team = myPlayer.team
      }
    } catch (err) {
      console.error('Failed to load game')
    }
  }

  const playMoveSound = (direction) => {
    // Create audio context for move sound
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
    if (myRole !== 'captain' || awaitingConfirmation) return
    socket.emit('captain-move', { gameCode: code, direction })
    // Sound is played via socket event for the OTHER team's radio operator only
  }

  const handleAyeCaptain = () => {
    socket.emit('aye-captain', { gameCode: code, role: myRole })
  }

  const handleChargeSystem = (system) => {
    if (myRole !== 'first-mate') return
    socket.emit('charge-system', { gameCode: code, system })
  }

  const handleMarkEnemyMove = (direction) => {
    setEnemyPath(prev => [...prev, direction])
  }

  const handleFireTorpedo = (x, y) => {
    const mySub = gameState?.submarines[myTeam]
    if (!mySub || mySub.systems.torpedo < 3) return
    socket.emit('fire-torpedo', { gameCode: code, target: { x, y } })
  }

  if (!gameState) {
    return <div className="loading">Loading game...</div>
  }

  const mySub = gameState.submarines[myTeam]
  const enemyTeam = myTeam === 'alpha' ? 'bravo' : 'alpha'

  return (
    <div className="game-page">
      <header className="game-header">
        <div className="team-info">
          <span className={`team-badge ${myTeam}`}>Team {myTeam?.toUpperCase()}</span>
          <span className="role-badge">{myRole}</span>
        </div>
        <div className="health-display">
          <span>Health: {'❤️'.repeat(mySub?.health || 0)}{'🖤'.repeat(4 - (mySub?.health || 0))}</span>
        </div>
      </header>

      <div className="game-content">
        {/* Captain View */}
        {myRole === 'captain' && (
          <div className="captain-panel">
            <h2>Captain's Controls</h2>
            <div className="map-container">
              <div className="game-map">
                {SIMPLE_MAP.map((row, y) => (
                  <div key={y} className="map-row">
                    {row.map((cell, x) => {
                      const isMyPos = mySub?.position.x === x && mySub?.position.y === y
                      const isPath = mySub?.path.some(p => p.x === x && p.y === y)
                      return (
                        <div
                          key={x}
                          className={`map-cell ${cell ? 'island' : 'water'} ${isMyPos ? 'submarine' : ''} ${isPath ? 'path' : ''}`}
                          onClick={() => mySub?.systems.torpedo >= 3 && handleFireTorpedo(x, y)}
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
                      <span key={i} className={`charge-pip ${i < (mySub?.systems[sys.id] || 0) ? 'filled' : ''}`} />
                    ))}
                  </div>
                  {sys.id === 'torpedo' && mySub?.systems.torpedo >= 3 && (
                    <button className="fire-btn">FIRE!</button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* First Mate View */}
        {myRole === 'first-mate' && (
          <div className="first-mate-panel">
            <h2>First Mate's Station</h2>
            {lastMove?.team === myTeam && awaitingConfirmation && (
              <div className="move-alert">
                <p>Captain moved: <strong>{lastMove.direction}</strong></p>
                <p>Charge a system:</p>
              </div>
            )}
            <div className="systems-grid">
              {SYSTEMS.map(sys => (
                <button
                  key={sys.id}
                  className={`system-btn ${mySub?.systems[sys.id] >= sys.max ? 'full' : ''}`}
                  onClick={() => handleChargeSystem(sys.id)}
                  disabled={!awaitingConfirmation || mySub?.systems[sys.id] >= sys.max}
                >
                  <span className="system-icon">{sys.icon}</span>
                  <span className="system-name">{sys.name}</span>
                  <div className="charge-bar">
                    {Array(sys.max).fill(0).map((_, i) => (
                      <span key={i} className={`charge-pip ${i < (mySub?.systems[sys.id] || 0) ? 'filled' : ''}`} />
                    ))}
                  </div>
                </button>
              ))}
            </div>
            {awaitingConfirmation && !confirmedRoles.includes('first-mate') && (
              <button className="aye-btn" onClick={handleAyeCaptain}>
                ⚓ Aye Captain!
              </button>
            )}
          </div>
        )}

        {/* Engineer View */}
        {myRole === 'engineer' && (
          <div className="engineer-panel">
            <h2>Engineer's Station</h2>
            <p>System damage management coming soon...</p>
            {awaitingConfirmation && !confirmedRoles.includes('engineer') && (
              <button className="aye-btn" onClick={handleAyeCaptain}>
                ⚓ Aye Captain!
              </button>
            )}
          </div>
        )}

        {/* Radio Operator View */}
        {myRole === 'radio-operator' && (
          <div className="radio-operator-panel">
            <h2>Radio Operator's Station</h2>
            <p>Listen for enemy movements and track their position!</p>

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

            {awaitingConfirmation && !confirmedRoles.includes('radio-operator') && (
              <button className="aye-btn" onClick={handleAyeCaptain}>
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
