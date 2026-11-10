// The sprite factory's art on the chart (games-media's fx-undersea set: the boats, torpedoes,
// blasts, decoys and whales) and the crew's portraits. Sheets load once from the media host the
// art manifest (public/art/manifest.json) names; until a clip has loaded, draw() answers false
// and the chart draws our procedural art instead (draw.js).
//
// A clip is { image, frames: [{ x, y, w, h }], fps, loop, anchor: { x, y } } once loaded.

const clips = new Map()
let started = false

/** Load the art manifest's clips: { clips: { name: { src, frames, fps, loop, anchor } } }. */
export async function loadArt(url = '/art/manifest.json') {
  if (started) return
  started = true
  try {
    const res = await fetch(url, { cache: 'no-cache' })
    if (!res.ok) return
    const manifest = await res.json()
    const entries = Object.entries(manifest?.clips || {})
    const images = new Map()
    for (const [name, c] of entries) {
      if (!c || typeof c.src !== 'string' || !Array.isArray(c.frames) || !c.frames.length) continue
      if (!images.has(c.src)) {
        images.set(c.src, new Promise((resolve) => {
          const img = new Image()
          img.crossOrigin = 'anonymous'
          img.onload = () => resolve(img)
          img.onerror = () => resolve(null)
          img.src = c.src
        }))
      }
      images.get(c.src).then((img) => {
        if (img) clips.set(name, { image: img, frames: c.frames, fps: c.fps || 12, loop: c.loop !== false, anchor: c.anchor || { x: 0.5, y: 0.5 }, size: c.size || null })
      })
    }
  } catch {
    /* no art: the procedural look stays */
  }
}

export const hasClip = (name) => clips.has(name)
export const clipOf = (name) => clips.get(name) || null

/** The frame a clip shows `t` seconds in, or null past the end of a one-shot. */
export function frameAt(clip, t, once = false) {
  const n = clip.frames.length
  let i = Math.floor(t * clip.fps)
  if (once || !clip.loop) { if (i >= n) return null; i = Math.max(0, i) }
  else i = ((i % n) + n) % n
  return clip.frames[i]
}

const api = {
  /**
   * Draw clip `name` at (x, y), turned by `angle` (the art points east), `size` pixels across its
   * longest side. For a one-shot, `t` is its age. False when the clip has not loaded (or is over).
   */
  draw(ctx, name, t, x, y, angle, size, { once = false } = {}) {
    const clip = clips.get(name)
    if (!clip) return false
    const f = frameAt(clip, t, once)
    if (!f) return once // a finished one-shot: drawn (nothing), so no fallback either
    const scale = size / Math.max(f.w, f.h)
    ctx.save()
    ctx.imageSmoothingEnabled = false
    ctx.translate(x, y)
    ctx.rotate(angle)
    ctx.drawImage(clip.image, f.x, f.y, f.w, f.h, -f.w * scale * clip.anchor.x, -f.h * scale * clip.anchor.y, f.w * scale, f.h * scale)
    ctx.restore()
    return true
  },
}

export const getSprites = () => api
