// The boat's sound, for the whole site: one AudioContext opened by the first click or key on any
// page, a manifest of our own sounds (public/audio/manifest.json), and four buses under a master
// and a soft limiter: music, ambience, effects and the crew's voices. Music and ambience are loops
// (a scene picks them: the deck's song, or the hunt's two layers crossfaded by how tense it is);
// effects are one-shots with a little spread so a sound heard twice is not a machine; voices go
// through an intercom filter and dip the music while they talk.
//
// Manifest: { version, sounds: { name: url | [urls] | { src, gain, loopStart?, loopEnd? } } }.
// Several urls under one name are takes picked at random. Urls are absolute (the media host the
// server's CSP names in connect-src) or this site's own (/audio/...).

import { isSoundName } from './soundNames.js'

export const PREFS_KEY = 'admiral.audio'
export const MANIFEST_URL = '/audio/manifest.json'
export const DEFAULT_PREFS = Object.freeze({ muted: false, master: 0.8, music: 0.6 })

const PITCH_JITTER = 0.03
const VOL_JITTER = 0.1
const MAX_VOICES = 14
const MAX_PER_NAME = 3

// What plays in each scene: [name, bus, level].
export const SCENES = {
  quiet: [],
  menu: [['music.menu', 'music', 1], ['amb.sea', 'amb', 0.45]],
  game: [['music.calm', 'music', 1], ['music.fight', 'music', 0], ['amb.hull', 'amb', 0.8], ['amb.sea', 'amb', 0.35]],
}

// Decoded first, so the deck has its music and the buttons click before the rest arrive.
const FIRST = ['ui.click', 'ui.lever', 'ui.beep', 'amb.sea', 'music.menu', 'amb.hull', 'klaxon', 'dive']

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)

export function prefsFrom(raw) {
  const base = { ...DEFAULT_PREFS }
  if (!raw) return base
  try {
    const p = JSON.parse(raw)
    const level = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? clamp01(v) : d)
    return {
      muted: typeof p.muted === 'boolean' ? p.muted : base.muted,
      master: level(p.master, base.master),
      music: level(p.music, base.music),
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
    let loop = null
    if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
      src = entry.src
      if (typeof entry.gain === 'number' && Number.isFinite(entry.gain) && entry.gain >= 0 && entry.gain <= 4) gain = entry.gain
      const { loopStart, loopEnd } = entry
      if (typeof loopStart === 'number' && typeof loopEnd === 'number' && loopStart >= 0 && loopEnd > loopStart) loop = { start: loopStart, end: loopEnd }
    }
    const urls = (Array.isArray(src) ? src : [src]).filter((u) => typeof u === 'string' && u.length > 0 && !/\s/.test(u))
    if (urls.length === 0) {
      dropped.push(`${name}: no url`)
      continue
    }
    sounds.set(name, { urls, gain, loop })
  }
  return { sounds, dropped }
}

/** The order to fetch and decode in: the deck's sounds first, then effects, voices, then the rest. */
export function decodeOrder(sounds) {
  const rank = (name) => {
    const i = FIRST.indexOf(name)
    if (i >= 0) return i
    if (name.startsWith('voice.')) return 200
    if (name.startsWith('music.') || name.startsWith('sting.')) return 300
    return 100
  }
  return [...sounds.keys()].sort((a, b) => rank(a) - rank(b))
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
    this.bus = {}
    this.sounds = new Map()
    this.buffers = new Map()
    this.failed = new Set()
    this.lastAt = new Map()
    this.voices = 0
    this.voicesByName = new Map()
    this.loops = new Map() // name -> { src, gain, base, level }
    this.want = []          // the current scene's loops, started as their files arrive
    this.sceneName = 'quiet'
    this.tensionLevel = 0
    this.musicEpoch = null  // when the hunt's layers started, so a late one comes in on the beat
    this.manifestUrl = null
    this.loaded = false
    this.loading = null
    this.listeners = new Set()
    this.visibilityBound = false
    this.talking = null     // { until } while a crew voice plays
    this.subscribe = (fn) => { this.listeners.add(fn); return () => this.listeners.delete(fn) }
    this.snapshot = () => this.prefs
  }

  get muted() { return this.prefs.muted }
  get ready() { return this.ctx !== null && this.ctx.state === 'running' }
  get unlocked() { return this.ctx !== null }

  emit() { for (const fn of this.listeners) fn() }

  /** Call from a user gesture: opens the context, applies the saved levels, starts loading the manifest. */
  unlock() {
    // iPhones mute Web Audio on the silent switch unless the page says it is playing sound.
    try { if (navigator.audioSession && navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback' } catch { /* older Safari */ }
    if (!this.ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext
      if (!Ctor) return
      try { this.build(new Ctor()) } catch { return }
      this.emit()
    }
    if (this.ctx.state !== 'running') this.ctx.resume().then(() => { this.emit(); this.scene(this.sceneName) }).catch(() => { /* needs another gesture */ })
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
    // A soft limiter: a blast on top of the klaxon and a voice never clips.
    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -8
    limiter.knee.value = 10
    limiter.ratio.value = 12
    limiter.attack.value = 0.003
    limiter.release.value = 0.25
    master.connect(limiter)
    limiter.connect(ctx.destination)
    this.master = master
    for (const [name, level] of [['music', this.prefs.music], ['amb', 0.7], ['sfx', 0.9], ['voice', 1]]) {
      const g = ctx.createGain()
      g.gain.value = level
      g.connect(master)
      this.bus[name] = g
    }
    // The intercom: a crew voice comes through a small speaker over the boat's noise.
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 320
    const presence = ctx.createBiquadFilter()
    presence.type = 'peaking'
    presence.frequency.value = 1900
    presence.Q.value = 0.9
    presence.gain.value = 5
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 3900
    const drive = ctx.createWaveShaper()
    const curve = new Float32Array(1024)
    for (let i = 0; i < curve.length; i++) { const x = (i / 511.5) - 1; curve[i] = Math.tanh(x * 1.8) / Math.tanh(1.8) }
    drive.curve = curve
    hp.connect(presence)
    presence.connect(lp)
    lp.connect(drive)
    drive.connect(this.bus.voice)
    this.intercom = hp
  }

  applyPrefs() {
    if (!this.ctx) return
    const t = this.ctx.currentTime
    this.master.gain.setTargetAtTime(this.prefs.muted ? 0 : this.prefs.master, t, 0.02)
    this.bus.music.gain.setTargetAtTime(this.prefs.music * (this.talking ? 0.45 : 1), t, 0.05)
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

  /** Fetch the manifest and decode every file it names, the deck's first. Safe to call again. */
  load(manifestUrl) {
    if (this.loading) return this.loading
    this.loading = (async () => {
      try {
        const res = await fetch(manifestUrl, { cache: 'no-cache' })
        if (!res.ok) return
        const { sounds } = parseManifest(await res.json())
        for (const [name, sound] of sounds) this.sounds.set(name, sound)
        this.loaded = true
        // A few at a time, in order, so the first ones are ready soon.
        const names = decodeOrder(sounds)
        let i = 0
        const worker = async () => {
          while (i < names.length) {
            const name = names[i++]
            await Promise.all(sounds.get(name).urls.map((u) => this.decode(u)))
            this.onDecoded(name)
          }
        }
        await Promise.all([worker(), worker(), worker(), worker()])
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

  // A scene's loop whose file just arrived starts now.
  onDecoded(name) {
    const want = this.want.find((w) => w[0] === name)
    if (want) this.startLoop(...want)
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
    return { buffer: this.buffers.get(ready[Math.floor(Math.random() * ready.length)]), gain: s.gain, loop: s.loop }
  }

  /** Play a one-shot on the effects bus, `delay` seconds from now. False when there is no file for it yet. */
  play(name, { vol = 1, pitch = 1, delay = 0, throttleMs, bus = 'sfx' } = {}) {
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
    g.connect(this.bus[bus] || this.bus.sfx)
    this.voices++
    this.voicesByName.set(name, sameName + 1)
    src.onended = () => {
      this.voices = Math.max(0, this.voices - 1)
      this.voicesByName.set(name, Math.max(0, (this.voicesByName.get(name) ?? 1) - 1))
    }
    src.start(ctx.currentTime + Math.max(0, delay))
    return true
  }

  /**
   * A crew voice over the intercom (one at a time; a newer line waits its turn, up to a second and
   * a bit, else it is dropped). Returns { seconds, startIn }, or null when it will not be heard.
   */
  say(name, { delay = 0 } = {}) {
    const ctx = this.ctx
    if (!ctx || !this.ready) return null
    const picked = this.pick(name)
    if (!picked) return null
    const now = ctx.currentTime
    const startAt = Math.max(now + delay, this.talking?.until ?? 0)
    if (startAt - now > 1.2) return null // the crew is talking over itself: drop this one
    const src = ctx.createBufferSource()
    src.buffer = picked.buffer
    const g = ctx.createGain()
    g.gain.value = picked.gain
    src.connect(g)
    g.connect(this.intercom)
    src.start(startAt)
    const until = startAt + picked.buffer.duration
    this.talking = { until }
    // the music dips while the crew talks
    this.bus.music.gain.setTargetAtTime(this.prefs.music * 0.45, startAt, 0.08)
    src.onended = () => {
      if (this.talking && this.talking.until <= until + 0.01) {
        this.talking = null
        this.bus.music.gain.setTargetAtTime(this.prefs.music, this.ctx.currentTime, 0.3)
      }
    }
    return { seconds: picked.buffer.duration, startIn: startAt - now }
  }

  // ---- loops: the music and the ambience -----------------------------------------------------
  startLoop(name, busName, level, fade = 1.5) {
    if (!this.ctx || !this.ready) return false
    if (this.loops.has(name)) { this.loopLevel(name, level, fade); return true }
    const picked = this.pick(name)
    if (!picked) return false
    const ctx = this.ctx
    const src = ctx.createBufferSource()
    src.buffer = picked.buffer
    src.loop = true
    const loop = picked.loop || { start: 0, end: picked.buffer.duration }
    src.loopStart = loop.start
    src.loopEnd = Math.min(loop.end, picked.buffer.duration)
    const g = ctx.createGain()
    g.gain.value = 0
    src.connect(g)
    g.connect(this.bus[busName] || this.bus.amb)
    // The hunt's two layers share a loop: a late one joins on the same beat.
    let offset = loop.start
    if (name === 'music.calm' || name === 'music.fight') {
      const len = src.loopEnd - src.loopStart
      if (this.musicEpoch === null) this.musicEpoch = ctx.currentTime
      else offset = loop.start + ((((ctx.currentTime - this.musicEpoch) % len) + len) % len)
    }
    src.start(ctx.currentTime, offset)
    this.loops.set(name, { src, gain: g, base: picked.gain, level: 0 })
    this.loopLevel(name, level, fade)
    return true
  }

  loopLevel(name, level, fade = 1.5) {
    const l = this.loops.get(name)
    if (!l || !this.ctx) return
    l.level = level
    l.gain.gain.setTargetAtTime(clamp01(level) * l.base, this.ctx.currentTime, Math.max(0.01, fade / 3))
  }

  stopLoop(name, fade = 1.5) {
    const l = this.loops.get(name)
    if (!l || !this.ctx) return
    this.loops.delete(name)
    l.gain.gain.setTargetAtTime(0, this.ctx.currentTime, Math.max(0.01, fade / 3))
    try { l.src.stop(this.ctx.currentTime + fade + 0.2) } catch { /* already stopped */ }
    if ((name === 'music.calm' || name === 'music.fight') && !this.loops.has('music.calm') && !this.loops.has('music.fight')) this.musicEpoch = null
  }

  /** Which loops play: 'menu' (the deck), 'game' (the hunt) or 'quiet'. Safe to call before the first click. */
  scene(name) {
    const list = SCENES[name] || []
    this.sceneName = name
    this.want = list.map(([n, bus, level]) => [n, bus, n === 'music.fight' ? this.tensionLevel : n === 'music.calm' ? 1 - this.tensionLevel * 0.6 : level])
    for (const n of [...this.loops.keys()]) if (!list.some((w) => w[0] === n)) this.stopLoop(n, 2)
    for (const w of this.want) this.startLoop(...w)
  }

  /** How tense the hunt is, 0 to 1: the fight layer comes up over the calm one. */
  tension(x) {
    const t = clamp01(x)
    if (Math.abs(t - this.tensionLevel) < 0.02) return
    this.tensionLevel = t
    for (const w of this.want) {
      if (w[0] === 'music.fight') w[2] = t
      if (w[0] === 'music.calm') w[2] = 1 - t * 0.6
    }
    if (this.sceneName !== 'game') return
    this.loopLevel('music.fight', t, 2.5)
    this.loopLevel('music.calm', 1 - t * 0.6, 2.5)
  }

  /** A short blip at `freq` Hz on the effects bus (a scope cue). False before the first gesture. */
  tone(freq, { seconds = 0.4, vol = 0.25, type = 'sine' } = {}) {
    const ctx = this.ctx
    if (!ctx || !this.ready) return false
    const t = ctx.currentTime
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = type
    osc.frequency.value = freq
    g.gain.setValueAtTime(clamp01(vol), t)
    g.gain.exponentialRampToValueAtTime(0.001, t + seconds)
    osc.connect(g)
    g.connect(this.bus.sfx)
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
 * Armed once for the whole site (App.jsx). Returns the function that stops listening.
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
