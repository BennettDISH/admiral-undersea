import { useEffect, useState } from 'react'
import { Portrait } from './CrewPanel'
import { STATION_INFO, chart, shotProblem } from './rules'
import { lessonCard, decoyHeading } from './tutorial'

const SHOOTING = new Set(['torpedo', 'finish'])

// The tutorial's card over the chart table: the face of the station that teaches this lesson
// (talking while the card is new), its words, the goal, a hint when one is earned, and Next or Skip.
// The evade lesson carries its two moves as buttons, since there is no time to find them.
export default function TutorialCard({ view, contacts, send, myRoles }) {
  const tu = view.tutorial
  const card = lessonCard(tu, view.t)
  const [talking, setTalking] = useState(false)
  const step = tu?.step
  useEffect(() => {
    if (!step) return undefined
    setTalking(true)
    const id = setTimeout(() => setTalking(false), 2400)
    return () => clearTimeout(id)
  }, [step])
  if (!card || view.over) return null

  const b = view.boat
  const holds = (s) => myRoles.includes(s)
  // when it is time to shoot and the shot at the mark is no good, say why and what to do
  const problem = SHOOTING.has(tu.step) && b.marker ? shotProblem(chart(view.mapId), b, b.marker) : null
  const hints = problem ? [...card.hints, `${problem}. Move until the line to the mark turns green, or click the chart to aim somewhere clear.`] : card.hints
  const ACTIONS = {
    stop: holds('helm') && <button key="stop" onClick={() => send('helm', { speed: 0 })} className={b.ordered === 0 ? 'on' : ''}>All stop</button>,
    slow: holds('helm') && <button key="slow" onClick={() => send('helm', { speed: 1 })} className={b.ordered === 1 ? 'on' : ''}>Slow ahead</button>,
    decoy: holds('weapons') && (
      <button key="decoy" onClick={() => send('decoy', { heading: decoyHeading(contacts, b) })} disabled={b.decoyCooldown > 0}>
        {b.decoyCooldown > 0 ? 'Decoy away' : 'Throw a decoy at it'}
      </button>
    ),
  }

  return (
    <section className={`tutorial-card st-${card.station}`} aria-live="polite" aria-label={`Tutorial, lesson ${card.number} of ${card.total}`}>
      <div className="tc-face">
        <Portrait station={card.station} talking={talking} size={76} />
        <span className="tc-who">{STATION_INFO[card.station].who}</span>
      </div>
      <div className="tc-body">
        <header className="tc-top">
          <h2>{card.title}</h2>
          <span className="tc-count">{card.number} / {card.total}</span>
        </header>
        {card.lead && <p className="tc-lead">{card.lead}</p>}
        {card.text.map((p) => <p key={p}>{p}</p>)}
        {card.goal && <p className="tc-goal"><span aria-hidden="true">▸</span> {card.goal}</p>}
        {hints.map((h) => <p key={h} className="tc-hint">{h}</p>)}
        <div className="tc-actions">
          {(card.actions || []).map((a) => ACTIONS[a]).filter(Boolean)}
          {tu.canNext && <button className="primary" onClick={() => send('tutorial', { action: 'next' })}>Next</button>}
          {!tu.canNext && tu.canSkip && <button className="link-btn" onClick={() => send('tutorial', { action: 'skip' })}>Skip this lesson</button>}
        </div>
      </div>
    </section>
  )
}
