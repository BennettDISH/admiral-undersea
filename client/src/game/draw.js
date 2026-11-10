// Our own procedural art for the chart table and the scope: rocks, vent fields, the boats, the
// torpedoes, blasts and bubbles, drawn on a canvas. Where the sprite factory's undersea set has
// loaded (sprites.js), the boats, torpedoes, blasts and whales use its frames instead; these are
// the look before it arrives and wherever it has no clip.

// A cheap seeded noise so every rock keeps its own shape from frame to frame.
export function hash(x, y, k = 0) {
  let h = (x * 374761393 + y * 668265263 + k * 2147483647) | 0
  h = (h ^ (h >>> 13)) * 1274126177
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

export const PALETTE = {
  sea0: '#031a24',
  sea1: '#06303c',
  grid: 'rgba(120, 220, 210, 0.07)',
  gridText: 'rgba(150, 220, 210, 0.55)',
  rock: '#1b2a2c',
  rockLit: '#3d5552',
  rockEdge: '#0a1112',
  vent: 'rgba(255, 140, 60, 0.18)',
  hull: '#5dffb0',
  bio: '#6fc8ff',
  alarm: '#ff4d4d',
  amber: '#ffb347',
  mark: '#ffe066',
  blue: '#7fb6d8',
  red: '#d8735f',
}

/** One rock cell as a lumpy boulder, joined to its rock neighbours. */
export function drawRock(ctx, map, x, y, s, ox, oy) {
  const cx = ox + x * s + s / 2
  const cy = oy + y * s + s / 2
  const pts = 9
  ctx.beginPath()
  for (let i = 0; i < pts; i++) {
    const a = (i / pts) * Math.PI * 2
    const dx = Math.cos(a)
    const dy = Math.sin(a)
    // reach into a rock neighbour so a ridge reads as one shape
    const nx = Math.round(dx)
    const ny = Math.round(dy)
    const joined = (nx || ny) && map.isRock(x + nx, y + ny)
    const r = s * (joined ? 0.72 : 0.42 + hash(x, y, i) * 0.14)
    const px = cx + dx * r
    const py = cy + dy * r
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.closePath()
  const g = ctx.createRadialGradient(cx - s * 0.18, cy - s * 0.2, s * 0.05, cx, cy, s * 0.7)
  g.addColorStop(0, PALETTE.rockLit)
  g.addColorStop(1, PALETTE.rock)
  ctx.fillStyle = g
  ctx.fill()
  ctx.strokeStyle = PALETTE.rockEdge
  ctx.lineWidth = Math.max(1, s * 0.05)
  ctx.stroke()
  // a few specks of weed
  ctx.fillStyle = 'rgba(80, 140, 90, 0.35)'
  for (let i = 0; i < 3; i++) {
    const px = cx + (hash(x, y, 20 + i) - 0.5) * s * 0.6
    const py = cy + (hash(x, y, 30 + i) - 0.5) * s * 0.6
    ctx.fillRect(px, py, Math.max(1, s * 0.06), Math.max(1, s * 0.06))
  }
}

/** A vent field: warm shimmer and rising bubbles, animated by `t` seconds. */
export function drawVent(ctx, x, y, s, ox, oy, t) {
  const cx = ox + x * s + s / 2
  const cy = oy + y * s + s / 2
  const pulse = 0.5 + 0.5 * Math.sin(t * 1.7 + hash(x, y) * 6)
  const g = ctx.createRadialGradient(cx, cy, 1, cx, cy, s * 0.7)
  g.addColorStop(0, `rgba(255, 150, 70, ${0.16 + pulse * 0.12})`)
  g.addColorStop(1, 'rgba(255, 150, 70, 0)')
  ctx.fillStyle = g
  ctx.fillRect(cx - s * 0.7, cy - s * 0.7, s * 1.4, s * 1.4)
  ctx.strokeStyle = 'rgba(220, 240, 255, 0.35)'
  ctx.lineWidth = 1
  for (let i = 0; i < 3; i++) {
    const phase = (t * 0.5 + hash(x, y, i)) % 1
    const bx = cx + (hash(x, y, 10 + i) - 0.5) * s * 0.7 + Math.sin(t * 3 + i) * 2
    const by = cy + s * 0.4 - phase * s * 0.9
    ctx.beginPath()
    ctx.arc(bx, by, Math.max(1, s * 0.05 * (1 - phase * 0.5)), 0, Math.PI * 2)
    ctx.stroke()
  }
}

/** A boat seen from above, pointing along `angle` (radians, 0 east), `len` long. */
export function drawSub(ctx, x, y, angle, len, colour, t, { glow = false } = {}) {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(angle)
  const w = len * 0.28
  if (glow) {
    ctx.shadowColor = colour
    ctx.shadowBlur = len * 0.5
  }
  // hull
  ctx.beginPath()
  ctx.moveTo(len * 0.52, 0)
  ctx.quadraticCurveTo(len * 0.38, -w * 0.62, len * 0.1, -w * 0.5)
  ctx.lineTo(-len * 0.36, -w * 0.42)
  ctx.quadraticCurveTo(-len * 0.52, -w * 0.2, -len * 0.5, 0)
  ctx.quadraticCurveTo(-len * 0.52, w * 0.2, -len * 0.36, w * 0.42)
  ctx.lineTo(len * 0.1, w * 0.5)
  ctx.quadraticCurveTo(len * 0.38, w * 0.62, len * 0.52, 0)
  const g = ctx.createLinearGradient(0, -w / 2, 0, w / 2)
  g.addColorStop(0, '#9fb4bf')
  g.addColorStop(0.5, colour)
  g.addColorStop(1, '#1a252b')
  ctx.fillStyle = g
  ctx.fill()
  ctx.shadowBlur = 0
  ctx.strokeStyle = 'rgba(0,0,0,0.6)'
  ctx.lineWidth = 1
  ctx.stroke()
  // conning tower
  ctx.fillStyle = '#2b3a42'
  ctx.beginPath()
  ctx.ellipse(len * 0.08, 0, len * 0.12, w * 0.24, 0, 0, Math.PI * 2)
  ctx.fill()
  // stern planes
  ctx.fillStyle = '#26333a'
  ctx.fillRect(-len * 0.5, -w * 0.62, len * 0.07, w * 1.24)
  // prop wash
  ctx.strokeStyle = 'rgba(200, 240, 255, 0.35)'
  for (let i = 0; i < 3; i++) {
    const p = (t * 2 + i / 3) % 1
    ctx.beginPath()
    ctx.arc(-len * 0.55 - p * len * 0.35, (hash(i, 1) - 0.5) * w * 0.6, 1 + p * 2, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.restore()
}

/** A torpedo pointing along `angle`. */
export function drawTorpedo(ctx, x, y, angle, len, t, colour = '#d9e4ea') {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(angle)
  ctx.fillStyle = colour
  ctx.beginPath()
  ctx.ellipse(0, 0, len / 2, len * 0.12, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#ff6a4d'
  ctx.beginPath()
  ctx.arc(len * 0.45, 0, len * 0.08, 0, Math.PI * 2)
  ctx.fill()
  // a flickering prop
  ctx.fillStyle = `rgba(255, 255, 255, ${0.4 + 0.4 * Math.sin(t * 40)})`
  ctx.fillRect(-len * 0.58, -len * 0.12, len * 0.06, len * 0.24)
  ctx.restore()
}

/** A whale from above, its tail beating. */
export function drawWhale(ctx, x, y, angle, len, t, alpha = 1) {
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.translate(x, y)
  ctx.rotate(angle)
  ctx.fillStyle = '#4f7fa3'
  ctx.beginPath()
  ctx.ellipse(0, 0, len * 0.4, len * 0.14, 0, 0, Math.PI * 2)
  ctx.fill()
  const beat = Math.sin(t * 3) * len * 0.08
  ctx.beginPath()
  ctx.moveTo(-len * 0.36, 0)
  ctx.lineTo(-len * 0.56, -len * 0.14 + beat)
  ctx.lineTo(-len * 0.5, beat * 0.3)
  ctx.lineTo(-len * 0.56, len * 0.14 + beat)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

/** An underwater blast `age` seconds old (about 1.6 s long), `s` the cell size. False when done. */
export function drawBlast(ctx, x, y, s, age) {
  if (age > 1.8) return false
  const k = age / 1.8
  ctx.save()
  // flash
  if (age < 0.25) {
    ctx.fillStyle = `rgba(255, 250, 220, ${1 - age / 0.25})`
    ctx.beginPath()
    ctx.arc(x, y, s * (0.6 + age * 3), 0, Math.PI * 2)
    ctx.fill()
  }
  // fireball into a bubble cloud
  const r = s * (0.4 + Math.sqrt(k) * 1.3)
  const g = ctx.createRadialGradient(x, y, 1, x, y, r)
  g.addColorStop(0, `rgba(255, 200, 90, ${0.9 * (1 - k)})`)
  g.addColorStop(0.45, `rgba(255, 110, 40, ${0.6 * (1 - k)})`)
  g.addColorStop(1, 'rgba(180, 210, 220, 0)')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fill()
  // shock ring
  ctx.strokeStyle = `rgba(220, 245, 255, ${0.8 * (1 - k)})`
  ctx.lineWidth = Math.max(1, s * 0.08 * (1 - k))
  ctx.beginPath()
  ctx.arc(x, y, s * (0.3 + k * 2.4), 0, Math.PI * 2)
  ctx.stroke()
  // bubbles
  ctx.strokeStyle = `rgba(230, 250, 255, ${0.7 * (1 - k)})`
  ctx.lineWidth = 1
  for (let i = 0; i < 9; i++) {
    const a = hash(i, 7) * Math.PI * 2
    const d = s * (0.3 + hash(i, 9) * 1.2) * Math.sqrt(k)
    ctx.beginPath()
    ctx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d - k * s * 0.8, 1 + hash(i, 3) * s * 0.08, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.restore()
  return true
}

/** A target reticle, pulsing. */
export function drawReticle(ctx, x, y, s, t, colour = PALETTE.mark, label = '') {
  const r = s * (0.42 + 0.06 * Math.sin(t * 5))
  ctx.save()
  ctx.strokeStyle = colour
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.stroke()
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2
    ctx.beginPath()
    ctx.moveTo(x + Math.cos(a) * r * 0.55, y + Math.sin(a) * r * 0.55)
    ctx.lineTo(x + Math.cos(a) * r * 1.35, y + Math.sin(a) * r * 1.35)
    ctx.stroke()
  }
  if (label) {
    ctx.fillStyle = colour
    ctx.font = `${Math.max(9, s * 0.3)}px "Share Tech Mono", monospace`
    ctx.textAlign = 'center'
    ctx.fillText(label, x, y - r - 4)
  }
  ctx.restore()
}
