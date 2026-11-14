import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Portrait } from './CrewPanel'
import { STATION_INFO, chart, shotProblem } from './rules'
import { lessonCard, spotlight, roomName } from './tutorial'

const PAD = 6 // around the lit control
const find = (key) => (key ? document.querySelector(`[data-tut="${key}"]`) : null)
const shown = (el) => Boolean(el) && el.getClientRects().length > 0
const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
const overlaps = (a, b) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t
const BUG_BUTTON = 84 // room under a card for the bug-report button in the bottom right corner
const topBar = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--top-bar')) || 52

/**
 * Where the card goes: below or above the lit control, else beside it, and never over it when that
 * can be helped. `heights` is the card's height as drawn at each width it has had (a width it has
 * not had yet is guessed from the last one).
 */
function placeCard(hole, tag, lit, vw, vh, heights) {
  const W = Math.min(680, vw - 32)
  const last = heights.last || { w: W, h: 240 }
  const hAt = (w) => Math.min(vh * 0.5, heights.at.get(Math.round(w)) ?? (last.h * last.w) / w)
  const x = (vw - W) / 2
  const top = topBar() + 12
  // the bug-report button sits in the bottom right corner: a card reaching that corner stays above it
  const low = vw - x - W < 90 ? BUG_BUTTON : 16
  if (!hole) return lit ? { left: x, width: W, bottom: low } : { left: x, width: W, top: Math.max(top, (vh - hAt(W)) / 2) }
  const h = hAt(W)
  const options = [
    { style: { left: x, width: W, bottom: low }, rect: { l: x, r: x + W, t: vh - low - h, b: vh - low } },
    { style: { left: x, width: W, top }, rect: { l: x, r: x + W, t: top, b: top + h } },
  ]
  const leftW = Math.min(440, hole.l - 32)
  if (leftW >= 320) options.push({ style: { left: 16, width: leftW, bottom: 16 }, rect: { l: 16, r: 16 + leftW, t: vh - 16 - hAt(leftW), b: vh - 16 } })
  const rightW = Math.min(440, vw - hole.r - 32)
  if (rightW >= 320) options.push({ style: { left: vw - 16 - rightW, width: rightW, bottom: BUG_BUTTON }, rect: { l: vw - 16 - rightW, r: vw - 16, t: vh - BUG_BUTTON - hAt(rightW), b: vh - BUG_BUTTON } })
  const clear = options.find((o) => !overlaps(o.rect, hole) && !(tag && overlaps(o.rect, tag)))
    || options.find((o) => !overlaps(o.rect, hole))
  if (clear) return clear.style
  // nowhere clear (a narrow screen and a big control): the end of the screen the control is less in
  return (hole.t + hole.b) / 2 > vh * 0.55 ? options[1].style : options[0].style
}

/** Where a control is on screen, kept up as the page scrolls and moves (null when it is not shown). */
function useRectOf(key) {
  const [rect, setRect] = useState(null)
  useEffect(() => {
    if (!key) { setRect(null); return undefined }
    let raf = 0
    let last = null
    const measure = () => {
      raf = requestAnimationFrame(measure)
      const el = find(key)
      const r = shown(el) ? el.getBoundingClientRect() : null
      const sig = r ? [r.left, r.top, r.width, r.height].map(Math.round).join(',') : ''
      if (sig === last) return
      last = sig
      setRect(r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null)
    }
    measure()
    return () => cancelAnimationFrame(raf)
  }, [key])
  return rect
}

/**
 * The tutorial's coach over the control room: the clock stops (on the server) at every step that
 * is read or done, the rest of the room dims, one control is lit with a label saying what it does,
 * and a card says what is going on and what to do. A click on the dimmed room only flashes the lit
 * control. The card carries Back, Next (a step that is only read), Skip this step, and Leave.
 */
export default function TutorialCoach({ view, send, active, onLeave }) {
  const tu = view.tutorial
  const card = lessonCard(tu, view)
  const spot = card ? spotlight(tu, view, active, (k) => shown(find(k))) : null
  const key = spot?.key || null
  // a step read on a station's screen moves on once that screen is up (its tab is lit till then)
  const canNext = Boolean(tu?.canNext) && !spot?.opening
  const rect = useRectOf(key)
  const [nudge, setNudge] = useState(0)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [talking, setTalking] = useState(false)
  const [tucked, setTucked] = useState(false) // the practice hunt's card, put away to a small tab
  const step = tu?.step
  // the card's height at each width it has been drawn, so a placement knows how much room it
  // needs; a few redraws a step at most, so two placements can never chase each other
  const cardRef = useRef(null)
  const heights = useRef({ at: new Map(), last: null, step: null, redraws: 0 })
  const [, redraw] = useState(0)
  useLayoutEffect(() => {
    const el = cardRef.current
    if (!el) return
    const hs = heights.current
    if (hs.step !== step) { hs.step = step; hs.at.clear(); hs.redraws = 0 }
    const w = Math.round(el.offsetWidth)
    const h = el.offsetHeight
    hs.last = { w, h }
    if (Math.abs((hs.at.get(w) ?? -100) - h) > 8 && hs.redraws < 4) {
      hs.at.set(w, h)
      hs.redraws += 1
      redraw((n) => n + 1)
    } else hs.at.set(w, h)
  })

  // a new step: the teacher talks a moment, and the lit control comes into view
  useEffect(() => {
    if (!step) return undefined
    setConfirmLeave(false)
    setTucked(false)
    setTalking(true)
    const id = setTimeout(() => setTalking(false), 2200)
    return () => clearTimeout(id)
  }, [step])
  useEffect(() => {
    const el = find(key)
    if (!shown(el)) return
    const r = el.getBoundingClientRect()
    const vh = window.innerHeight
    if (r.top < 70 || r.bottom > vh - 30) el.scrollIntoView({ block: r.height < vh * 0.45 ? 'center' : 'start', behavior: reduceMotion() ? 'auto' : 'smooth' })
  }, [key, step])

  // On a narrow screen the card may land over the lit control: scroll the page so the control sits
  // clear above it (once a step, so it never fights the player's own scrolling).
  useEffect(() => {
    const id = setTimeout(() => {
      const el = find(key)
      const c = cardRef.current
      if (!shown(el) || !c) return
      const r = el.getBoundingClientRect()
      const box = c.getBoundingClientRect()
      const across = Math.min(r.right, box.right) - Math.max(r.left, box.left) > 0
      const over = r.bottom + PAD - box.top
      const room = r.top - PAD - (topBar() + 8)
      if (across && over > 0 && box.top > r.top && room > 0) window.scrollBy({ top: Math.min(over + 12, room), behavior: reduceMotion() ? 'auto' : 'smooth' })
    }, 400)
    return () => clearTimeout(id)
  }, [key, step])

  // A new step takes the focus off the control just used, so Enter or Space cannot press it again.
  useEffect(() => {
    const el = document.activeElement
    if (el && el !== document.body && !el.closest?.('.tut-card')) el.blur?.()
  }, [step])
  // Enter presses Next on a step that is only read (caught first, so it never presses a focused control)
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Enter' || !canNext || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || '')) return
      if (e.target?.closest?.('.tut-card')) return
      e.preventDefault()
      e.stopPropagation()
      send('tutorial', { action: 'next' })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [canNext, send])

  if (!card || view.over) return null

  const stopped = tu.kind === 'read' || tu.kind === 'do'
  const hunting = tu.kind === 'hunt'
  const b = view.boat
  // when it is time to shoot and the shot at the mark is no good, say why
  const problem = tu.step === 'fire' && b.marker ? shotProblem(chart(view.mapId), b, b.marker) : null
  const hints = problem ? [...card.hints, `${problem}. Skip this step and the crew lines it up for you.`] : card.hints

  // the lit hole, and the four dimmed panes around it
  const vw = window.innerWidth
  const vh = window.innerHeight
  const hole = rect && { l: rect.left - PAD, t: rect.top - PAD, r: rect.left + rect.width + PAD, b: rect.top + rect.height + PAD }
  const block = stopped && (Boolean(hole) || !spot) // a do step whose control is not on the page yet never traps the player
  const dimClass = `tut-dim ${block ? 'block' : 'see-through'} ${stopped ? '' : 'light'}`
  const flash = () => setNudge((n) => n + 1)
  const panes = hunting ? [] : hole
    ? [
      { left: 0, top: 0, width: vw, height: Math.max(0, hole.t) },
      { left: 0, top: hole.b, width: vw, height: Math.max(0, vh - hole.b) },
      { left: 0, top: hole.t, width: Math.max(0, hole.l), height: hole.b - hole.t },
      { left: hole.r, top: hole.t, width: Math.max(0, vw - hole.r), height: hole.b - hole.t },
    ]
    : [{ left: 0, top: 0, width: vw, height: vh }]

  // the label beside the lit control: below it, else above, else inside the top of a big one
  // (tagBox: roughly where it lands, for keeping the card off it)
  let tagStyle = null
  let tagBox = null
  if (hole && spot?.tag && !hunting) {
    const TW = 290
    const TH = 44
    const left = Math.max(8, Math.min(hole.l, vw - TW - 8))
    const tall = hole.b - hole.t > vh * 0.45
    if (tall && hole.l >= TW + 10) {
      tagStyle = { left: hole.l - 10, top: Math.max(hole.t, 70), transform: 'translateX(-100%)' }
      tagBox = { l: hole.l - 10 - TW, r: hole.l - 10, t: tagStyle.top, b: tagStyle.top + TH }
    } else if (tall && vw - hole.r >= TW + 10) {
      tagStyle = { left: hole.r + 10, top: Math.max(hole.t, 70) }
      tagBox = { l: hole.r + 10, r: hole.r + 10 + TW, t: tagStyle.top, b: tagStyle.top + TH }
    } else if (tall) {
      tagStyle = { left: hole.l + 10, top: Math.max(hole.t + 10, 70) }
    } else if (hole.b + TH + 20 < vh) {
      tagStyle = { left, top: hole.b + 8 }
      tagBox = { l: left, r: left + TW, t: hole.b + 8, b: hole.b + 8 + TH }
    } else {
      tagStyle = { left, top: hole.t - 8, transform: 'translateY(-100%)' }
      tagBox = { l: left, r: left + TW, t: hole.t - 8 - TH, b: hole.t - 8 }
    }
  }
  const cardStyle = placeCard(hunting ? null : hole, tagBox, Boolean(spot) || hunting, vw, vh, heights.current)
  // a label below the control that the card would cover goes above the control instead
  if (tagBox && tagStyle.top === hole.b + 8 && cardStyle.bottom !== undefined) {
    const cardTop = vh - cardStyle.bottom - (heights.current.at.get(Math.round(cardStyle.width)) ?? 240)
    if (tagBox.b > cardTop && hole.t - 60 > topBar()) tagStyle = { left: tagStyle.left, top: hole.t - 8, transform: 'translateY(-100%)' }
  }
  const teacher = STATION_INFO[card.teacher] ? card.teacher : 'helm'
  const pct = Math.round((card.number / card.total) * 100)
  const opening = spot?.opening ? { room: roomName(spot.station), key: STATION_INFO[spot.station].key } : null

  if (hunting && tucked) {
    return createPortal(
      <div className="tut-coach kind-hunt">
        <div className="tut-tucked" role="group" aria-label="Tutorial">
          <span>Practice hunt</span>
          <button type="button" onClick={() => setTucked(false)}>Show tips</button>
        </div>
      </div>,
      document.body,
    )
  }

  return createPortal(
    <div className={`tut-coach kind-${tu.kind}`}>
      {panes.map((p, i) => <div key={i} className={dimClass} style={p} onClick={block ? flash : undefined} aria-hidden="true" />)}
      {hole && !hunting && <div key={nudge} className={`tut-ring ${nudge ? 'nudged' : ''} ${stopped ? '' : 'watching'}`} style={{ left: hole.l, top: hole.t, width: hole.r - hole.l, height: hole.b - hole.t }} aria-hidden="true" />}
      {tagStyle && <div className="tut-tag" style={tagStyle}>{spot.tag}</div>}

      <section ref={cardRef} className={`tut-card ${hunting ? 'compact' : ''}`} style={cardStyle} role="dialog" aria-modal="false" aria-live="polite" aria-label={`Tutorial: ${card.title}`}>
        <div className="tc-face">
          <Portrait station={teacher} talking={talking} size={64} />
          <span className="tc-who">{STATION_INFO[teacher].who}</span>
        </div>
        <div className="tc-body">
          <header className="tc-top">
            <span className="tc-chapter">{card.chapter} <span>· {card.place}</span></span>
            <span className={`tc-clock ${stopped ? 'stopped' : 'running'}`}>{stopped ? '❚❚ Clock stopped' : '▶ Clock running'}</span>
          </header>
          <h2>{card.title}</h2>
          {card.text.map((p) => <p key={p}>{p}</p>)}
          {card.list && <ol className="tc-list">{card.list.map((l) => <li key={l}>{l}</li>)}</ol>}
          {opening && <p className="tc-do"><span aria-hidden="true">▸</span> First open {opening.room}: click its lit tab (or press {opening.key}).</p>}
          {card.do && <p className={`tc-do ${opening ? 'then' : ''}`}><span aria-hidden="true">▸</span> {opening ? `Then: ${card.do}` : card.do}</p>}
          {tu.kind === 'watch' && !tu.stalled && <p className="tc-wait">Nothing to click: it moves on by itself when this has happened.</p>}
          {hints.map((h) => <p key={h} className="tc-hint">{h}</p>)}
          <div className="tc-actions">
            {tu.canBack && <button type="button" onClick={() => send('tutorial', { action: 'back' })}>◀ Back</button>}
            {canNext && <button type="button" className="primary" onClick={() => send('tutorial', { action: 'next' })}>Next ▶</button>}
            {tu.canSkip && <button type="button" className="link-btn" onClick={() => send('tutorial', { action: 'skip' })}>Skip this step</button>}
            {hunting && <button type="button" className="primary" onClick={() => setTucked(true)}>Hide tips</button>}
            <span className="tc-spacer" />
            {confirmLeave ? (
              <span className="tc-leave">
                Leave the lesson?
                <button type="button" className="danger" onClick={onLeave}>Leave</button>
                <button type="button" onClick={() => setConfirmLeave(false)}>Stay</button>
              </span>
            ) : (
              <button type="button" className="link-btn" onClick={() => setConfirmLeave(true)}>Leave tutorial</button>
            )}
          </div>
          <div className="tc-progress" aria-label={`Step ${card.number} of ${card.total}`}><i style={{ width: `${pct}%` }} /></div>
        </div>
      </section>
    </div>,
    document.body,
  )
}
