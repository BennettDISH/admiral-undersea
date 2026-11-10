import { useEffect, useRef, useState } from 'react'
import { chart, cellName, dist, shotProblem, TORPEDO, delta, crossing } from './rules'
import { PALETTE, drawRock, drawVent, drawSub, drawTorpedo, drawWhale, drawBlast, drawReticle } from './draw'
import { getSprites } from './sprites'

const KIND_COLOUR = { hull: PALETTE.hull, bio: PALETTE.bio, launch: PALETTE.alarm, torpedo: PALETTE.alarm, ping: PALETTE.alarm, vent: PALETTE.amber, scrape: PALETTE.amber }
const CONTACT_TTL = 45
const SECONDS_PER_CELL = [0, 2.6, 1.7, 1.1]

/**
 * The chart table: the sea, our boat and torpedoes, every bearing we heard, the mark, pings and
 * blasts, animated. `mode` says what a click does: 'mark' (listening), 'aim' and 'guide' (the
 * torpedo room) or 'look'. `effects` is a list the page adds blasts, pings and calls to.
 */
export default function ChartCanvas({ view, contacts, mode = 'look', onCell, aim, guideId, effects, team }) {
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)
  const live = useRef({})
  const [hover, setHover] = useState(null)
  live.current = { view, contacts, mode, aim, guideId, effects, hover, team }

  // smooth motion between views: where each torpedo was and is
  const tracks = useRef({ torps: new Map(), viewAt: 0 })
  useEffect(() => {
    if (!view) return
    const now = performance.now()
    const torps = new Map()
    for (const tp of view.torpedoes) {
      const prev = tracks.current.torps.get(tp.id)
      torps.set(tp.id, { from: prev ? prev.shown || prev.to : { x: tp.x, y: tp.y }, to: { x: tp.x, y: tp.y }, at: now, tx: tp.tx, ty: tp.ty })
    }
    tracks.current = { torps, viewAt: now, view }
  }, [view])

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    let raf = 0
    let size = { w: 0, h: 0, dpr: 1 }
    const resize = () => {
      const w = wrap.clientWidth
      const h = Math.round(w * (12.8 / 16.8))
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      canvas.style.height = `${h}px`
      size = { w, h, dpr }
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(wrap)

    const frame = (nowMs) => {
      raf = requestAnimationFrame(frame)
      // one bad frame must never blank the table: skip it and draw the next
      try { draw(nowMs) } catch { /* next frame */ }
    }
    const draw = (nowMs) => {
      const { view: v, contacts: cs, mode: m, aim: a, guideId: gid, effects: fxList, hover: hv } = live.current
      const ctx = canvas.getContext('2d')
      if (!v || !size.w) return
      const map = chart(v.mapId)
      const t = nowMs / 1000
      const s = size.w / 16.8
      const ox = s * 0.8
      const oy = s * 0.8
      ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0)
      const cx = (x) => ox + x * s + s / 2
      const cy = (y) => oy + y * s + s / 2

      // the sea
      const sea = ctx.createLinearGradient(0, 0, 0, size.h)
      sea.addColorStop(0, PALETTE.sea1)
      sea.addColorStop(1, PALETTE.sea0)
      ctx.fillStyle = sea
      ctx.fillRect(0, 0, size.w, size.h)
      // caustic light drifting
      ctx.save()
      ctx.globalAlpha = 0.03
      ctx.strokeStyle = '#9ff'
      for (let i = 0; i < 7; i++) {
        ctx.beginPath()
        for (let x = 0; x <= size.w; x += 12) {
          const y = (i / 7) * size.h + Math.sin(x / 60 + t * 0.6 + i) * 10 + Math.sin(x / 23 - t * 0.9) * 4
          if (x === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.stroke()
      }
      ctx.restore()

      // the grid and its names
      ctx.strokeStyle = PALETTE.grid
      ctx.lineWidth = 1
      for (let x = 0; x <= 16; x++) { ctx.beginPath(); ctx.moveTo(ox + x * s, oy); ctx.lineTo(ox + x * s, oy + 12 * s); ctx.stroke() }
      for (let y = 0; y <= 12; y++) { ctx.beginPath(); ctx.moveTo(ox, oy + y * s); ctx.lineTo(ox + 16 * s, oy + y * s); ctx.stroke() }
      ctx.fillStyle = PALETTE.gridText
      ctx.font = `${Math.max(9, s * 0.34)}px "Share Tech Mono", monospace`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      for (let x = 0; x < 16; x++) ctx.fillText('ABCDEFGHIJKLMNOP'[x], cx(x), oy * 0.5)
      for (let y = 0; y < 12; y++) ctx.fillText(String(y + 1), ox * 0.5, cy(y))

      // vents under, rocks over
      for (let y = 0; y < 12; y++) for (let x = 0; x < 16; x++) if (map.isVent(x, y)) drawVent(ctx, x, y, s, ox, oy, t)
      for (let y = 0; y < 12; y++) for (let x = 0; x < 16; x++) if (map.isRock(x, y)) drawRock(ctx, map, x, y, s, ox, oy)

      // the bearings we heard: a fan from where we were, fading with age
      const sprites = getSprites()
      for (const c of cs || []) {
        const age = v.t - c.t
        if (age > CONTACT_TTL || age < -1) continue
        const fade = Math.max(0, Math.min(1, 1 - age / CONTACT_TTL))
        const col = KIND_COLOUR[c.kind] || PALETTE.hull
        if (c.exact) {
          ctx.save()
          ctx.globalAlpha = 0.25 + 0.75 * fade
          ctx.strokeStyle = col
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.rect(ox + c.x * s + 2, oy + c.y * s + 2, s - 4, s - 4)
          ctx.stroke()
          ctx.restore()
          continue
        }
        // a contact can arrive a moment before the view that carries its time
        const grow = Math.max(0.02, Math.min(1, (age + 0.05) / 0.6))
        const from = { x: cx(c.ox), y: cy(c.oy) }
        const len = s * 16 * grow
        const a = ((c.bearing - 90) * Math.PI) / 180
        const w = (c.width * Math.PI) / 180
        const fresh = Math.max(0, 1 - age / 4) // a new bearing glows for a moment
        ctx.save()
        ctx.globalAlpha = (c.kind === 'bio' ? 0.025 : 0.07 + 0.1 * fresh) * fade
        ctx.fillStyle = col
        ctx.beginPath()
        ctx.moveTo(from.x, from.y)
        ctx.arc(from.x, from.y, len, a - w, a + w)
        ctx.closePath()
        ctx.fill()
        ctx.globalAlpha = (c.kind === 'bio' ? 0.3 : 0.55 + 0.45 * fresh) * fade
        ctx.strokeStyle = col
        ctx.lineWidth = c.near ? 2 : 1
        ctx.setLineDash(c.kind === 'bio' ? [4, 6] : [])
        ctx.beginPath()
        ctx.moveTo(from.x, from.y)
        ctx.lineTo(from.x + Math.cos(a) * len, from.y + Math.sin(a) * len)
        ctx.stroke()
        ctx.restore()
      }

      // where recent machinery bearings from different spots cross: a small amber cross each
      const lines = (cs || []).filter((c) => !c.exact && (c.kind === 'hull' || c.kind === 'vent' || c.kind === 'launch') && v.t - c.t < 25 && v.t - c.t >= 0)
      ctx.save()
      ctx.strokeStyle = 'rgba(255, 190, 90, 0.75)'
      ctx.lineWidth = 1.5
      for (let i = 0; i < lines.length; i++) {
        for (let j = i + 1; j < lines.length; j++) {
          const p = crossing(lines[i], lines[j])
          if (!p || p.x < -0.5 || p.y < -0.5 || p.x > 15.5 || p.y > 11.5) continue
          const age = v.t - Math.min(lines[i].t, lines[j].t)
          ctx.globalAlpha = Math.max(0.15, 1 - age / 25)
          const px = cx(p.x)
          const py = cy(p.y)
          const k = s * 0.14
          ctx.beginPath(); ctx.moveTo(px - k, py - k); ctx.lineTo(px + k, py + k); ctx.moveTo(px + k, py - k); ctx.lineTo(px - k, py + k); ctx.stroke()
        }
      }
      ctx.restore()

      // the last ping: a ring going out, then what it found, fading
      if (v.ping) {
        const age = v.t - v.ping.t
        if (age >= 0 && age < 8) {
          const r = Math.max(0, Math.min(1, age / 1.2)) * v.ping.radius * s
          ctx.save()
          ctx.strokeStyle = `rgba(120, 255, 210, ${Math.max(0, 0.9 - age / 8)})`
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.arc(cx(v.ping.x), cy(v.ping.y), r, 0, Math.PI * 2)
          ctx.stroke()
          if (age > 1) {
            for (const f of v.ping.found) {
              ctx.globalAlpha = Math.max(0, 1 - (age - 1) / 7)
              if (f.kind === 'bio') drawWhale(ctx, cx(f.x), cy(f.y), 0, s * 0.9, t)
              else {
                ctx.fillStyle = f.kind === 'boat' || f.kind === 'torpedo' ? PALETTE.alarm : PALETTE.amber
                ctx.beginPath()
                const rr = f.kind === 'boat' ? s * 0.32 : s * 0.15
                ctx.moveTo(cx(f.x), cy(f.y) - rr); ctx.lineTo(cx(f.x) + rr, cy(f.y)); ctx.lineTo(cx(f.x), cy(f.y) + rr); ctx.lineTo(cx(f.x) - rr, cy(f.y))
                ctx.fill()
                if (f.kind === 'boat') {
                  ctx.font = `${Math.max(9, s * 0.3)}px "Share Tech Mono", monospace`
                  ctx.fillText('ENEMY', cx(f.x), cy(f.y) - s * 0.55)
                }
              }
            }
          }
          ctx.restore()
        }
      }

      // the mark
      const b = v.boat
      if (b.marker) drawReticle(ctx, cx(b.marker.x), cy(b.marker.y), s, t, PALETTE.mark, 'MARK')

      // our torpedoes, smoothed between views, with their wire to the target
      const tr = tracks.current
      const sinceView = (nowMs - tr.viewAt) / 1000
      for (const tp of v.torpedoes) {
        const track = tr.torps.get(tp.id)
        const k = track ? Math.min(1, (nowMs - track.at) / 200) : 1
        const pos = track ? { x: track.from.x + (track.to.x - track.from.x) * k, y: track.from.y + (track.to.y - track.from.y) * k } : tp
        if (track) track.shown = pos
        const ang = Math.atan2(tp.ty - pos.y, tp.tx - pos.x)
        ctx.save()
        ctx.setLineDash([3, 5])
        ctx.strokeStyle = gid === tp.id ? 'rgba(255, 224, 102, 0.9)' : 'rgba(255, 224, 102, 0.4)'
        ctx.beginPath()
        ctx.moveTo(cx(pos.x), cy(pos.y))
        ctx.lineTo(cx(tp.tx), cy(tp.ty))
        ctx.stroke()
        ctx.restore()
        drawReticle(ctx, cx(tp.tx), cy(tp.ty), s * 0.6, t, 'rgba(255, 120, 80, 0.9)')
        // bubble trail
        ctx.strokeStyle = 'rgba(220, 250, 255, 0.4)'
        for (let i = 1; i <= 4; i++) {
          const bx = cx(pos.x) - Math.cos(ang) * s * 0.3 * i + Math.sin(t * 9 + i) * 1.5
          const by = cy(pos.y) - Math.sin(ang) * s * 0.3 * i
          ctx.beginPath(); ctx.arc(bx, by, 1 + i * 0.4, 0, Math.PI * 2); ctx.stroke()
        }
        if (!sprites.draw(ctx, 'torpedo', t, cx(pos.x), cy(pos.y), ang, s * 0.6)) drawTorpedo(ctx, cx(pos.x), cy(pos.y), ang, s * 0.55, t)
      }
      for (const d of v.decoys) {
        ctx.save()
        ctx.fillStyle = PALETTE.amber
        ctx.globalAlpha = 0.6 + 0.4 * Math.sin(t * 12)
        if (!sprites.draw(ctx, 'decoy', t, cx(d.x), cy(d.y), 0, s * 0.4)) { ctx.beginPath(); ctx.arc(cx(d.x), cy(d.y), s * 0.12, 0, Math.PI * 2); ctx.fill() }
        ctx.restore()
      }

      // our boat: slides towards the next cell as it makes way
      const speed = b.speed
      let prog = b.progress
      if (speed > 0) prog = Math.min(0.97, b.progress + sinceView / (SECONDS_PER_CELL[speed] * (b.heading % 2 ? 1.41 : 1)))
      const dl = delta(b.heading)
      const canGo = map.isWater(b.x + dl.dx, b.y + dl.dy)
      const bx = cx(b.x + (canGo ? dl.dx * prog : 0))
      const by = cy(b.y + (canGo ? dl.dy * prog : 0))
      const ang = ((b.heading * 45 - 90) * Math.PI) / 180
      const colour = live.current.team === 'bravo' ? PALETTE.red : PALETTE.blue
      // our boat's halo and a heading tick, so it is always easy to find
      ctx.save()
      const halo = ctx.createRadialGradient(bx, by, 2, bx, by, s * 1.1)
      halo.addColorStop(0, 'rgba(160, 220, 255, 0.28)')
      halo.addColorStop(1, 'rgba(160, 220, 255, 0)')
      ctx.fillStyle = halo
      ctx.beginPath(); ctx.arc(bx, by, s * 1.1, 0, Math.PI * 2); ctx.fill()
      ctx.strokeStyle = `rgba(190, 235, 255, ${0.35 + 0.25 * Math.sin(t * 3)})`
      ctx.lineWidth = 1.5
      ctx.beginPath(); ctx.arc(bx, by, s * 0.62, 0, Math.PI * 2); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(bx + Math.cos(ang) * s * 0.7, by + Math.sin(ang) * s * 0.7); ctx.lineTo(bx + Math.cos(ang) * s * 1.05, by + Math.sin(ang) * s * 1.05); ctx.stroke()
      ctx.restore()
      if (!sprites.draw(ctx, live.current.team === 'bravo' ? 'sub-red' : 'sub-blue', t, bx, by, ang, s * 1.05)) drawSub(ctx, bx, by, ang, s * 0.95, colour, t, { glow: true })

      // the torpedo room's aim: range, the line of fire and what is wrong with it
      if (m === 'aim' || m === 'guide') {
        ctx.save()
        ctx.strokeStyle = 'rgba(255, 120, 80, 0.25)'
        ctx.setLineDash([6, 6])
        ctx.beginPath()
        ctx.arc(cx(b.x), cy(b.y), TORPEDO.range * s, 0, Math.PI * 2)
        ctx.stroke()
        ctx.restore()
      }
      const target = m === 'aim' ? (hv || a) : null
      if (target) {
        const problem = shotProblem(map, b, target)
        ctx.save()
        ctx.strokeStyle = problem ? 'rgba(255, 80, 80, 0.85)' : 'rgba(120, 255, 170, 0.85)'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(cx(b.x), cy(b.y))
        ctx.lineTo(cx(target.x), cy(target.y))
        ctx.stroke()
        ctx.restore()
        drawReticle(ctx, cx(target.x), cy(target.y), s, t, problem ? PALETTE.alarm : '#7dffb0')
      }

      // blasts and the boats that sank
      for (const e of fxList || []) {
        const age = (nowMs - e.at) / 1000
        if (e.kind === 'blast') {
          if (!sprites.draw(ctx, 'blast', age, cx(e.x), cy(e.y), 0, s * 2.4, { once: true })) drawBlast(ctx, cx(e.x), cy(e.y), s, age)
        }
      }

      // the cell under the pointer
      if (hv && map.inBounds(hv.x, hv.y)) {
        ctx.strokeStyle = m === 'look' ? 'rgba(255,255,255,0.2)' : 'rgba(255, 224, 102, 0.8)'
        ctx.lineWidth = 1.5
        ctx.strokeRect(ox + hv.x * s + 1, oy + hv.y * s + 1, s - 2, s - 2)
        ctx.fillStyle = 'rgba(230, 255, 245, 0.85)'
        ctx.font = `${Math.max(10, s * 0.32)}px "Share Tech Mono", monospace`
        ctx.textAlign = 'left'
        const label = `${cellName(hv.x, hv.y)}  ${Math.round(dist(b, hv) * 10) / 10} cells`
        ctx.fillText(label, ox + 4, size.h - oy * 0.35)
      }
    }
    raf = requestAnimationFrame(frame)
    return () => { cancelAnimationFrame(raf); ro.disconnect() }
  }, [])

  const cellAt = (e) => {
    const rect = canvasRef.current.getBoundingClientRect()
    const s = rect.width / 16.8
    const x = Math.floor((e.clientX - rect.left - s * 0.8) / s)
    const y = Math.floor((e.clientY - rect.top - s * 0.8) / s)
    return x >= 0 && y >= 0 && x < 16 && y < 12 ? { x, y } : null
  }

  return (
    <div className={`chart-wrap mode-${mode}`} ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="chart-canvas"
        role="img"
        aria-label="The chart table: our boat, the bearings we heard and the mark"
        onPointerMove={(e) => setHover(cellAt(e))}
        onPointerLeave={() => setHover(null)}
        onClick={(e) => { const c = cellAt(e); if (c && onCell) onCell(c) }}
      />
    </div>
  )
}
