// The boat's sound: sample playback from a manifest over one AudioContext, an effects bus under a
// master and a soft limiter, a remembered mute and level, and the mobile unlock. It follows the
// module the other games share (Consequence Deck's, from the pilot): a name with no decoded file
// answers false from `play`, and the game just stays quiet there. `tone` is the one synth sound:
// the radio operator's move cue, whose pitch says which way the enemy went.
//
// Manifest (public/audio/manifest.json): { version, sounds: { name: url | [urls] | { src, gain } } }.
// Several urls under one name are takes picked at random. Urls are absolute (the media host the
// server's CSP names in connect-src). Files are fetched and decoded once the page has had a gesture.

import { isSoundName } from './soundNames.js'

export const PREFS_KEY = 'admiral.audio'
export const MANIFEST_URL = '/audio/manifest.json'
export const DEFAULT_PREFS = Object.freeze({ muted: false, master: 0.8 })

/** Per play: a little pitch and level spread so one recording heard twice is not a machine. */
const PITCH_JITTER = 0.03
const VOL_JITTER = 0.1
const MAX_VOICES = 12
const MAX_PER_NAME = 3

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)

export function prefsFrom(raw) {
  const base = { ...DEFAULT_PREFS }
  if (!raw) return base
  try {
    const p = JSON.parse(raw)
    return {
      muted: typeof p.muted === 'boolean' ? p.muted : base.muted,
      master: typeof p.master === 'number' && Number.isFinite(p.master) ? clamp01(p.master) : base.master,
    }
  } catch {
    return base
  }
}

/** The manifest's sounds, dropping anything malformed or not a sound the boat asks for (`dropped` says why). */
export function parseManifest(raw, known = isSoundName) {
  const sounds = new Map()
  const dropped = []
  if (typeof raw !== 'object' || raw === null) return { sounds, dropped: ['manifest is not an object'] }
  const list = raw.sounds
  if (typeof list !== 'object' || list === null) return { sounds, dropped: ['manifest has no sounds'] }
  for (const [name, entry] of Object.entries(list)) {
    if (!known(name)) {
      dropped.push(`${name}: not a sound the boat asks for`)
      continue
    }
    let src = entry
    let gain = 1
    if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
      src = entry.src
      if (typeof entry.gain === 'number' && Number.isFinite(entry.gain) && entry.gain >= 0 && entry.gain <= 4) gain = entry.gain
    }
    const urls = (Array.isArray(src) ? src : [src]).filter((u) => typeof u === 'string' && u.length > 0 && !/\s/.test(u))
    if (urls.length === 0) {
      dropped.push(`${name}: no url`)
      continue
    }
    sounds.set(name, { urls, gain })
  }
  return { sounds, dropped }
}

function storageGet(key) {
  try { return window.localStorage.getItem(key) } catch { return null }
}
function storageSet(key, value) {
  try { window.localStorage.setItem(key, value) } catch { /* private mode */ }
}

export class GameAudio {
  constructor() {
    this.prefs = prefsFrom(storageGet(PREFS_KEY))
    this.ctx = null
    this.master = null
    this.sfxBus = null
    this.sounds = new Map()
    this.buffers = new Map()
    this.failed = new Set()
    this.lastAt = new Map()
    this.voices = 0
    this.voicesByName = new Map()
    this.manifestUrl = null
    this.loaded = false
    this.loading = null
    this.listeners = new Set()
    this.visibilityBound = false
    // Bound here so the speaker button can hand them to useSyncExternalStore as they are.
    this.subscribe = (fn) => { this.listeners.add(fn); return () => this.listeners.delete(fn) }
    this.snapshot = () => this.prefs
  }

  get muted() { return this.prefs.muted }
  get ready() { return this.ctx !== null && this.ctx.state === 'running' }

  emit() { for (const fn of this.listeners) fn() }

  /** Call from a user gesture: opens the context, applies the saved level, starts loading the manifest. */
  unlock() {
    if (!this.ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext
      if (!Ctor) return
      try { this.build(new Ctor()) } catch { return }
    }
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => { /* needs another gesture */ })
    this.applyPrefs()
    if (!this.visibilityBound) {
      this.visibilityBound = true
      // A hidden tab stops making sound; coming back wakes the context again.
      document.addEventListener('visibilitychange', () => {
        if (!this.ctx) return
        if (document.hidden) this.ctx.suspend().catch(() => { /* already closed */ })
        else this.ctx.resume().catch(() => { /* needs a gesture */ })
      })
    }
    if (this.manifestUrl && !this.loaded && !this.loading) this.load(this.manifestUrl)
  }

  build(ctx) {
    this.ctx = ctx
    const master = ctx.createGain()
    master.gain.value = this.prefs.muted ? 0 : this.prefs.master
    // A soft limiter: a hit on top of a creak and a ping never clips.
    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -8
    limiter.knee.value = 10
    limiter.ratio.value = 12
    limiter.attack.value = 0.003
    limiter.release.value = 0.2
    master.connect(limiter)
    limiter.connect(ctx.destination)
    this.master = master
    this.sfxBus = ctx.createGain()
    this.sfxBus.gain.value = 0.9
    this.sfxBus.connect(master)
  }

  applyPrefs() {
    if (!this.ctx) return
    this.master.gain.setTargetAtTime(this.prefs.muted ? 0 : this.prefs.master, this.ctx.currentTime, 0.02)
  }

  setPrefs(next) {
    this.prefs = { ...this.prefs, ...next }
    storageSet(PREFS_KEY, JSON.stringify(this.prefs))
    this.applyPrefs()
    this.emit()
  }

  toggleMute() {
    this.setPrefs({ muted: !this.prefs.muted })
    return this.prefs.muted
  }

  /** Point at the manifest; it loads once the context exists (after the first gesture). */
  use(manifestUrl) {
    this.manifestUrl = manifestUrl
    if (this.ctx) this.load(manifestUrl)
  }

  /** Fetch the manifest and decode every file it names. Safe to call again; a second call waits for the first. */
  load(manifestUrl) {
    if (this.loading) return this.loading
    this.loading = (async () => {
      try {
        const res = await fetch(manifestUrl, { cache: 'no-cache' })
        if (!res.ok) return
        const { sounds } = parseManifest(await res.json())
        for (const [name, sound] of sounds) this.sounds.set(name, sound)
        this.loaded = true
        const urls = new Set()
        for (const s of sounds.values()) for (const u of s.urls) urls.add(u)
        await Promise.all([...urls].map((u) => this.decode(u)))
      } catch {
        /* no manifest: the boat stays quiet */
      } finally {
        this.loading = null
      }
    })()
    return this.loading
  }

  async decode(url) {
    if (!this.ctx || this.buffers.has(url) || this.failed.has(url)) return
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(String(res.status))
      this.buffers.set(url, await this.ctx.decodeAudioData(await res.arrayBuffer()))
    } catch {
      this.failed.add(url)
    }
  }

  /** True when `name` has at least one decoded file. */
  has(name) {
    const s = this.sounds.get(name)
    return s !== undefined && s.urls.some((u) => this.buffers.has(u))
  }

  pick(name) {
    const s = this.sounds.get(name)
    if (!s) return null
    const ready = s.urls.filter((u) => this.buffers.has(u))
    if (ready.length === 0) return null
    return { buffer: this.buffers.get(ready[Math.floor(Math.random() * ready.length)]), gain: s.gain }
  }

  /** Play a one-shot on the effects bus, `delay` seconds from now. False when there is no file for it yet. */
  play(name, { vol = 1, pitch = 1, delay = 0, throttleMs } = {}) {
    const ctx = this.ctx
    if (!ctx || !this.ready) return false
    const picked = this.pick(name)
    if (!picked) return false
    if (throttleMs) {
      const now = performance.now()
      if (now - (this.lastAt.get(name) ?? -Infinity) < throttleMs) return true
      this.lastAt.set(name, now)
    }
    const sameName = this.voicesByName.get(name) ?? 0
    if (this.voices >= MAX_VOICES || sameName >= MAX_PER_NAME) return true // the newest copy is the one nobody misses
    const src = ctx.createBufferSource()
    src.buffer = picked.buffer
    src.playbackRate.value = Math.max(0.5, Math.min(2, pitch * (1 + (Math.random() * 2 - 1) * PITCH_JITTER)))
    const g = ctx.createGain()
    g.gain.value = clamp01(vol) * picked.gain * (1 - Math.random() * VOL_JITTER)
    src.connect(g)
    g.connect(this.sfxBus)
    this.voices++
    this.voicesByName.set(name, sameName + 1)
    src.onended = () => {
      this.voices = Math.max(0, this.voices - 1)
      this.voicesByName.set(name, Math.max(0, (this.voicesByName.get(name) ?? 1) - 1))
    }
    src.start(ctx.currentTime + Math.max(0, delay))
    return true
  }

  /** A short sine blip at `freq` Hz on the effects bus (the move cue). False before the first gesture. */
  tone(freq, { seconds = 0.5, vol = 0.3 } = {}) {
    const ctx = this.ctx
    if (!ctx || !this.ready) return false
    const t = ctx.currentTime
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq
    g.gain.setValueAtTime(clamp01(vol), t)
    g.gain.exponentialRampToValueAtTime(0.01, t + seconds)
    osc.connect(g)
    g.connect(this.sfxBus)
    osc.start(t)
    osc.stop(t + seconds)
    return true
  }
}

let singleton = null

/** The one GameAudio of the page. */
export function getAudio() {
  if (!singleton) singleton = new GameAudio()
  return singleton
}

const GESTURES = ['pointerdown', 'keydown', 'touchend']

/**
 * No sound before the first gesture: every gesture until the context is running tries to open it
 * (iOS only accepts the resume inside the handler, and a phone call can interrupt it again).
 * Returns the function that stops listening.
 */
export function armAudio(audio = getAudio(), manifestUrl = MANIFEST_URL) {
  audio.use(manifestUrl)
  const stop = () => { for (const type of GESTURES) document.removeEventListener(type, unlock, true) }
  function unlock() {
    audio.unlock()
    // The context reports "running" a moment after resume(); stop listening once it does.
    setTimeout(() => { if (audio.ready) stop() }, 300)
  }
  for (const type of GESTURES) document.addEventListener(type, unlock, { capture: true, passive: true })
  return stop
}
