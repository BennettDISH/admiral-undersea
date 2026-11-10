#!/usr/bin/env node
/**
 * The crew's callouts, made with ElevenLabs text to speech from the lines in
 * client/src/game/voice.js, one voice per station and one for the deck:
 *
 *   set -a; . ~/.config/games-media/elevenlabs.env; set +a
 *   node scripts/voices.mjs --list            the account's voices and the credits left
 *   node scripts/voices.mjs [--only a,b] [--force] [--dry]
 *
 * Each line is saved as client/public/audio/voice/<station>-<line>.mp3 (kept unless --force or
 * --only names it) and written into client/public/audio/manifest.json as voice.<station>.<line>,
 * served from this site. --dry prints what it would make and what it would cost. The key comes from
 * ELEVENLABS_API_KEY in the environment and is never printed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = resolve(ROOT, 'client/public/audio/voice')
const MANIFEST = resolve(ROOT, 'client/public/audio/manifest.json')
const API = 'https://api.elevenlabs.io/v1'
const MODEL = 'eleven_multilingual_v2'

// The voice for each speaker (ElevenLabs voice ids, picked from --list; VOICE_<SPEAKER> in the
// environment overrides one) and how it is played. These are the crew's voices since 2026-11-09:
// Charlie at the helm, Alice listening, Harry in the torpedo room, Hector the chief, Adam on deck.
export const CAST = {
  helm: { voice: process.env.VOICE_HELM || 'IKne3meq5aSn9XLyUdCD', settings: { stability: 0.45, similarity_boost: 0.8, style: 0.3 } },
  listener: { voice: process.env.VOICE_LISTENER || 'Xb7hH8MSUJpSbSDYk0k2', settings: { stability: 0.4, similarity_boost: 0.8, style: 0.35 } },
  weapons: { voice: process.env.VOICE_WEAPONS || 'SOYHLrjzK2X1ezoPC6cr', settings: { stability: 0.35, similarity_boost: 0.8, style: 0.45 } },
  chief: { voice: process.env.VOICE_CHIEF || 'dgkKQcJqyy5AP0dqleUU', settings: { stability: 0.45, similarity_boost: 0.8, style: 0.35 } },
  deck: { voice: process.env.VOICE_DECK || 'pNInz6obpgDQGcFmaJgB', settings: { stability: 0.5, similarity_boost: 0.8, style: 0.4 } },
}

const args = process.argv.slice(2)
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const only = option('--only') ? new Set(option('--only').split(',')) : null
const key = process.env.ELEVENLABS_API_KEY
if (!key) { console.error('ELEVENLABS_API_KEY is not set'); process.exit(2) }
const headers = { 'xi-api-key': key, 'content-type': 'application/json' }

async function credits() {
  const res = await fetch(`${API}/user/subscription`, { headers })
  if (!res.ok) throw new Error(`subscription: ${res.status}`)
  const s = await res.json()
  return { used: s.character_count, limit: s.character_limit, tier: s.tier, resets: s.next_character_count_reset_unix }
}

const { LINES } = await import(pathToFileURL(resolve(ROOT, 'client/src/game/voice.js')).href)
const before = await credits()
console.log(`credits used ${before.used} of ${before.limit} (${before.tier}), ${before.limit - before.used} left`)

if (args.includes('--list')) {
  const res = await fetch(`${API}/voices`, { headers })
  const { voices } = await res.json()
  for (const v of voices) {
    const l = v.labels || {}
    console.log(`${v.voice_id}  ${v.name.padEnd(22)} ${[l.gender, l.age, l.accent, l.description, l.use_case].filter(Boolean).join(', ')}`)
  }
  process.exit(0)
}

const fileOf = (name) => { const [, who, line] = name.split('.'); return `${who}-${line}.mp3` }
const todo = Object.entries(LINES).filter(([name]) => (only ? only.has(name) : args.includes('--force') || !existsSync(resolve(OUT, fileOf(name)))))
const cost = todo.reduce((n, [, text]) => n + text.length, 0)
console.log(`${todo.length} lines to make, ${cost} characters`)
if (cost > before.limit - before.used) { console.error('not enough credits left'); process.exit(1) }
for (const [name] of todo) {
  const who = name.split('.')[1]
  if (!CAST[who]?.voice) { console.error(`no voice set for ${who} (VOICE_${who.toUpperCase()})`); process.exit(2) }
}
if (args.includes('--dry')) { for (const [name, text] of todo) console.log(`  ${name}: ${text}`); process.exit(0) }

mkdirSync(OUT, { recursive: true })
for (const [name, text] of todo) {
  const who = name.split('.')[1]
  const { voice, settings } = CAST[who]
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}/text-to-speech/${voice}?output_format=mp3_44100_64`, {
      method: 'POST', headers, body: JSON.stringify({ text, model_id: MODEL, voice_settings: { ...settings, use_speaker_boost: true } }),
    })
    if (res.ok) { writeFileSync(resolve(OUT, fileOf(name)), Buffer.from(await res.arrayBuffer())); console.log(`  ${name}`); break }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) { await new Promise((r) => setTimeout(r, 10000 * (attempt + 1))); continue }
    console.error(`  ${name}: ${res.status} ${(await res.text()).slice(0, 160)}`)
    process.exit(1)
  }
}

// Every line on disk goes into the game's manifest.
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
for (const name of Object.keys(LINES)) {
  if (existsSync(resolve(OUT, fileOf(name)))) manifest.sounds[name] = { src: [`/audio/voice/${fileOf(name)}`], gain: 1 }
}
writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
const after = await credits()
console.log(`done: ${after.used - before.used} characters used, ${after.limit - after.used} left`)
