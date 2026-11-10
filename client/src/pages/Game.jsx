import { useEffect, useMemo, useRef, useState, useSyncExternalStore, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import api from '../services/api'
import { getAudio } from '../lib/audio'
import { useScene } from '../lib/useScene'
import { useMatch } from '../game/useMatch'
import ChartCanvas from '../game/ChartCanvas'
import CrewPanel from '../game/CrewPanel'
import TutorialCard from '../game/TutorialCard'
import { HelmStation, ListeningStation, TorpedoStation, EngineStation } from '../game/Stations'
import { react, ending, newMemory } from '../game/reactions'
import { LINES, speakerOf } from '../game/voice'
import { LESSONS } from '../game/tutorial'
import { loadArt } from '../game/sprites'
import {
  STATIONS, STATION_INFO, TEAM_INFO, HULL_MAX, MATCH_SECONDS, CALLS, chart, headingFor, bearing, clockText, enemyOf, modeId,
} from '../game/rules'

const SHAKES = { big: { px: 10, ms: 600 }, small: { px: 4, ms: 380 } }
const reduceMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
const PANELS = { helm: HelmStation, listener: ListeningStation, weapons: TorpedoStation, chief: EngineStation }

function Hull({ hull, label, side }) {
  return (
    <div className={`hull-read ${side}`} aria-label={`${label}: hull ${hull} of ${HULL_MAX}`}>
      <span className="hull-label">{label}</span>
      <span className="hull-pips">{Array.from({ length: HULL_MAX }, (_, i) => <i key={i} className={i < hull ? 'on' : ''} />)}</span>
    </div>
  )
}

function SoundControls() {
  const audio = getAudio()
  const prefs = useSyncExternalStore(audio.subscribe, audio.snapshot, audio.snapshot)
  return (
    <div className="sound-controls">
      <button type="button" className={`sound-toggle ${prefs.muted ? 'muted' : ''}`} onClick={() => audio.toggleMute()} aria-pressed={prefs.muted} aria-label={prefs.muted ? 'Sound off. Turn sound on' : 'Sound on. Mute'}>
        {prefs.muted ? '🔇' : '🔊'}
      </button>
      <label className="music-level" title="Music">
        <span>♪</span>
        <input type="range" min="0" max="1" step="0.05" value={prefs.music} onChange={(e) => audio.setPrefs({ music: Number(e.target.value) })} aria-label="Music level" />
      </label>
    </div>
  )
}

function Game({ user }) {
  const { code } = useParams()
  const navigate = useNavigate()
  const { game, players, seat, view, contacts, over, refusal, send, onFx, joins } = useMatch(code, user)
  const audio = getAudio()
  useScene('game')
  useEffect(() => { loadArt() }, [])

  const team = view?.team || seat?.team
  const myRoles = useMemo(() => seat?.roles || [], [seat])
  const [active, setActive] = useState(null)
  const [aim, setAim] = useState(null)
  const [guideId, setGuideId] = useState(null)
  const [effects, setEffects] = useState([])
  const [log, setLog] = useState([])
  const [speaking, setSpeaking] = useState(null) // { station, caption }
  const [alarmUntil, setAlarmUntil] = useState(0)
  const [toast, setToast] = useState(null)
  const [stats, setStats] = useState({ shots: 0, landed: 0, taken: 0 })
  const memory = useRef(newMemory())
  const pageRef = useRef(null)
  const flashRef = useRef(null)
  const lastHitAt = useRef(0)
  const viewRef = useRef(view)
  viewRef.current = view
  const logId = useRef(0)

  useEffect(() => { if (!active && myRoles.length) setActive(myRoles[0]) }, [myRoles, active])
  // the station on screen is the one this player works; the auto-crew covers their others
  useEffect(() => { if (active && joins) send('focus', { station: active }) }, [active, joins, send])

  // a line spoken: the face that says it talks, with the words under it
  const speak = useCallback((name) => {
    if (!name) return
    const station = speakerOf(name)
    const said = audio.say(name)
    const caption = LINES[name]
    const startIn = said ? said.startIn : 0
    const seconds = said ? said.seconds : 1.8
    setTimeout(() => setSpeaking({ station, caption }), startIn * 1000)
    setTimeout(() => setSpeaking((s) => (s && s.caption === caption ? null : s)), (startIn + seconds + 0.3) * 1000)
  }, [audio])

  const feel = useCallback((shake, flash) => {
    if (reduceMotion()) return
    const s = SHAKES[shake]
    if (s && pageRef.current?.animate) {
      const p = s.px
      pageRef.current.animate([
        { transform: 'translate(0,0)' }, { transform: `translate(${-p}px,${p * 0.4}px)` }, { transform: `translate(${p * 0.8}px,${-p * 0.5}px)` },
        { transform: `translate(${-p * 0.5}px,${p * 0.3}px)` }, { transform: `translate(${p * 0.3}px,0)` }, { transform: 'translate(0,0)' },
      ], { duration: s.ms, easing: 'ease-out' })
    }
    if (flash) flashRef.current?.animate?.([{ opacity: 0.65 }, { opacity: 0 }], { duration: 700, easing: 'ease-out' })
  }, [])

  // every event from the server: sounds, a line, something on the chart, the log
  useEffect(() => onFx((ev) => {
    const v = viewRef.current
    const cue = react(ev, { team, boat: v?.boat, now: Date.now(), memory: memory.current })
    for (const [name, opts] of cue.sounds) audio.play(name, opts)
    if (cue.say) speak(cue.say)
    if (cue.then) setTimeout(() => speak(cue.then.name), (cue.then.delay || 0) * 1000)
    if (cue.alarm) setAlarmUntil(Date.now() + cue.alarm * 1000)
    if (cue.shake || cue.flash) feel(cue.shake, cue.flash)
    if (cue.visual?.kind === 'blast') setEffects((list) => [...list.filter((e) => performance.now() - e.at < 3000), { ...cue.visual, at: performance.now() }])
    if (ev.type === 'hit') { lastHitAt.current = Date.now(); setStats((s) => (ev.team === team ? { ...s, taken: s.taken + ev.damage } : ev.cause === 'torpedo' ? { ...s, landed: s.landed + ev.damage } : s)) }
    if (ev.type === 'fired') setStats((s) => ({ ...s, shots: s.shots + 1 }))
    if (ev.type === 'fired' || ev.type === 'torpedo-spent') setAim(null)
    if (cue.log) {
      const id = ++logId.current
      setLog((l) => [...l.slice(-40), { id, ...cue.log, t: v?.t ?? 0 }])
    }
  }), [onFx, team, audio, speak, feel])

  // the tutorial: each new lesson brings its station up on screen, with a beep from the console
  const lesson = view?.tutorial?.step
  useEffect(() => {
    if (!lesson || view?.over) return
    const station = LESSONS[lesson]?.station
    if (station && myRoles.includes(station)) setActive(station)
    audio.play('ui.beep', { pitch: 1.2, vol: 0.7 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lesson])

  // the server said no: a short note, unless it is only pacing
  useEffect(() => {
    if (!refusal || ['too-soon', 'not-charged', 'tube-busy'].includes(refusal.reason)) return
    setToast(refusal.message || `${refusal.action}: ${String(refusal.reason).replace(/-/g, ' ')}`)
    audio.play('ui.beep', { pitch: 0.6 })
    if (refusal.reason === 'too-close') speak('voice.weapons.too-close')
    const id = setTimeout(() => setToast(null), 3200)
    return () => clearTimeout(id)
  }, [refusal, audio, speak])

  // the dive, once, as the match starts
  const dived = useRef(false)
  useEffect(() => {
    if (!view || dived.current) return
    dived.current = true
    if (view.t < 6 && !view.over) {
      audio.play('klaxon')
      audio.play('dive', { delay: 0.6 })
      setTimeout(() => speak('voice.deck.dive'), 400)
    }
  }, [view, audio, speak])

  // the music follows the hunt; a running torpedo and a fire or flood have their own loops
  useEffect(() => {
    if (!view) return
    const now = Date.now()
    let x = 0.12 + Math.min(0.25, (view.t / MATCH_SECONDS) * 0.3)
    if (view.torpedoes.length) x = Math.max(x, 0.7)
    if (now - lastHitAt.current < 15000) x = Math.max(x, 0.8)
    if (contacts.some((c) => c.near && view.t - c.t < 10)) x = Math.max(x, 0.5)
    if (alarmUntil > now) x = 1
    if (view.boat.hull <= 2 || view.enemy.hull <= 2) x = Math.min(1, x + 0.2)
    audio.tension(over ? 0 : x)
    const loop = (name, on, level, bus = 'sfx') => (on ? audio.startLoop(name, bus, level) : audio.stopLoop(name, 0.8))
    loop('torpedo.run', view.torpedoes.length > 0 && !over, 0.35)
    loop('fire', view.boat.faults.some((f) => f.kind === 'fire') && !over, 0.45, 'amb')
    loop('flood', view.boat.faults.some((f) => f.kind === 'flood') && !over, 0.5, 'amb')
  }, [view, contacts, alarmUntil, over, audio])
  useEffect(() => () => { for (const n of ['torpedo.run', 'fire', 'flood']) audio.stopLoop(n, 0.5) }, [audio])

  // the end
  const ended = useRef(false)
  useEffect(() => {
    if (!over || !team || ended.current) return
    ended.current = true
    const e = ending(over.winner ?? null, team)
    setTimeout(() => { audio.play(e.sound); if (e.say) speak(e.say) }, 900)
  }, [over, team, audio, speak])

  // a click on the chart does the active station's job
  const onCell = (cell) => {
    if (!view) return
    if (active === 'listener') send('mark', { cell })
    else if (active === 'weapons') {
      if (guideId && view.torpedoes.some((tp) => tp.id === guideId)) send('guide', { id: guideId, target: cell })
      else { setAim(cell); audio.play('ui.beep', { vol: 0.5 }) }
    } else if (active === 'helm') {
      if (cell.x !== view.boat.x || cell.y !== view.boat.y) send('helm', { heading: headingFor(bearing(view.boat, cell)) })
    }
  }
  useEffect(() => { if (guideId && view && !view.torpedoes.some((tp) => tp.id === guideId)) setGuideId(null) }, [view, guideId])

  // station keys 1-4 switch between the stations this player holds
  useEffect(() => {
    const onKey = (e) => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || '')) return
      const s = STATIONS.find((x) => STATION_INFO[x].key === e.key)
      if (s && myRoles.includes(s)) { setActive(s); audio.play('ui.beep', { vol: 0.5 }) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [myRoles, audio])

  const needs = useMemo(() => {
    if (!view) return {}
    const b = view.boat
    const map = chart(view.mapId)
    const threat = contacts.some((c) => (c.kind === 'torpedo' || c.kind === 'launch') && view.t - c.t < 6)
    return {
      helm: threat || b.faults.some((f) => f.kind === 'rudder') || (b.ordered > 0 && !map.isWater(b.x + [0, 1, 1, 1, 0, -1, -1, -1][b.heading], b.y + [-1, -1, 0, 1, 1, 1, 0, -1][b.heading])),
      listener: contacts.some((c) => view.t - c.t < 4 && c.kind !== 'bio') || (b.pingCharge >= 1 && !b.marker),
      weapons: b.tubes.some((t) => t.state === 'empty') && !b.tubes.some((t) => t.state === 'loading') || (b.tubes.some((t) => t.state === 'ready') && Boolean(b.marker)),
      chief: b.faults.length > 0 || b.heat >= 75 || Boolean(b.boost) || b.scram > 0,
    }
  }, [view, contacts])

  if (!seat || (!view && !over)) {
    return (
      <div className="game-page waiting">
        <div className="sonar-loader" aria-hidden="true" />
        <p>{seat && !seat.team ? 'You have no seat on this boat.' : 'Coming aboard…'}</p>
        {seat && !seat.team && <button onClick={() => navigate('/')}>Back to the deck</button>}
      </div>
    )
  }

  const b = view.boat
  const training = Boolean(view.tutorial)
  const left = Math.max(0, MATCH_SECONDS - view.t)
  const boatName = TEAM_INFO[team]?.boat || 'Our boat'
  const enemyName = training ? 'Training boat' : TEAM_INFO[enemyOf(team)]?.boat || 'Enemy'
  const alarm = alarmUntil > Date.now()
  const Panel = active ? PANELS[active] : null
  const callFrom = myRoles.includes(active) ? active : myRoles[0]
  const end = over ? (training && over.winner === team
    ? { title: 'Training complete', line: 'The training boat is on the bottom. Ready for a real hunt? Start on Easy, and stay quiet.' }
    : ending(over.winner ?? null, team)) : null
  const flood = b.faults.some((f) => f.kind === 'flood')

  // Again, the same way: the same crew against the computer, or the tutorial once more.
  const playAgain = async (gameMode) => {
    try {
      const res = await api.post('/games/create', { gameMode, sameRoom: false })
      const { openLobbies, lobbyCap, madeToday, dayCap } = res.data
      navigate(`/lobby/${res.data.game.code}`, { state: { openLobbies, lobbyCap, madeToday, dayCap } })
    } catch (err) {
      setToast(err.response?.data?.error || 'Could not make a new game')
    }
  }
  const mode = modeId(game?.game_mode)
  const againMode = /^vs-ai-/.test(mode) ? mode : 'vs-ai-normal'

  return (
    <div className={`game-page control-room team-${team} ${alarm ? 'alarm' : ''} ${b.scram > 0 ? 'blackout' : ''} ${b.hull <= 2 ? 'damaged' : ''}`} ref={pageRef}>
      <div className="hit-flash" ref={flashRef} aria-hidden="true" />
      <div className="alarm-lights" aria-hidden="true"><span /><span /></div>
      {flood && <div className="flood-water" style={{ '--level': Math.min(1, b.floodTime / 20) }} aria-hidden="true" />}
      {b.hull <= 2 && <div className="cracks" aria-hidden="true" />}

      <header className="room-header">
        <div className="boat-name">
          <span className="boat-flag" />
          <span>{boatName}</span>
          <span className="map-name">{chart(view.mapId).name}</span>
        </div>
        <Hull hull={b.hull} label={boatName} side="ours" />
        {training
          ? <div className="match-clock training" aria-label="Training: no clock">TRAINING</div>
          : <div className={`match-clock ${left <= 30 ? 'low' : ''}`} aria-label="Time left">{clockText(left)}</div>}
        <Hull hull={view.enemy.hull} label={`${enemyName}${view.vsAi && !training ? ' (AI)' : ''}`} side="theirs" />
        <SoundControls />
      </header>

      <div className="room">
        <section className="console-column">
          <nav className="station-tabs" aria-label="Your stations">
            {STATIONS.map((s) => (
              <button
                key={s}
                className={`station-tab ${active === s ? 'on' : ''} ${needs[s] ? 'needs' : ''}`}
                disabled={!myRoles.includes(s)}
                onClick={() => { setActive(s); audio.play('ui.beep', { vol: 0.5 }) }}
                title={myRoles.includes(s) ? STATION_INFO[s].job : `${STATION_INFO[s].room}: ${view.crew[s] === 'auto' ? 'the auto-crew' : 'a shipmate'} has it`}
              >
                <span className="tab-key">{STATION_INFO[s].key}</span>{STATION_INFO[s].name}
              </button>
            ))}
          </nav>
          <div className="console-screen">
            {Panel ? (
              <>
                <h2 className="console-title">{STATION_INFO[active].room}</h2>
                <Panel view={view} contacts={contacts} send={send} aim={aim} setAim={setAim} guideId={guideId} setGuideId={setGuideId} />
              </>
            ) : (
              <p className="hint">You hold no station on this boat: watch the chart while the crew fights it.</p>
            )}
          </div>
          {callFrom && (
            <div className="calls" role="group" aria-label="Crew calls">
              {Object.keys(CALLS).map((c) => (
                <button key={c} className="call-btn" onClick={() => send('call', { station: callFrom, call: c })}>{CALLS[c].replace(/!|\./g, '')}</button>
              ))}
            </div>
          )}
        </section>

        <section className="chart-table">
          {training && <TutorialCard view={view} contacts={contacts} send={send} myRoles={myRoles} />}
          <ChartCanvas
            view={view}
            contacts={contacts}
            team={team}
            mode={active === 'listener' ? 'mark' : active === 'weapons' ? (guideId ? 'guide' : 'aim') : active === 'helm' ? 'steer' : 'look'}
            onCell={onCell}
            aim={aim}
            guideId={guideId}
            effects={effects}
          />
          <div className="chart-legend">
            <span className="lg hull">machinery</span><span className="lg bio">whale</span><span className="lg torp">torpedo / launch</span><span className="lg vent">vent field: hides a slow boat</span>
          </div>
        </section>

        <aside className="crew-column">
          <CrewPanel view={view} players={players.filter((p) => p.team === team)} myRoles={myRoles} speaking={speaking?.station} caption={speaking?.caption} needs={needs} onPick={setActive} active={active} />
          <div className="log" aria-live="polite">
            {log.slice(-12).reverse().map((l) => <div key={l.id} className={`log-row k-${l.kind}`}><span>{clockText(MATCH_SECONDS - l.t)}</span> {l.text}</div>)}
          </div>
        </aside>
      </div>

      {toast && <div className="room-toast" role="status">{toast}</div>}
      {view.t < 3.2 && !over && <div className="dive-overlay" aria-hidden="true"><div className="dive-gauge" /><h1>DIVE! DIVE!</h1></div>}

      {end && (
        <div className={`ending ${over.winner === team ? 'won' : 'lost'}`}>
          <div className="ending-card">
            <h1>{end.title}</h1>
            <p>{end.line}</p>
            <dl className="ending-stats">
              <div><dt>Torpedoes fired</dt><dd>{stats.shots}</dd></div>
              <div><dt>Damage dealt</dt><dd>{stats.landed}</dd></div>
              <div><dt>Damage taken</dt><dd>{stats.taken}</dd></div>
              <div><dt>Time</dt><dd>{clockText(over.t ?? view.t)}</dd></div>
            </dl>
            <div className="ending-actions">
              {training ? (
                <>
                  <button className="primary" onClick={() => navigate('/', { state: { pickLevel: true } })}>Play against AI</button>
                  <button onClick={() => playAgain('tutorial')}>Tutorial again</button>
                </>
              ) : (
                <button className="primary" onClick={() => playAgain(againMode)}>Hunt again</button>
              )}
              <button onClick={() => navigate('/')}>Back to the deck</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default Game
