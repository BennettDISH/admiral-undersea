import { useEffect, useRef } from 'react'

const TTL = 45
const RANGE = 10 // cells from the middle to the rim
const COLOURS = { hull: [93, 255, 176], bio: [111, 200, 255], launch: [255, 77, 77], torpedo: [255, 77, 77], ping: [255, 77, 77], vent: [255, 179, 71], scrape: [255, 179, 71] }

/**
 * The listening post's hydrophone scope: our boat in the middle, the sweep going round, and every
 * contact as a wedge along its bearing, brightest when the sweep passes it and fading with age.
 * An exact fix (their ping, our ping's returns) sits at its distance.
 */
export default function Scope({ view, contacts, size = 260 }) {
  const ref = useRef(null)
  const live = useRef({})
  live.current = { view, contacts }

  useEffect(() => {
    const canvas = ref.current
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = size * dpr
    canvas.height = size * dpr
    let raf = 0
    const draw = (nowMs) => {
      raf = requestAnimationFrame(draw)
      const { view: v, contacts: cs } = live.current
      const ctx = canvas.getContext('2d')
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const r = size / 2 - 6
      const c = size / 2
      const t = nowMs / 1000
      const sweep = ((t % 3) / 3) * 360 // degrees, from north, clockwise

      // the glass
      ctx.clearRect(0, 0, size, size)
      const g = ctx.createRadialGradient(c, c, 4, c, c, r)
      g.addColorStop(0, '#0b2a1d')
      g.addColorStop(1, '#03110b')
      ctx.fillStyle = g
      ctx.beginPath(); ctx.arc(c, c, r, 0, Math.PI * 2); ctx.fill()
      ctx.strokeStyle = 'rgba(80, 255, 170, 0.18)'
      ctx.lineWidth = 1
      for (let i = 1; i <= 4; i++) { ctx.beginPath(); ctx.arc(c, c, (r * i) / 4, 0, Math.PI * 2); ctx.stroke() }
      for (let i = 0; i < 12; i++) {
        const a = (i * Math.PI) / 6
        ctx.beginPath(); ctx.moveTo(c, c); ctx.lineTo(c + Math.sin(a) * r, c - Math.cos(a) * r); ctx.stroke()
      }
      ctx.fillStyle = 'rgba(120, 255, 190, 0.7)'
      ctx.font = '11px "Share Tech Mono", monospace'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('N', c, c - r + 10); ctx.fillText('S', c, c + r - 10); ctx.fillText('E', c + r - 10, c); ctx.fillText('W', c - r + 10, c)

      if (v) {
        // our heading
        const ha = (v.boat.heading * 45 * Math.PI) / 180
        ctx.strokeStyle = 'rgba(130, 200, 255, 0.6)'
        ctx.setLineDash([2, 4])
        ctx.beginPath(); ctx.moveTo(c, c); ctx.lineTo(c + Math.sin(ha) * r * 0.35, c - Math.cos(ha) * r * 0.35); ctx.stroke()
        ctx.setLineDash([])

        for (const k of cs || []) {
          const age = v.t - k.t
          if (age > TTL || age < -1) continue
          const [R, G, B] = COLOURS[k.kind] || COLOURS.hull
          const fade = 1 - age / TTL
          if (k.exact) {
            const dx = k.x - v.boat.x
            const dy = k.y - v.boat.y
            const d = Math.min(1, Math.hypot(dx, dy) / RANGE)
            const a = Math.atan2(dx, -dy)
            ctx.fillStyle = `rgba(${R},${G},${B},${0.3 + 0.7 * fade})`
            ctx.beginPath(); ctx.arc(c + Math.sin(a) * d * r, c - Math.cos(a) * d * r, 4, 0, Math.PI * 2); ctx.fill()
            continue
          }
          // brighter just after the sweep passes the bearing
          const since = (((sweep - k.bearing) % 360) + 360) % 360
          const glow = Math.max(0, 1 - since / 120)
          const a0 = ((k.bearing - k.width - 90) * Math.PI) / 180
          const a1 = ((k.bearing + k.width - 90) * Math.PI) / 180
          const inner = k.near ? 0.05 : 0.2
          ctx.fillStyle = `rgba(${R},${G},${B},${(0.08 + 0.35 * glow) * fade})`
          ctx.beginPath()
          ctx.arc(c, c, r * inner, a0, a1)
          ctx.arc(c, c, r, a1, a0, true)
          ctx.closePath()
          ctx.fill()
          const am = ((k.bearing - 90) * Math.PI) / 180
          ctx.strokeStyle = `rgba(${R},${G},${B},${(0.4 + 0.6 * glow) * fade})`
          ctx.lineWidth = k.kind === 'torpedo' || k.kind === 'launch' ? 2.5 : 1.5
          ctx.beginPath(); ctx.moveTo(c + Math.cos(am) * r * inner, c + Math.sin(am) * r * inner); ctx.lineTo(c + Math.cos(am) * r, c + Math.sin(am) * r); ctx.stroke()
        }
        if (v.ping && v.t - v.ping.t < 8) {
          const age = v.t - v.ping.t
          ctx.strokeStyle = `rgba(140, 255, 210, ${Math.max(0, 0.8 - age / 8)})`
          ctx.beginPath(); ctx.arc(c, c, Math.min(1, age / 1.2) * r * Math.min(1, v.ping.radius / RANGE), 0, Math.PI * 2); ctx.stroke()
        }
      }

      // the sweep and its afterglow
      for (let i = 0; i < 24; i++) {
        const a = ((sweep - i * 2 - 90) * Math.PI) / 180
        ctx.strokeStyle = `rgba(110, 255, 180, ${0.5 * (1 - i / 24)})`
        ctx.lineWidth = 2
        ctx.beginPath(); ctx.moveTo(c, c); ctx.lineTo(c + Math.cos(a) * r, c + Math.sin(a) * r); ctx.stroke()
      }
      ctx.fillStyle = '#9fffd0'
      ctx.beginPath(); ctx.arc(c, c, 3, 0, Math.PI * 2); ctx.fill()
      // scanlines on the glass
      ctx.fillStyle = 'rgba(0,0,0,0.18)'
      for (let y = 0; y < size; y += 3) ctx.fillRect(0, y, size, 1)
      ctx.strokeStyle = '#2c3e36'
      ctx.lineWidth = 6
      ctx.beginPath(); ctx.arc(c, c, r + 3, 0, Math.PI * 2); ctx.stroke()
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [size])

  return <canvas ref={ref} className="scope-canvas" style={{ width: size, height: size }} role="img" aria-label="The hydrophone scope: the bearings we hear" />
}
