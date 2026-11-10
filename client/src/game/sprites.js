// The sprite factory's art (games-media): the crew's talking portraits and the undersea set (the
// boats, torpedoes, blasts, decoys, whales). The art manifest (public/art/manifest.json) names
// each set's frames file on the media host: { sets: { name: url } }. A frames file lists, per clip,
// frames as [atlas, x, y, w, h, ox, oy]: a rectangle in an atlas image and where its top-left sits
// from the set's anchor, plus the set's bounds around that anchor. Parts baked from the same body
// (a portrait's mouths and blink) share its anchor, so they lie over it frame for frame.
//
// Until a set has loaded, the draw calls answer false and the game draws our procedural art
// (draw.js, the CrewPanel stand-in faces) instead.

const sets = new Map() // name -> { bounds, clips: { name: { fps, loop, frames } }, atlases: [Image] }
const clipIndex = new Map() // clip name -> set name, for sets made of named clips (fx-undersea)
let started = false

async function loadSet(name, url) {
  const res = await fetch(url)
  if (!res.ok) return
  const data = await res.json()
  const base = url.slice(0, url.lastIndexOf('/') + 1)
  const atlases = await Promise.all((data.atlases || []).map((a) => new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = base + a.file
  })))
  if (atlases.some((a) => !a)) return
  const clips = {}
  for (const [clip, c] of Object.entries(data.clips || {})) {
    const byDir = c.frames || {}
    const frames = byDir[Object.keys(byDir)[0]] || []
    if (!frames.length) continue
    // the clip's own extent around the anchor, so a small clip is sized by itself, not the set
    let b = [Infinity, Infinity, -Infinity, -Infinity]
    for (const [, , , w, h, ox, oy] of frames) b = [Math.min(b[0], ox), Math.min(b[1], oy), Math.max(b[2], ox + w), Math.max(b[3], oy + h)]
    clips[clip] = { fps: c.fps || 8, loop: c.loop !== false, frames, bounds: b }
  }
  sets.set(name, { bounds: data.bounds || [-16, -16, 16, 16], clips, atlases })
  for (const clip of Object.keys(clips)) if (!clipIndex.has(clip)) clipIndex.set(clip, name)
}

/** Load every set the art manifest names. Safe to call from every page; it loads once. */
export async function loadArt(url = '/art/manifest.json') {
  if (started) return
  started = true
  try {
    const res = await fetch(url, { cache: 'no-cache' })
    if (!res.ok) return
    const manifest = await res.json()
    const entries = Object.entries(manifest?.sets || {}).filter(([n, u]) => typeof n === 'string' && typeof u === 'string' && /^https:\/\/media\.bennettdishmanmedia\.com\//.test(u))
    await Promise.all(entries.map(([n, u]) => loadSet(n, u).catch(() => {})))
  } catch {
    /* no art: the procedural look stays */
  }
}

export const hasSet = (name) => sets.has(name)

/** The frame of a clip `t` seconds in, or null past the end of a one-shot. */
export function frameAt(clip, t, once = false) {
  const n = clip.frames.length
  let i = Math.floor(t * clip.fps)
  if (once || !clip.loop) {
    if (i >= n) return null
    i = Math.max(0, i)
  } else i = ((i % n) + n) % n
  return clip.frames[i]
}

function blit(ctx, set, f, ax, ay, scale) {
  const [atlas, x, y, w, h, ox, oy] = f
  ctx.drawImage(set.atlases[atlas], x, y, w, h, ax + ox * scale, ay + oy * scale, w * scale, h * scale)
}

/**
 * A portrait set (and its parts) fitted into a size x size box: the body's idle, then each named
 * part set over it. False when the body has not loaded.
 */
export function drawPortrait(ctx, name, t, size, parts = []) {
  const body = sets.get(name)
  if (!body?.clips.idle) return false
  const [x0, y0, x1, y1] = body.bounds
  const scale = Math.min(size / (x1 - x0), size / (y1 - y0))
  const ax = size / 2 - ((x0 + x1) / 2) * scale
  const ay = size - y1 * scale
  ctx.imageSmoothingEnabled = false
  const f = frameAt(body.clips.idle, t)
  if (f) blit(ctx, body, f, ax, ay, scale)
  for (const p of parts) {
    const part = sets.get(p)
    const clip = part?.clips.idle
    if (!clip) continue
    // a part bakes the same frames as its body: draw the same frame number
    const pf = clip.frames[Math.floor(t * body.clips.idle.fps) % clip.frames.length]
    if (pf) blit(ctx, part, pf, ax, ay, scale)
  }
  return true
}

const api = {
  /**
   * Draw clip `name` (from whichever set has it) at (x, y), turned by `angle` (the art points east),
   * `size` pixels across the set's longest side. For a one-shot, `t` is its age. False when the clip
   * has not loaded; a finished one-shot draws nothing and answers true.
   */
  draw(ctx, name, t, x, y, angle, size, { once = false, anchored = false } = {}) {
    const set = sets.get(clipIndex.get(name))
    const clip = set?.clips[name]
    if (!clip) return false
    const f = frameAt(clip, t, once)
    if (!f) return true
    const [x0, y0, x1, y1] = clip.bounds
    const scale = size / Math.max(x1 - x0, y1 - y0)
    ctx.save()
    ctx.imageSmoothingEnabled = false
    ctx.translate(x, y)
    ctx.rotate(angle)
    // a mover turns about its own anchor (a sub's hull, not its wake); anything else is centred
    if (anchored) blit(ctx, set, f, 0, 0, scale)
    else blit(ctx, set, f, -((x0 + x1) / 2) * scale, -((y0 + y1) / 2) * scale, scale)
    ctx.restore()
    return true
  },
}

export const getSprites = () => api
