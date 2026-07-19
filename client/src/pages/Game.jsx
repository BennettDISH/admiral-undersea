import { useState, useEffect, useRef, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import api from '../services/api'
import socket, { connectSocket } from '../services/socket'
import MapBoard from '../game/MapBoard'
import EventLog from '../game/EventLog'
import ToastHost from '../game/ToastHost'
import {
  SIMPLE_MAP, SYSTEMS, ENGINEER_SLOTS, CIRCUITS, MAX_HEALTH, NUM_SECTORS,
  TORPEDO_RANGE, SILENCE_RANGE, getSlotsForDirection, sectorOf, isWater, stepCell, reachableWithin,
} from '../game/constants'
import { computeCandidates, traceFrom } from '../game/radio'

const DIRS = ['N', 'S', 'E', 'W']
const REQUIRED = ['first-mate', 'engineer', 'radio-operator']
const cellKey = (x, y) => `${x},${y}`
// action-rejected reasons that are just pacing noise, not worth a toast.
const QUIET_REJECTS = new Set(['awaiting-confirmation', 'cooldown', 'crew-behind', 'already-charged'])

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
  const [lastMove, setLastMove] = useState(null)
  const [hasChargedSystem, setHasChargedSystem] = useState(false)
  const [hasMarkedDamage, setHasMarkedDamage] = useState(false)
  const [damagedSlots, setDamagedSlots] = useState([])

  const [targeting, setTargeting] = useState(null) // 'torpedo'|'mine'|'silence'|'drone'|null
  const [droneReport, setDroneReport] = useState(null)
  const [sonarReport, setSonarReport] = useState(null)
  const [sonarOwed, setSonarOwed] = useState(null)     // { askingTeam } we must answer
  const [sonarForm, setSonarForm] = useState([{ type: 'sector', value: 1 }, { type: 'row', value: 0 }])

  const [radioEvents, setRadioEvents] = useState([])
  const [ghostStart, setGhostStart] = useState(null)
  const [annotations, setAnnotations] = useState([])
  const [enemySurfacedSector, setEnemySurfacedSector] = useState(null)
  const [radioPlacing, setRadioPlacing] = useState('ghost') // 'ghost' | 'annotate'

  const [eventLog, setEventLog] = useState([])
  const [toasts, setToasts] = useState([])
  const [result, setResult] = useState(null)

  const [automatedRoles, setAutomatedRoles] = useState([])
  const [systemPriority, setSystemPriority] = useState(['torpedo', 'mine', 'drone', 'sonar', 'silence'])
  const [tick, setTick] = useState(0) // drives cooldown/surface countdowns

  // Refs so socket handlers read fresh values without re-subscribing.
  const myTeamRef = useRef(null)
  const myRolesRef = useRef([])
  const idRef = useRef(0)

  const mode = gameState?.mode || game?.game_mode || 'turn-based'
  const isLive = mode === 'live'
  const mySub = gameState?.submarines?.[myTeam]
  const enemyTeam = myTeam === 'alpha' ? 'bravo' : 'alpha'

  const pushLog = (kind, text) => setEventLog((prev) => [...prev, { id: ++idRef.current, kind, text }])
  const pushToast = (kind, text) => {
    const id = ++idRef.current
    setToasts((prev) => [...prev, { id, kind, text }])
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000)
  }

  // Countdown ticker (cheap; only meaningful while surfaced or on cooldown).
  useEffect(() => {
    const iv = setInterval(() => setTick((t) => t + 1), 500)
    return () => clearInterval(iv)
  }, [])

  useEffect(() => { myTeamRef.current = myTeam }, [myTeam])
  useEffect(() => { myRolesRef.current = myRoles }, [myRoles])

  useEffect(() => {
    loadGame()
    connectSocket()
    socket.emit('join-game', { gameCode: code })

    const applyState = (state) => {
      setGameState(state)
      if (state.automatedRoles) setAutomatedRoles(state.automatedRoles)
      if (state.systemPriority) setSystemPriority(state.systemPriority)
      // Hydrate turn/engineer UI state from the authoritative snapshot so a mid-game reload
      // or reconnect renders correctly instead of showing a fresh (wrong) turn.
      const sub = state.submarines?.[myTeamRef.current]
      if (sub) {
        setAwaitingConfirmation(!!sub.awaitingConfirmation)
        setConfirmedRoles(sub.confirmedRoles || [])
        setDamagedSlots((sub.damage || []).map((d) => d.slotId))
        setHasChargedSystem(!!sub.chargedThisMove)
      }
    }

    socket.on('game-state', applyState)
    socket.on('game-started', applyState)

    socket.on('move-announced', ({ team, direction, awaitingConfirmation: awaiting }) => {
      const mt = myTeamRef.current
      if (team === mt) {
        setLastMove({ team, direction })
        setAwaitingConfirmation(awaiting)
        setHasChargedSystem(false)
        setHasMarkedDamage(false)
      } else {
        setRadioEvents((prev) => [...prev, { type: 'move', dir: direction }])
        pushLog('move', `Enemy moved ${direction}`)
      }
    })

    socket.on('play-move-sound', ({ direction }) => {
      if (myRolesRef.current.includes('radio-operator')) playMoveSound(direction)
    })

    socket.on('role-confirmed', ({ team, role }) => {
      if (team === myTeamRef.current) setConfirmedRoles((prev) => prev.includes(role) ? prev : [...prev, role])
    })
    socket.on('turn-complete', ({ team }) => {
      if (team === myTeamRef.current) { setAwaitingConfirmation(false); setConfirmedRoles([]); setLastMove(null) }
    })
    socket.on('system-charged', ({ team }) => { if (team === myTeamRef.current) setHasChargedSystem(true) })
    socket.on('damage-marked', ({ team, finalDamagedSlots, completedCircuits }) => {
      if (team !== myTeamRef.current) return
      setHasMarkedDamage(true)
      if (finalDamagedSlots) setDamagedSlots(finalDamagedSlots)
      if (completedCircuits?.length) pushLog('info', `Circuit ${completedCircuits.join(', ')} repaired`)
    })

    socket.on('torpedo-hit', ({ team, damage }) => {
      setTargeting(null)
      if (team === myTeamRef.current) { pushToast('hit', `🎯 Direct hit! ${damage} damage`); pushLog('attack', `Torpedo hit for ${damage}`) }
      else { pushToast('miss', `💥 We were hit! ${damage} damage`); pushLog('attack', `Hit by torpedo for ${damage}`) }
    })
    socket.on('torpedo-miss', ({ team }) => {
      setTargeting(null)
      if (team === myTeamRef.current) { pushToast('miss', 'Torpedo missed'); pushLog('attack', 'Torpedo missed') }
    })
    socket.on('mine-exploded', ({ team, results }) => {
      const mt = myTeamRef.current
      const mine = results?.find((r) => r.team === mt)
      if (mine?.damage > 0) pushToast('miss', `💥 Mine hit us! ${mine.damage} damage`)
      pushLog('attack', team === mt ? 'Our mine detonated' : 'Enemy mine detonated')
    })
    socket.on('mine-placed', () => pushLog('info', 'Mine deployed'))
    socket.on('hull-damage', ({ team, source }) => {
      if (team === myTeamRef.current) { pushToast('miss', `⚠️ Hull damage (${source})`); pushLog('attack', `Hull damage from ${source}`) }
    })

    socket.on('drone-result', ({ sector, inSector }) => {
      setDroneReport({ sector, inSector })
      pushLog('drone', `Drone: enemy ${inSector ? 'IS' : 'is NOT'} in Sector ${sector}`)
    })
    socket.on('sonar-request', ({ askingTeam }) => { setSonarOwed({ askingTeam }); pushLog('sonar', 'Enemy pinged us with sonar — respond') })
    socket.on('sonar-answered', () => setSonarOwed(null)) // server accepted our reply
    socket.on('sonar-result', ({ facts }) => {
      setSonarReport({ facts })
      pushLog('sonar', `Sonar reply: ${facts.map((f) => factLabel(f)).join(' OR ')} (one is false)`)
    })

    socket.on('silence-activated', ({ team }) => {
      if (team !== myTeamRef.current) { setRadioEvents((prev) => [...prev, { type: 'silence' }]); pushLog('silence', 'Enemy went SILENT') }
    })
    socket.on('surface-announced', ({ team, sector }) => {
      if (team === myTeamRef.current) pushLog('surface', `We surfaced in Sector ${sector}`)
      else { setEnemySurfacedSector(sector); setRadioEvents((prev) => [...prev, { type: 'surface', sector }]); pushLog('surface', `Enemy surfaced in Sector ${sector}!`) }
    })
    socket.on('forced-surface', ({ team, sector }) => {
      if (team === myTeamRef.current) pushToast('miss', `Trapped — forced to surface (Sector ${sector})`)
      else { setEnemySurfacedSector(sector); setRadioEvents((prev) => [...prev, { type: 'surface', sector }]) }
      pushLog('surface', `${team === myTeamRef.current ? 'We were' : 'Enemy'} forced to surface in Sector ${sector}`)
    })
    socket.on('resurfaced', ({ team }) => { if (team === enemyTeamOf(myTeamRef.current)) setEnemySurfacedSector(null) })

    socket.on('action-rejected', ({ action, reason }) => {
      if (!QUIET_REJECTS.has(reason)) pushToast('miss', `${action}: ${reason.replace(/-/g, ' ')}`)
    })
    socket.on('game-over', ({ winner }) => setResult({ winner }))
    socket.on('automated-roles-updated', ({ team, automatedRoles: roles }) => { if (team === myTeamRef.current) setAutomatedRoles(roles) })
    socket.on('automation-action', () => {})

    return () => {
      ;['game-state', 'game-started', 'move-announced', 'play-move-sound', 'role-confirmed', 'turn-complete',
        'system-charged', 'damage-marked', 'torpedo-hit', 'torpedo-miss', 'mine-exploded', 'mine-placed',
        'hull-damage', 'drone-result', 'sonar-request', 'sonar-answered', 'sonar-result', 'silence-activated',
        'surface-announced', 'forced-surface', 'resurfaced', 'action-rejected', 'game-over',
        'automated-roles-updated', 'automation-action',
      ].forEach((e) => socket.off(e))
    }
  }, [code])

  const loadGame = async () => {
    try {
      const res = await api.get(`/games/${code}`)
      setGame(res.data.game)
      const me = res.data.players.find((p) => p.user_id === user.id)
      if (me) {
        setMyTeam(me.team)
        const roles = (me.roles || me.role || '').split(',').filter((r) => r && r !== 'unassigned')
        setMyRoles(roles)
        if (roles.length && !activeRole) setActiveRole(roles[0])
        socket.team = me.team
      }
    } catch (err) { console.error('Failed to load game') }
  }

  const playMoveSound = (direction) => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)()
      const osc = ctx.createOscillator(); const gain = ctx.createGain()
      osc.frequency.value = { N: 440, S: 330, E: 550, W: 220 }[direction]
      osc.type = 'sine'
      gain.gain.setValueAtTime(0.3, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5)
      osc.connect(gain); gain.connect(ctx.destination)
      osc.start(); osc.stop(ctx.currentTime + 0.5)
    } catch { /* no audio context */ }
  }

  // ---- emit helpers --------------------------------------------------------
  const emit = (event, payload = {}) => socket.emit(event, { gameCode: code, ...payload })
  const handleMove = (dir) => emit('captain-move', { direction: dir })
  const handleAye = (role) => emit('aye-captain', { role })
  const handleCharge = (system) => emit('charge-system', { system })
  const handleSurface = () => emit('surface')

  const handleMarkDamage = (slotId) => {
    if (!myRoles.includes('engineer')) return
    if (!isLive && (hasMarkedDamage || !lastMove)) return
    const dir = isLive ? mySub?.breakdownQueue?.[0] : lastMove?.direction
    const slot = ENGINEER_SLOTS.find((s) => s.id === slotId)
    if (!slot || slot.dir !== dir || damagedSlots.includes(slotId)) return
    emit('mark-damage', { slotId })
  }

  // ---- captain targeting ---------------------------------------------------
  const torpedoTargets = useMemo(
    () => (mySub?.position ? reachableWithin(mySub.position, TORPEDO_RANGE) : new Set()),
    [mySub?.position?.x, mySub?.position?.y],
  )
  const mineTargets = useMemo(() => {
    const set = new Set()
    if (!mySub?.position) return set
    for (const dir of DIRS) {
      const q = stepCell(mySub.position, dir)
      if (isWater(q.x, q.y) && !(mySub.mines || []).some((m) => m.x === q.x && m.y === q.y)) set.add(cellKey(q.x, q.y))
    }
    return set
  }, [mySub?.position?.x, mySub?.position?.y, mySub?.mines])
  const silenceTargets = useMemo(() => {
    const map = new Map()
    if (!mySub?.position) return map
    const trail = [...(mySub.path || []), mySub.position]
    const onTrail = (x, y) => trail.some((c) => c.x === x && c.y === y)
    map.set(cellKey(mySub.position.x, mySub.position.y), { direction: 'N', distance: 0 })
    for (const dir of DIRS) {
      let c = { ...mySub.position }
      for (let d = 1; d <= SILENCE_RANGE; d++) {
        c = stepCell(c, dir)
        if (!isWater(c.x, c.y) || onTrail(c.x, c.y)) break
        map.set(cellKey(c.x, c.y), { direction: dir, distance: d })
      }
    }
    return map
  }, [mySub?.position?.x, mySub?.position?.y, mySub?.path])

  const activeTargetCells = targeting === 'torpedo' ? torpedoTargets
    : targeting === 'mine' ? mineTargets
    : targeting === 'silence' ? new Set(silenceTargets.keys())
    : null

  const handleTargetCell = (x, y) => {
    if (targeting === 'torpedo') { emit('fire-torpedo', { target: { x, y } }); setTargeting(null) }
    else if (targeting === 'mine') { emit('place-mine', { target: { x, y } }); setTargeting(null) }
    else if (targeting === 'silence') {
      const t = silenceTargets.get(cellKey(x, y))
      if (t) { emit('use-silence', { direction: t.direction, distance: t.distance }); setTargeting(null) }
    }
  }
  const handleSector = (sector) => { if (targeting === 'drone') { emit('launch-drone', { sector }); setTargeting(null) } }

  // Keep the prompt open until the server accepts the reply (it validates one-true-one-false);
  // if rejected, an action-rejected toast fires and the crew can correct + resend.
  const submitSonar = () => emit('sonar-response', { facts: sonarForm })

  // ---- radio deduction -----------------------------------------------------
  const candidates = useMemo(() => computeCandidates(radioEvents), [radioEvents])
  const ghost = useMemo(() => (ghostStart ? traceFrom(ghostStart, radioEvents) : null), [ghostStart, radioEvents])
  const annotationSet = useMemo(() => new Set(annotations), [annotations])
  const handleRadioCell = (x, y) => {
    if (!isWater(x, y)) return
    if (radioPlacing === 'ghost') setGhostStart({ x, y })
    else setAnnotations((prev) => prev.includes(cellKey(x, y)) ? prev.filter((k) => k !== cellKey(x, y)) : [...prev, cellKey(x, y)])
  }

  const moveSystemPriority = (systemId, direction) => {
    const idx = systemPriority.indexOf(systemId)
    if (idx === -1) return
    const to = direction === 'up' ? idx - 1 : idx + 1
    if (to < 0 || to >= systemPriority.length) return
    const next = [...systemPriority]
    next.splice(idx, 1); next.splice(to, 0, systemId)
    setSystemPriority(next)
    emit('set-system-priority', { team: myTeam, systemPriority: next })
  }

  // ---- derived UI state ----------------------------------------------------
  const isSystemBlocked = (id) => ENGINEER_SLOTS.some((s) => s.system === id && damagedSlots.includes(s.id))
  const now = Date.now()
  const surfaced = !!mySub?.surfaced
  const surfaceSecs = surfaced && mySub?.surfacedUntil ? Math.max(0, Math.ceil((mySub.surfacedUntil - now) / 1000)) : 0
  const cooldownSecs = isLive && mySub?.moveCooldownUntil ? Math.max(0, (mySub.moveCooldownUntil - now) / 1000) : 0
  const moveBlocked = surfaced || (isLive ? cooldownSecs > 0 : awaitingConfirmation)
  const legalMoves = gameState?.legalMoves || []

  const engineerStatus = useMemo(() => {
    const status = {}
    DIRS.forEach((dir) => {
      const slots = getSlotsForDirection(dir)
      const available = slots.filter((s) => !damagedSlots.includes(s.id)).length
      status[dir] = { available, total: slots.length, danger: available <= 1 ? 'high' : available === slots.length ? 'safe' : 'medium' }
    })
    return status
  }, [damagedSlots])

  const nextAutoCharge = useMemo(() => {
    if (!mySub) return null
    for (const id of systemPriority) {
      const sys = SYSTEMS.find((s) => s.id === id)
      if (sys && (mySub.systems?.[id] || 0) < sys.max) return id
    }
    return null
  }, [mySub, systemPriority])

  const roleActive = (role) => (myRoles.length === 1 ? myRoles.includes(role) : activeRole === role)
  const roleNeedsAction = (role) => {
    if (isLive) {
      if (role === 'first-mate') return (mySub?.chargeTokens || 0) > 0
      if (role === 'engineer') return (mySub?.breakdownQueue?.length || 0) > 0
      return false
    }
    if (!awaitingConfirmation || confirmedRoles.includes(role)) return false
    if (role === 'first-mate') return !hasChargedSystem
    if (role === 'engineer') return !hasMarkedDamage
    return role === 'radio-operator'
  }
  const roleCanConfirm = (role) => {
    if (isLive || !awaitingConfirmation || confirmedRoles.includes(role)) return false
    if (role === 'first-mate') return hasChargedSystem
    if (role === 'engineer') return hasMarkedDamage
    return role === 'radio-operator'
  }

  if (!gameState) return <div className="loading">Loading game...</div>

  if (result) {
    const iWon = result.winner === myTeam
    return (
      <div className="game-page">
        <div className="game-result">
          <h1>{iWon ? '🏆 Victory!' : '💀 Defeat'}</h1>
          <p>Team {result.winner?.toUpperCase()} sank the enemy submarine.</p>
          <button className="aye-btn" onClick={() => navigate('/')}>Back to Home</button>
        </div>
      </div>
    )
  }

  const health = mySub?.health ?? 0

  return (
    <div className="game-page">
      <header className="game-header">
        <div className="team-info">
          <span className={`team-badge ${myTeam}`}>Team {myTeam?.toUpperCase()}</span>
          <span className="roles-badge">{myRoles.join(', ')}</span>
          <span className={`mode-badge ${mode}`}>{isLive ? '⚡ Live' : '🔄 Turn-Based'}</span>
        </div>
        <div className="health-display">
          Health: {'❤️'.repeat(Math.max(0, health))}{'🖤'.repeat(Math.max(0, MAX_HEALTH - health))}
        </div>
      </header>

      {surfaced && (
        <div className="surface-banner">🌊 SURFACED — Sector {mySub.surfacedSector} exposed{surfaceSecs > 0 ? ` · diving in ${surfaceSecs}s` : ''}. Systems offline.</div>
      )}

      {myRoles.length > 1 && (
        <div className="role-tabs">
          {myRoles.map((role) => (
            <button key={role} className={`role-tab ${activeRole === role ? 'active' : ''} ${roleNeedsAction(role) ? 'needs-action' : ''}`} onClick={() => setActiveRole(role)}>
              {role}{roleNeedsAction(role) && <span className="action-dot">!</span>}
            </button>
          ))}
        </div>
      )}

      <div className="game-content">
        {/* ---------------- CAPTAIN ---------------- */}
        {roleActive('captain') && (
          <div className="captain-panel">
            <h2>Captain's Controls</h2>
            {targeting && (
              <div className="targeting-hint">
                {targeting === 'torpedo' && '🎯 Select a target cell (within range).'}
                {targeting === 'mine' && '◆ Select an adjacent cell to drop a mine.'}
                {targeting === 'silence' && '🤫 Select a cell to move to silently (0–4 straight).'}
                {targeting === 'drone' && '📡 Click a sector to scan.'}
                <button className="cancel-target" onClick={() => setTargeting(null)}>Cancel</button>
              </div>
            )}
            <div className="captain-layout">
              <div className="captain-left">
                <MapBoard
                  submarine={mySub}
                  mines={mySub?.mines || []}
                  overlay={targeting === 'drone' ? 'drone-sector' : targeting || 'none'}
                  legalCells={activeTargetCells}
                  onCellClick={handleTargetCell}
                  onSectorClick={handleSector}
                />
                <div className="movement-controls">
                  <button onClick={() => handleMove('N')} disabled={moveBlocked || !legalMoves.includes('N')}>⬆️ N</button>
                  <div className="horizontal-controls">
                    <button onClick={() => handleMove('W')} disabled={moveBlocked || !legalMoves.includes('W')}>⬅️ W</button>
                    <button onClick={() => handleMove('E')} disabled={moveBlocked || !legalMoves.includes('E')}>E ➡️</button>
                  </div>
                  <button onClick={() => handleMove('S')} disabled={moveBlocked || !legalMoves.includes('S')}>⬇️ S</button>
                  {isLive && cooldownSecs > 0 && <div className="cooldown-timer">reload {cooldownSecs.toFixed(1)}s</div>}
                  {!surfaced && legalMoves.length === 0 && <div className="trapped-hint">Trapped! You must surface.</div>}
                </div>
              </div>

              <div className="captain-right">
                {!isLive && awaitingConfirmation && (
                  <div className="waiting-confirmation">
                    <p>Waiting for crew…</p>
                    <div className="confirmed-roles">{confirmedRoles.map((r) => <span key={r} className="confirmed">✓ {r}</span>)}</div>
                  </div>
                )}

                <div className="systems-rail">
                  <h3>Systems</h3>
                  {SYSTEMS.map((sys) => {
                    const val = mySub?.systems?.[sys.id] || 0
                    const ready = val >= sys.max && !isSystemBlocked(sys.id) && !surfaced
                    return (
                      <div key={sys.id} className={`system-control ${ready ? 'ready' : ''} ${isSystemBlocked(sys.id) ? 'blocked' : ''}`}>
                        <span className="system-label">{sys.icon} {sys.name}</span>
                        <div className="charge-bar">
                          {Array(sys.max).fill(0).map((_, i) => <span key={i} className={`charge-pip ${i < val ? 'filled' : ''}`} />)}
                        </div>
                        {ready && sys.id !== 'sonar' && (
                          <button className={`activate-btn ${targeting === sys.id ? 'active' : ''}`} onClick={() => setTargeting((t) => t === sys.id ? null : sys.id)}>
                            {targeting === sys.id ? 'Cancel' : 'USE'}
                          </button>
                        )}
                        {ready && sys.id === 'sonar' && (
                          <button className="activate-btn" onClick={() => emit('use-sonar')}>PING</button>
                        )}
                      </div>
                    )
                  })}
                  <div className="system-control surface-control">
                    <span className="system-label">🌊 Surface</span>
                    <button className="activate-btn danger" onClick={handleSurface} disabled={surfaced}>SURFACE</button>
                  </div>
                </div>

                {(droneReport || sonarReport || (mySub?.mines?.length > 0)) && (
                  <div className="captain-reports">
                    {droneReport && (
                      <div className="drone-report">
                        <h4>📡 Drone</h4>
                        <span className={`drone-answer ${droneReport.inSector ? 'yes' : 'no'}`}>Enemy {droneReport.inSector ? 'IS' : 'is NOT'} in Sector {droneReport.sector}</span>
                      </div>
                    )}
                    {sonarReport && (
                      <div className="sonar-report">
                        <h4>🔊 Sonar (one is a lie)</h4>
                        {sonarReport.facts.map((f, i) => <div key={i} className="sonar-fact">{factLabel(f)}</div>)}
                      </div>
                    )}
                    {mySub?.mines?.length > 0 && (
                      <div className="mine-list">
                        <h4>💥 Deployed mines</h4>
                        {mySub.mines.map((m) => (
                          <div key={cellKey(m.x, m.y)} className="mine-item">
                            <span>({m.x}, {m.y})</span>
                            <button className="detonate-btn" onClick={() => emit('detonate-mine', { target: { x: m.x, y: m.y } })} disabled={surfaced}>Detonate</button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {automatedRoles.length > 0 && (
                  <div className="automation-panel">
                    <h3>Automation Control</h3>
                    {automatedRoles.includes('first-mate') && (
                      <div className="auto-section">
                        <h4>First Mate Priority</h4>
                        <div className="priority-list">
                          {systemPriority.map((sysId, idx) => {
                            const sys = SYSTEMS.find((s) => s.id === sysId)
                            if (!sys) return null
                            const isFull = (mySub?.systems?.[sysId] || 0) >= sys.max
                            return (
                              <div key={sysId} className={`priority-item ${isFull ? 'full' : ''} ${sysId === nextAutoCharge ? 'next' : ''}`}>
                                <span className="priority-rank">{idx + 1}</span>
                                <span className="priority-system">{sys.icon} {sys.name}</span>
                                <span className="priority-status">{mySub?.systems?.[sysId] || 0}/{sys.max}</span>
                                <div className="priority-controls">
                                  <button onClick={() => moveSystemPriority(sysId, 'up')} disabled={idx === 0}>▲</button>
                                  <button onClick={() => moveSystemPriority(sysId, 'down')} disabled={idx === systemPriority.length - 1}>▼</button>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}
                    {automatedRoles.includes('engineer') && (
                      <div className="auto-section">
                        <h4>Engineering Status</h4>
                        <div className="direction-status">
                          {Object.entries(engineerStatus).map(([dir, s]) => (
                            <div key={dir} className={`direction-item ${s.danger}`}>
                              <span className="direction-label">{dir}</span>
                              <span className="danger-label">{s.available}/{s.total}{s.danger === 'high' ? ' ⚠️' : ''}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {automatedRoles.includes('radio-operator') && <div className="auto-section"><h4>Radio Operator</h4><p className="auto-status">Auto-confirming moves</p></div>}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ---------------- FIRST MATE ---------------- */}
        {roleActive('first-mate') && (
          <div className="first-mate-panel">
            <h2>First Mate's Station</h2>
            {isLive ? (
              <div className="token-tray">
                <span>Charge tokens:</span>
                {Array(Math.max(0, mySub?.chargeTokens || 0)).fill(0).map((_, i) => <span key={i} className="token-pip" />)}
                <strong>{mySub?.chargeTokens || 0}</strong>
              </div>
            ) : !awaitingConfirmation ? (
              <div className="waiting-captain"><p>Waiting for Captain to move…</p></div>
            ) : (
              <div className="move-alert">
                <p>Captain moved: <strong>{lastMove?.direction}</strong></p>
                {!hasChargedSystem ? <p className="action-required">Charge a system!</p> : <p className="action-done">✓ System charged</p>}
              </div>
            )}
            {(isLive || awaitingConfirmation) && (
              <div className="systems-grid">
                {SYSTEMS.map((sys) => {
                  const val = mySub?.systems?.[sys.id] || 0
                  const full = val >= sys.max
                  const disabled = full || (isLive ? (mySub?.chargeTokens || 0) <= 0 : hasChargedSystem)
                  return (
                    <button key={sys.id} className={`system-btn ${full ? 'full' : ''} ${disabled ? 'disabled' : ''} ${full ? 'ready' : ''}`} onClick={() => handleCharge(sys.id)} disabled={disabled}>
                      <span className="system-icon">{sys.icon}</span>
                      <span className="system-name">{sys.name}</span>
                      <div className="charge-bar">{Array(sys.max).fill(0).map((_, i) => <span key={i} className={`charge-pip ${i < val ? 'filled' : ''}`} />)}</div>
                    </button>
                  )
                })}
              </div>
            )}
            {roleCanConfirm('first-mate') && <button className="aye-btn" onClick={() => handleAye('first-mate')}>⚓ Aye Captain!</button>}
          </div>
        )}

        {/* ---------------- ENGINEER ---------------- */}
        {roleActive('engineer') && (
          <div className="engineer-panel">
            <h2>Engineer's Station</h2>
            {isLive ? (
              <div className="breakdown-queue"><span>Breakdowns to mark:</span> <strong>{mySub?.breakdownQueue?.length || 0}</strong>
                {(mySub?.breakdownQueue || []).map((d, i) => <span key={i} className="queue-dir">{d}</span>)}
              </div>
            ) : !awaitingConfirmation ? (
              <div className="waiting-captain"><p>Waiting for Captain to move…</p></div>
            ) : (
              <div className="move-alert">
                <p>Captain moved: <strong>{lastMove?.direction}</strong></p>
                {!hasMarkedDamage ? <p className="action-required">Mark a breakdown in the {lastMove?.direction} section!</p> : <p className="action-done">✓ Breakdown marked</p>}
              </div>
            )}
            <div className="circuit-board">
              {DIRS.map((dir) => {
                const activeDir = isLive ? mySub?.breakdownQueue?.[0] : lastMove?.direction
                const isActive = activeDir === dir && (isLive ? (mySub?.breakdownQueue?.length || 0) > 0 : awaitingConfirmation)
                return (
                  <div key={dir} className={`circuit-section ${dir.toLowerCase()} ${isActive ? 'active' : ''}`}>
                    <h4>{dir} {engineerStatus[dir].available <= 1 && <span className="hull-risk-flag">⚠️ hull!</span>}</h4>
                    <div className="damage-slots">
                      {getSlotsForDirection(dir).map((slot) => {
                        const isDamaged = damagedSlots.includes(slot.id)
                        return (
                          <button key={slot.id} className={`damage-slot ${isDamaged ? 'damaged' : ''} ${slot.system} circuit-${slot.circuit}`}
                            onClick={() => handleMarkDamage(slot.id)} disabled={(isLive ? false : hasMarkedDamage) || isDamaged || !isActive}
                            title={`${slot.system} (Circuit ${slot.circuit})`}>
                            <span className="slot-circuit">{slot.circuit}</span>{isDamaged ? '✗' : '○'}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="circuit-legend">
              <p className="circuit-hint">Complete all 4 slots in a circuit (A–D) to auto-repair. Filling a whole direction costs 1 hull!</p>
            </div>
            <div className="blocked-systems">
              <h4>System Status</h4>
              <div className="system-status-grid">
                {SYSTEMS.map((sys) => <span key={sys.id} className={`system-status ${isSystemBlocked(sys.id) ? 'blocked' : 'ok'}`}>{sys.icon} {isSystemBlocked(sys.id) ? '✗' : '✓'}</span>)}
              </div>
            </div>
            {roleCanConfirm('engineer') && <button className="aye-btn" onClick={() => handleAye('engineer')}>⚓ Aye Captain!</button>}
          </div>
        )}

        {/* ---------------- RADIO OPERATOR ---------------- */}
        {roleActive('radio-operator') && (
          <div className="radio-operator-panel">
            <h2>Radio Operator's Station</h2>
            <div className="radio-tools">
              <div className="candidate-count">Possible enemy positions: <strong>{candidates.size}</strong></div>
              <div className="radio-mode-toggle">
                <button className={radioPlacing === 'ghost' ? 'active' : ''} onClick={() => setRadioPlacing('ghost')}>Place guess</button>
                <button className={radioPlacing === 'annotate' ? 'active' : ''} onClick={() => setRadioPlacing('annotate')}>Annotate</button>
                <button onClick={() => { setGhostStart(null); setAnnotations([]) }}>Clear</button>
              </div>
              {ghost && (
                <div className={`ghost-status ${ghost.valid ? 'valid' : 'invalid'}`}>
                  {ghost.valid ? (ghost.uncertain ? 'Guess valid so far (enemy went silent — path uncertain)' : `Guess valid — enemy would be at (${ghost.path.at(-1)?.x}, ${ghost.path.at(-1)?.y})`) : 'Guess impossible — path hits land, edge, or crosses itself'}
                </div>
              )}
            </div>
            <MapBoard
              small
              overlay="radio"
              onCellClick={handleRadioCell}
              candidates={candidates}
              ghostStart={ghostStart}
              ghostPath={ghost?.path || []}
              annotations={annotationSet}
              enemySurfacedSector={enemySurfacedSector}
            />
            <div className="tracked-path">
              <h4>Heard so far</h4>
              <div className="path-display">
                {radioEvents.length === 0 ? <span className="no-path">Nothing yet…</span> :
                  radioEvents.map((e, i) => <span key={i} className="path-step">{e.type === 'move' ? e.dir : e.type === 'silence' ? '🤫' : `⤒${e.sector}`}</span>)}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Sonar answer prompt (any crew member can answer for the enemy ping) */}
      {sonarOwed && (
        <div className="sonar-answer-modal">
          <div className="sonar-answer-card">
            <h3>🔊 Enemy pinged us — send a reply</h3>
            <p>Give two facts about our position. Exactly one must be TRUE and one FALSE (they won't know which).</p>
            {[0, 1].map((i) => (
              <div key={i} className="sonar-fact-input">
                <select value={sonarForm[i].type} onChange={(e) => setSonarForm((f) => f.map((x, j) => j === i ? { ...x, type: e.target.value } : x))}>
                  <option value="row">Row (y)</option>
                  <option value="col">Column (x)</option>
                  <option value="sector">Sector</option>
                </select>
                <input type="number" value={sonarForm[i].value} onChange={(e) => setSonarForm((f) => f.map((x, j) => j === i ? { ...x, value: Number(e.target.value) } : x))} />
              </div>
            ))}
            <p className="sonar-hint">Our position: row {mySub?.position?.y}, col {mySub?.position?.x}, sector {mySub?.position && sectorOf(mySub.position.x, mySub.position.y)}</p>
            <button className="aye-btn" onClick={submitSonar}>Send reply</button>
          </div>
        </div>
      )}

      <ToastHost toasts={toasts} />
      <EventLog entries={eventLog} />
    </div>
  )
}

const enemyTeamOf = (team) => (team === 'alpha' ? 'bravo' : 'alpha')
function factLabel(f) {
  if (f.type === 'row') return `Row ${f.value}`
  if (f.type === 'col') return `Column ${f.value}`
  if (f.type === 'sector') return `Sector ${f.value}`
  return JSON.stringify(f)
}

export default Game
