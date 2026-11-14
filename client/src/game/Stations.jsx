import { useEffect } from 'react'
import Scope from './Scope'
import {
  HEADINGS, HEADING_NAMES, SPEED_NAMES, POWER, VENT, FAULTS, CONTACT_INFO, chart, canStep, cellName, bearingText,
  shotProblem, loadSeconds, totalPower, DECOY, HEARING_AT_SPEED, TORPEDO,
} from './rules'

const FAULT_ICON = { fire: '🔥', flood: '🌊', sonar: '📡', rudder: '⚙️' }
const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || '')
// what our own flow noise leaves of our hearing, by speed (rules.HEARING_AT_SPEED)
const FLOW_NOISE = HEARING_AT_SPEED.map((f, i) => (i === 0 ? 'Stopped: hearing best' : i === 1 ? 'Quiet: hearing well' : `Flow noise: hearing ${Math.round(f * 100)}%`))

// ---- Helm ----------------------------------------------------------------------------------
export function HelmStation({ view, send }) {
  const b = view.boat
  const map = chart(view.mapId)
  const jammed = b.faults.some((f) => f.kind === 'rudder')
  const limit = Math.min(3, b.eff.engines)
  const blocked = (h) => !canStep(map, b, h)
  const ahead = b.ordered > 0 && blocked(b.heading)

  useEffect(() => {
    const onKey = (e) => {
      if (typing(e) || e.repeat) return
      const k = e.key
      if (k === 'ArrowLeft' || k === 'a' || k === 'A') send('helm', { turn: -1 })
      else if (k === 'ArrowRight' || k === 'd' || k === 'D') send('helm', { turn: 1 })
      else if (k === 'ArrowUp' || k === 'w' || k === 'W') send('helm', { speed: Math.min(3, b.ordered + 1) })
      else if (k === 'ArrowDown' || k === 's' || k === 'S') send('helm', { speed: Math.max(0, b.ordered - 1) })
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [b.ordered, send])

  return (
    <div className="station helm-station">
      <div className="helm-top">
        <div className="wheel-block">
          <button className="turn-btn" data-tut="turn-port" onClick={() => send('helm', { turn: -1 })} disabled={jammed} aria-label="Turn to port">◀ Port</button>
          <div className={`ships-wheel ${jammed ? 'jammed' : ''}`} style={{ transform: `rotate(${b.heading * 45}deg)` }} aria-hidden="true">
            <svg viewBox="-50 -50 100 100">
              <circle r="34" className="wheel-rim" />
              <circle r="9" className="wheel-hub" />
              {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                <g key={i} transform={`rotate(${i * 45})`}>
                  <line y1="-9" y2="-34" className="wheel-spoke" />
                  <rect x="-3.5" y="-47" width="7" height="13" rx="3" className="wheel-handle" />
                </g>
              ))}
            </svg>
          </div>
          <button className="turn-btn" data-tut="turn-stbd" onClick={() => send('helm', { turn: 1 })} disabled={jammed} aria-label="Turn to starboard">Stbd ▶</button>
        </div>
        <div className="compass" role="group" aria-label="Heading" data-tut="compass">
          {HEADINGS.map((h, i) => (
            <button
              key={h}
              data-tut={`compass-${i}`}
              className={`compass-pt pt-${i} ${b.heading === i ? 'on' : ''} ${blocked(i) ? 'blocked' : ''}`}
              onClick={() => send('helm', { heading: i })}
              disabled={jammed}
              title={`${HEADING_NAMES[i]}${blocked(i) ? ': rock or edge' : ''}`}
            >{h}</button>
          ))}
          <div className="compass-face">{HEADING_NAMES[b.heading]}</div>
        </div>
      </div>

      <div className="telegraph" role="group" aria-label="Engine order" data-tut="telegraph">
        {SPEED_NAMES.map((name, i) => (
          <button
            key={name}
            data-tut={`tele-${i}`}
            className={`tele-pos ${b.ordered === i ? 'on' : ''} ${i > limit ? 'starved' : ''}`}
            onClick={() => send('helm', { speed: i })}
            title={i > limit ? 'The engine room is not giving the engines enough power for this' : ''}
          >
            <span className="tele-name">{name}</span>
            <span className="tele-noise">{['silent', 'quiet', 'heard', 'LOUD'][i]}</span>
          </button>
        ))}
      </div>

      <div className="helm-status">
        <span className={`lamp ${ahead ? 'red blink' : 'off'}`}>Rocks ahead</span>
        <span className={`lamp ${jammed ? 'red blink' : 'off'}`}>Rudder jammed</span>
        <span className={`lamp ${b.speed < b.ordered ? 'amber' : 'off'}`}>{b.speed < b.ordered ? `Engines give ${SPEED_NAMES[b.speed]}` : 'Engines answering'}</span>
        <span className={`lamp ${b.speed >= 3 ? 'red' : b.speed === 2 ? 'amber' : 'off'}`}>{FLOW_NOISE[b.speed]}</span>
      </div>
      <p className="station-keys">Keys: ← → turn · ↑ ↓ speed. A boat at Full is heard across the sea, nearly deaf itself, and a torpedo's seeker hears it.</p>
    </div>
  )
}

// ---- Listening -----------------------------------------------------------------------------
export function ListeningStation({ view, contacts, send }) {
  const b = view.boat
  const damaged = b.faults.some((f) => f.kind === 'sonar')
  const canPing = b.pingCharge >= 1 && b.eff.sonar >= 2 && !damaged
  const recent = (contacts || []).filter((c) => view.t - c.t < 45).slice(-8).reverse()
  useEffect(() => {
    const onKey = (e) => {
      if (typing(e) || e.repeat) return
      if (e.key === 'p' || e.key === 'P') { send('ping', {}); e.preventDefault() }
      if (e.key === 'Escape') send('mark', { cell: null })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [send])
  return (
    <div className="station listening-station">
      <div className="scope-row">
        <div className="scope-bezel" data-tut="scope"><Scope view={view} contacts={contacts} size={230} /></div>
        <div className="ping-block">
          <button data-tut="ping" className={`ping-btn ${canPing ? 'ready' : ''}`} onClick={() => send('ping', {})} disabled={!canPing} style={{ '--charge': b.pingCharge }}>
            <span className="ping-ring" />
            <span className="ping-label">{damaged ? 'DOME DAMAGED' : b.eff.sonar < 2 ? 'NEEDS 2 POWER' : canPing ? 'PING' : `${Math.round(b.pingCharge * 100)}%`}</span>
          </button>
          <p className="hint">A ping shows everything within 6 cells, and tells them exactly where we are.</p>
          <p className="hint mark-hint">{b.marker ? <>Mark on <strong>{cellName(b.marker.x, b.marker.y)}</strong> · <button className="link-btn" onClick={() => send('mark', { cell: null })}>clear</button></> : 'Click the chart where the bearings cross to mark the enemy.'}</p>
        </div>
      </div>
      <div className="contact-list" aria-live="polite" data-tut="contacts">
        {recent.length === 0 && <div className="contact-row quiet">Hydrophones quiet… {b.speed >= 3 ? 'our own flow noise at Full drowns nearly everything.' : b.speed === 2 ? 'some flow noise at Half.' : 'listening.'}</div>}
        {recent.map((c) => (
          <div key={c.id} className={`contact-row k-${c.kind}`}>
            <span className="c-age">-{Math.round(view.t - c.t)}s</span>
            <span className="c-kind">{CONTACT_INFO[c.kind]?.label || c.kind}</span>
            <span className="c-where">{c.exact ? cellName(c.x, c.y) : `${bearingText(c.bearing)}° ±${Math.round(c.width)}`}</span>
            <span className="c-note">{c.near ? 'CLOSE' : CONTACT_INFO[c.kind]?.note}</span>
          </div>
        ))}
      </div>
      <p className="station-keys">Keys: P ping · Esc clears the mark. Louder noise draws a sharper bearing; two bearings from two places cross on the enemy.</p>
    </div>
  )
}

// ---- Torpedo room ----------------------------------------------------------------------------
export function TorpedoStation({ view, send, aim, setAim, guideId, setGuideId }) {
  const b = view.boat
  const map = chart(view.mapId)
  const loadingCount = b.tubes.filter((t) => t.state === 'loading').length || 1
  const target = aim || b.marker
  const problem = target ? shotProblem(map, b, target) : 'No target: mark one, or click the chart'
  const flooded = b.faults.some((f) => f.kind === 'flood')
  const fire = (i) => target && send('fire', { tube: i, target: { x: target.x, y: target.y } })
  useEffect(() => {
    const onKey = (e) => {
      if (typing(e) || e.repeat) return
      if (e.key === 'f' || e.key === 'F') {
        const i = b.tubes.findIndex((t) => t.state === 'ready')
        if (i >= 0) fire(i)
      } else if (e.key === 'l' || e.key === 'L') {
        const i = b.tubes.findIndex((t) => t.state === 'empty')
        if (i >= 0) send('load', { tube: i })
      } else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  return (
    <div className="station torpedo-station">
      <div className="tubes" data-tut="tubes">
        {b.tubes.map((tb, i) => (
          <div key={i} className={`tube s-${tb.state}`}>
            <div className="tube-body" aria-hidden="true">
              <div className="tube-fish" style={{ '--p': tb.state === 'ready' ? 1 : tb.progress }} />
              <div className="tube-door" />
            </div>
            <div className="tube-label">Tube {i + 1} · {tb.state === 'empty' ? 'empty' : tb.state === 'loading' ? `loading ${Math.round(tb.progress * 100)}%` : 'READY'}</div>
            {tb.state === 'empty' && <button data-tut={`load-${i}`} onClick={() => send('load', { tube: i })}>Load</button>}
            {tb.state === 'loading' && (
              <div className="tube-eta">{flooded ? 'Flooded: no loading' : b.eff.tubes ? `≈${Math.ceil(loadSeconds(b.eff.tubes, loadingCount) * (1 - tb.progress))}s` : 'No power on the tubes'}</div>
            )}
            {tb.state === 'ready' && <button className="fire-btn" data-tut={`fire-${i}`} onClick={() => fire(i)} disabled={!target}>Fire {i + 1}</button>}
          </div>
        ))}
      </div>
      <div className={`aim-readout ${problem ? 'warn' : 'ok'}`} data-tut="aim">
        <span>Target: <strong>{target ? cellName(target.x, target.y) : '—'}</strong>{aim ? ' (aimed)' : b.marker ? ' (the mark)' : ''}</span>
        <span>{problem || 'Clear shot'}</span>
        {aim && <button className="link-btn" onClick={() => setAim(null)}>use the mark</button>}
      </div>
      {view.torpedoes.length > 0 && (
        <div className="running" data-tut="running">
          {view.torpedoes.map((tp) => (
            <button key={tp.id} className={`run-row ${guideId === tp.id ? 'on' : ''}`} onClick={() => setGuideId(guideId === tp.id ? null : tp.id)}>
              ➤ Torpedo running to {cellName(tp.tx, tp.ty)} · {tp.run < TORPEDO.armAfter ? 'arming' : 'armed'} · {Math.max(0, Math.round(TORPEDO.maxRun - tp.run))} cells of fuel · {guideId === tp.id ? 'click the chart to steer it' : 'steer'}
            </button>
          ))}
        </div>
      )}
      <div className="decoy-block" data-tut="decoy">
        <span>Decoy {b.decoyCooldown > 0 ? `in ${Math.ceil(b.decoyCooldown)}s` : 'ready'}:</span>
        {HEADINGS.map((h, i) => (
          <button key={h} data-tut={`decoy-${i}`} className="decoy-dir" onClick={() => send('decoy', { heading: i })} disabled={b.decoyCooldown > 0} title={`Throw a decoy ${HEADING_NAMES[i]}: it sounds like a boat at full speed for ${DECOY.lifeSeconds}s, and a torpedo's seeker goes for it first`}>{h}</button>
        ))}
      </div>
      <p className="station-keys">Keys: L load · F fire. Click the chart to aim; a torpedo arms after {TORPEDO.armAfter} cells, homes on a loud boat near it, and goes where you steer it.</p>
    </div>
  )
}

// ---- Engine room ---------------------------------------------------------------------------
const SYSTEMS = [['engines', 'Engines', 'speed'], ['sonar', 'Sonar', 'hearing, pings'], ['tubes', 'Tubes', 'loading']]

export function EngineStation({ view, send }) {
  const b = view.boat
  const p = b.power
  const total = totalPower(p)
  const set = (k, v) => {
    const next = { ...p, [k]: Math.max(0, Math.min(POWER.perSystemMax, v)) }
    if (totalPower(next) > POWER.max) return
    send('power', { power: next })
  }
  const hot = b.heat >= 75
  return (
    <div className={`station engine-station ${b.scram > 0 ? 'scrammed' : ''}`}>
      <div className="reactor" data-tut="reactor">
        <div className="reactor-gauge" style={{ '--total': total, '--max': POWER.max, '--base': POWER.base }}>
          <div className="rg-fill" />
          <div className="rg-base" />
          <div className="rg-read">{b.scram > 0 ? `SCRAM ${Math.ceil(b.scram)}s` : `${total} / ${POWER.max}`}</div>
          <div className="rg-note">{total > POWER.base ? 'OVERDRIVE: heating' : 'within the reactor\'s 6'}</div>
        </div>
        <div className={`heat ${hot ? 'hot' : ''}`} title="Reactor heat: a scram at 100">
          <div className="heat-fill" style={{ height: `${b.heat}%` }} />
          <span className="heat-read">{b.heat}°</span>
        </div>
        <button className="vent-btn" data-tut="vent" onClick={() => send('vent', {})} disabled={b.ventCooldown > 0} title={`Cools the reactor by ${VENT.heat}, but the steam is heard`}>
          {b.ventCooldown > 0 ? `Vent ${Math.ceil(b.ventCooldown)}s` : 'VENT'}
        </button>
      </div>
      <div className="levers">
        {SYSTEMS.map(([k, name, does]) => (
          <div key={k} className={`lever-col ${b.boost?.system === k ? 'asked' : ''}`}>
            <button className="lev-btn" data-tut={`lever-${k}-up`} onClick={() => set(k, p[k] + 1)} disabled={p[k] >= POWER.perSystemMax || total >= POWER.max} aria-label={`More power to ${name}`}>▲</button>
            <div className="lever-track" role="group" aria-label={`${name} power`}>
              {[4, 3, 2, 1, 0].map((n) => (
                <button key={n} className={`notch ${p[k] >= n && n > 0 ? 'lit' : ''} ${p[k] === n ? 'at' : ''}`} onClick={() => set(k, n)} aria-label={`${name} ${n}`} />
              ))}
            </div>
            <button className="lev-btn" data-tut={`lever-${k}-down`} onClick={() => set(k, p[k] - 1)} disabled={p[k] <= 0} aria-label={`Less power to ${name}`}>▼</button>
            <div className="lever-name">{name}</div>
            <div className="lever-does">{does}{b.eff[k] < p[k] ? ` (gets ${b.eff[k]})` : ''}</div>
          </div>
        ))}
      </div>
      <div className="faults" data-tut="faults">
        {Object.keys(FAULTS).map((kind) => {
          const f = b.faults.find((x) => x.kind === kind)
          const fixing = f && b.repair?.faultId === f.id
          return (
            <div key={kind} className={`fault ${f ? 'on' : ''} ${fixing ? 'fixing' : ''}`}>
              <span className="f-icon">{FAULT_ICON[kind]}</span>
              <span className="f-name">{FAULTS[kind].name}</span>
              {f && !fixing && <button data-tut={`repair-${kind}`} onClick={() => send('repair', { faultId: f.id })}>Repair</button>}
              {fixing && <span className="f-bar"><span style={{ width: `${(1 - b.repair.left / b.repair.total) * 100}%` }} /></span>}
              {f && kind === 'flood' && <span className="f-warn">hull in {Math.max(0, Math.ceil(20 - b.floodTime))}s</span>}
            </div>
          )
        })}
      </div>
      <p className="station-keys">Every system takes 0 to 4. Past 6 in all the reactor heats; at 100 it scrams and the boat goes dead. Venting is heard.</p>
    </div>
  )
}
