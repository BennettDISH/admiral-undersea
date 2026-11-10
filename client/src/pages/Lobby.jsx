import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import api from '../services/api'
import socket, { connectSocket } from '../services/socket'
import { joinGameOnConnect } from '../lib/gameRoom'
import { useScene } from '../lib/useScene'
import { getAudio } from '../lib/audio'
import { Portrait } from '../game/CrewPanel'
import { STATIONS, STATION_INFO, TEAM_INFO, isVsAi, isTutorial, aiLevelOf } from '../game/rules'
import { loadArt } from '../game/sprites'

const rolesOf = (p) => (p?.roles || '').split(',').filter((r) => STATIONS.includes(r))

// The muster: pick a boat and the stations you will run; any station nobody takes goes to the
// auto-crew. Against the AI there is one boat to crew. The creator gives the order to dive; the
// tutorial seats its player at every station and dives by itself.
function Lobby({ user }) {
  const { code } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  useScene('menu')
  useEffect(() => { loadArt() }, [])
  const [game, setGame] = useState(null)
  const [players, setPlayers] = useState([])
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const autoSeated = useRef(false)

  const load = useCallback(async () => {
    try {
      const res = await api.get(`/games/${code}`)
      setGame(res.data.game)
      setPlayers(res.data.players)
      if (res.data.game.status === 'playing') navigate(`/game/${code}`)
      return res.data
    } catch {
      setError('No game with that code')
      return null
    }
  }, [code, navigate])

  useEffect(() => {
    load()
    connectSocket(user.id)
    const stopJoining = joinGameOnConnect(socket, code)
    const reload = () => load()
    const started = () => { getAudio().play('klaxon'); navigate(`/game/${code}`) }
    const refused = (r) => { if (r?.message) setError(r.message) }
    socket.on('player-joined', reload)
    socket.on('player-left', reload)
    socket.on('team-updated', reload)
    socket.on('roles-updated', reload)
    socket.on('game-started', started)
    socket.on('action-rejected', refused)
    return () => {
      stopJoining()
      socket.off('player-joined', reload)
      socket.off('player-left', reload)
      socket.off('team-updated', reload)
      socket.off('roles-updated', reload)
      socket.off('game-started', started)
      socket.off('action-rejected', refused)
    }
  }, [code, user.id, load, navigate])

  const me = players.find((p) => p.user_id === user.id)
  const myTeam = me?.team || null
  const myRoles = rolesOf(me)
  const vsAi = isVsAi(game?.game_mode)
  const tutorial = isTutorial(game?.game_mode)
  const level = aiLevelOf(game?.game_mode)

  const pickTeam = (team) => socket.emit('select-team', { gameCode: code, team })
  const setRoles = (roles) => socket.emit('select-roles', { gameCode: code, roles })

  // Against the AI: come aboard the one boat straight away; whoever made the game takes every
  // station to start with (drop any for the auto-crew).
  const rolesPicked = useRef(false)
  useEffect(() => {
    if (!game || !vsAi || game.status !== 'lobby') return
    if (!me && !autoSeated.current) {
      autoSeated.current = true
      // Only once this socket has joined the game (join-game goes out first on a connect), or the
      // server ignores the seat.
      if (socket.connected) pickTeam('alpha')
      else socket.once('connect', () => setTimeout(() => pickTeam('alpha'), 50))
    } else if (me && me.team === 'alpha' && rolesOf(me).length === 0 && !rolesPicked.current) {
      rolesPicked.current = true
      const taken = new Set(players.filter((p) => p.team === 'alpha').flatMap(rolesOf))
      setRoles(game.created_by === user.id ? STATIONS : STATIONS.filter((s) => !taken.has(s)).slice(0, 2))
    }
  }, [game, vsAi, me, players, user.id])

  // The tutorial: once its player holds every station, dive.
  const dived = useRef(false)
  useEffect(() => {
    if (!tutorial || !game || game.status !== 'lobby' || game.created_by !== user.id || dived.current) return
    if (me?.team === 'alpha' && STATIONS.every((s) => rolesOf(me).includes(s))) {
      dived.current = true
      socket.emit('start-game', { gameCode: code })
    }
  }, [tutorial, game, me, user.id, code])

  const toggle = (station) => {
    const next = myRoles.includes(station) ? myRoles.filter((r) => r !== station) : [...myRoles, station]
    setRoles(STATIONS.filter((s) => next.includes(s)))
  }

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/lobby/${code}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch { /* no clipboard: the code is on screen */ }
  }

  if (error && !game) return <div className="deck-page error-page"><p>{error}</p><button onClick={() => navigate('/')}>Back to the deck</button></div>
  if (!game) return <div className="game-page waiting"><div className="sonar-loader" aria-hidden="true" /><p>Mustering…</p></div>

  const isCreator = game.created_by === user.id
  const teams = vsAi ? ['alpha'] : ['alpha', 'bravo']
  const lim = location.state || {}
  const capNote = lim.madeToday >= (lim.dayCap ?? 60) - 5
    ? `You have made ${lim.madeToday} of ${lim.dayCap} games today; past that, new ones wait until tomorrow.`
    : lim.openLobbies >= (lim.lobbyCap ?? 10) - 2 ? `You have ${lim.openLobbies} of ${lim.lobbyCap} open lobbies; start or leave some before making more.` : ''
  const modeLine = tutorial ? 'Tutorial: a training boat waits out there' : level ? `Against the computer's boat: ${level.name}` : 'Crew against crew'

  return (
    <div className="lobby-page deck-page">
      <header className="muster-head">
        <div>
          <h1>{tutorial ? 'Making ready for your first dive…' : vsAi ? 'Make ready to dive' : 'Muster the crews'}</h1>
          <p className="muster-mode">{modeLine}</p>
        </div>
        <button className="code-chip" onClick={copyLink} title="Copy the link to this lobby">
          <span>Code</span><strong>{code}</strong><em>{copied ? 'link copied' : 'copy link'}</em>
        </button>
      </header>
      {capNote && <div className="deck-note">{capNote}</div>}
      {error && <div className="error-message">{error}</div>}

      <div className={`boats ${vsAi ? 'one' : 'two'}`}>
        {teams.map((team) => {
          const aboard = players.filter((p) => p.team === team)
          return (
            <section key={team} className={`boat-card team-${team} ${myTeam === team ? 'mine' : ''}`}>
              <header>
                <h2>{TEAM_INFO[team].boat}</h2>
                {myTeam !== team && <button onClick={() => pickTeam(team)}>Join this boat</button>}
                {myTeam === team && <span className="aboard-tag">You are aboard</span>}
              </header>
              <ul className="stations">
                {STATIONS.map((s) => {
                  const holders = aboard.filter((p) => rolesOf(p).includes(s))
                  const mine = myTeam === team && myRoles.includes(s)
                  return (
                    <li key={s} className={`station-row ${mine ? 'mine' : ''} ${holders.length ? 'held' : 'auto'}`}>
                      <Portrait station={s} size={48} />
                      <div className="sr-text">
                        <strong>{STATION_INFO[s].room}</strong>
                        <span>{STATION_INFO[s].job}</span>
                        <em>{holders.length ? holders.map((p) => p.username).join(', ') : 'auto-crew'}</em>
                      </div>
                      {myTeam === team && <button className={mine ? 'on' : ''} onClick={() => toggle(s)}>{mine ? 'Leave' : 'Take'}</button>}
                    </li>
                  )
                })}
              </ul>
              {aboard.filter((p) => rolesOf(p).length === 0).length > 0 && (
                <p className="hint">Aboard without a station: {aboard.filter((p) => rolesOf(p).length === 0).map((p) => p.username).join(', ')}</p>
              )}
            </section>
          )
        })}
        {vsAi && (
          <section className="boat-card team-bravo enemy">
            <header>
              <h2>{tutorial ? 'Training boat' : TEAM_INFO.bravo.boat}</h2>
              <span className="aboard-tag">{tutorial ? 'Training' : `Computer crew · ${level?.name || 'Normal'}`}</span>
            </header>
            <p className="enemy-note">{tutorial ? 'An old hulk run by the instructors. It will make noise for you to find, and fire one slow practice torpedo.' : level?.note || 'Somewhere out there, running quiet.'}</p>
          </section>
        )}
      </div>

      <div className="muster-actions">
        {isCreator ? (
          <button className="primary dive-btn" onClick={() => socket.emit('start-game', { gameCode: code })} disabled={!myTeam}>
            {myTeam ? 'Dive!' : 'Pick a boat first'}
          </button>
        ) : (
          <p className="hint">Waiting for whoever made the game to give the order to dive…</p>
        )}
        <button className="deck-small" onClick={() => navigate('/')}>Leave</button>
      </div>
    </div>
  )
}

export default Lobby
