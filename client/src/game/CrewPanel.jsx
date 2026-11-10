import { useEffect, useRef } from 'react'
import { STATION_INFO, STATIONS } from './rules'
import { clipOf, frameAt } from './sprites'

const TINT = { helm: '#7fb6d8', listener: '#8fd8a8', weapons: '#d89a6f', chief: '#c9b37a' }

function drawLayer(ctx, clip, t, w, h) {
  const f = frameAt(clip, t)
  if (!f) return
  const scale = Math.min(w / f.w, h / f.h)
  const dw = f.w * scale
  const dh = f.h * scale
  ctx.drawImage(clip.image, f.x, f.y, f.w, f.h, (w - dw) / 2, h - dh, dw, dh)
}

// A stand-in face (until the sprite factory's portrait loads): a head and shoulders in the
// station's colour, a mouth that moves while the line plays, and a blink now and then.
function drawStandIn(ctx, station, w, h, talk, blink) {
  const c = TINT[station]
  ctx.fillStyle = '#0d1a20'
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = c
  ctx.beginPath()
  ctx.ellipse(w / 2, h * 1.02, w * 0.42, h * 0.34, 0, Math.PI, 0)
  ctx.fill()
  ctx.fillStyle = '#e2b892'
  ctx.beginPath()
  ctx.ellipse(w / 2, h * 0.45, w * 0.2, h * 0.24, 0, 0, Math.PI * 2)
  ctx.fill()
  // headgear per station
  ctx.fillStyle = '#1c2a33'
  if (station === 'helm') { ctx.fillRect(w * 0.28, h * 0.18, w * 0.44, h * 0.1); ctx.fillRect(w * 0.24, h * 0.27, w * 0.52, h * 0.04) }
  if (station === 'listener') { ctx.strokeStyle = '#30404a'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(w / 2, h * 0.44, w * 0.24, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke(); ctx.fillStyle = '#30404a'; ctx.fillRect(w * 0.24, h * 0.4, w * 0.08, h * 0.14); ctx.fillRect(w * 0.68, h * 0.4, w * 0.08, h * 0.14) }
  if (station === 'weapons') { ctx.fillStyle = '#5b3a2a'; ctx.beginPath(); ctx.ellipse(w / 2, h * 0.27, w * 0.21, h * 0.1, 0, Math.PI, 0); ctx.fill(); ctx.fillStyle = '#6b4a35'; ctx.beginPath(); ctx.ellipse(w / 2, h * 0.62, w * 0.16, h * 0.08, 0, 0, Math.PI); ctx.fill() }
  if (station === 'chief') { ctx.fillStyle = '#ccc'; ctx.beginPath(); ctx.ellipse(w / 2, h * 0.62, w * 0.17, h * 0.1, 0, 0, Math.PI); ctx.fill(); ctx.strokeStyle = '#222'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(w * 0.42, h * 0.43, w * 0.05, 0, Math.PI * 2); ctx.arc(w * 0.58, h * 0.43, w * 0.05, 0, Math.PI * 2); ctx.stroke(); ctx.fillStyle = '#2b2b2b'; ctx.fillRect(w * 0.3, h * 0.2, w * 0.4, h * 0.08) }
  ctx.fillStyle = '#1b1b1b'
  if (blink) { ctx.fillRect(w * 0.4, h * 0.43, w * 0.06, 1.5); ctx.fillRect(w * 0.54, h * 0.43, w * 0.06, 1.5) }
  else { ctx.fillRect(w * 0.41, h * 0.41, w * 0.04, h * 0.04); ctx.fillRect(w * 0.55, h * 0.41, w * 0.04, h * 0.04) }
  ctx.fillStyle = '#5a2020'
  const open = talk ? h * (0.02 + 0.05 * Math.abs(Math.sin(performance.now() / 70))) : h * 0.012
  ctx.fillRect(w * 0.45, h * 0.55, w * 0.1, open)
}

/** One crew member's face, drawn from the sprite factory's portrait (with mouth and blink layers) when it has loaded. */
export function Portrait({ station, talking, size = 88 }) {
  const ref = useRef(null)
  const live = useRef({ talking })
  live.current.talking = talking
  useEffect(() => {
    const canvas = ref.current
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = size * dpr
    canvas.height = size * dpr
    let raf = 0
    let nextBlink = performance.now() + 1500 + Math.random() * 3000
    let mouthUntil = 0
    let mouth = 'closed'
    const draw = (now) => {
      raf = requestAnimationFrame(draw)
      const ctx = canvas.getContext('2d')
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.imageSmoothingEnabled = false
      const t = now / 1000
      const blink = now > nextBlink && now < nextBlink + 140
      if (now > nextBlink + 140) nextBlink = now + 2500 + Math.random() * 3500
      const talk = live.current.talking
      if (talk && now > mouthUntil) {
        const shapes = ['open', 'small', 'wide', 'closed', 'open', 'oo']
        mouth = shapes[Math.floor(Math.random() * shapes.length)]
        mouthUntil = now + 70 + Math.random() * 90
      }
      if (!talk) mouth = 'closed'
      const set = `crew-${station}`
      const body = clipOf(set)
      ctx.clearRect(0, 0, size, size)
      if (!body) { drawStandIn(ctx, station, size, size, talk, blink); return }
      ctx.fillStyle = '#0d1a20'
      ctx.fillRect(0, 0, size, size)
      drawLayer(ctx, body, t, size, size)
      const m = clipOf(`${set}-mouth-${mouth}`) || clipOf(`${set}-mouth-${talk ? 'open' : 'closed'}`) || clipOf(`${set}-mouth-closed`)
      if (m) drawLayer(ctx, m, t, size, size)
      if (blink) { const l = clipOf(`${set}-blink`); if (l) drawLayer(ctx, l, t, size, size) }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [station, size])
  return <canvas ref={ref} className="portrait" style={{ width: size, height: size }} aria-hidden="true" />
}

/**
 * The four stations down the side: who mans each (you, a shipmate, or the auto-crew), the face
 * that talks when that station calls out, and a lamp when the station needs a hand.
 */
export default function CrewPanel({ view, players, myRoles, speaking, caption, needs, onPick, active }) {
  return (
    <div className="crew-panel">
      {STATIONS.map((s) => {
        const mine = myRoles.includes(s)
        const who = mine ? 'YOU' : view.crew[s] === 'auto' ? 'AUTO-CREW' : (players.find((p) => (p.roles || '').split(',').includes(s))?.username || 'crew')
        return (
          <button
            key={s}
            className={`crew-card ${speaking === s ? 'speaking' : ''} ${mine ? 'mine' : ''} ${active === s ? 'active' : ''} ${needs[s] ? 'needs' : ''}`}
            onClick={() => mine && onPick(s)}
            title={STATION_INFO[s].job}
          >
            <Portrait station={s} talking={speaking === s} />
            <span className="crew-room">{STATION_INFO[s].room}</span>
            <span className={`crew-who ${who === 'AUTO-CREW' ? 'auto' : ''}`}>{who}</span>
            {needs[s] && <span className="crew-lamp" />}
            {speaking === s && caption && <span className="crew-caption">“{caption}”</span>}
          </button>
        )
      })}
    </div>
  )
}
