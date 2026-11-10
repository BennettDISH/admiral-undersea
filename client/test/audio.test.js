// The boat's sound (src/lib/audio.js, src/lib/soundNames.js, public/audio/manifest.json) and the
// crew's lines (src/game/voice.js): what the manifest may name, where its files live, the loops,
// the saved levels, and the ElevenLabs budget the lines keep to.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { DEFAULT_PREFS, SCENES, decodeOrder, parseManifest, prefsFrom } from '../src/lib/audio.js'
import { SFX, isSoundName } from '../src/lib/soundNames.js'
import { LINES, speakerOf, totalCharacters } from '../src/game/voice.js'

const manifest = JSON.parse(readFileSync(new URL('../public/audio/manifest.json', import.meta.url), 'utf8'))
// a take (admiral-blip-2-<hash>.mp3) or a song's layer or sting (admiral-deep-calm-<hash>.mp3)
const MEDIA = /^https:\/\/media\.bennettdishmanmedia\.com\/sounds\/admiral-[a-z0-9-]+\/admiral-[a-z0-9-]+-[0-9a-f]{8}\.mp3$/
const OWN_VOICE = /^\/audio\/voice\/(helm|listener|weapons|chief|deck)-[a-z0-9-]+\.mp3$/

test('the manifest names only sounds the boat asks for: ours on the media host, the crew lines on this site', () => {
  const { sounds, dropped } = parseManifest(manifest)
  assert.deepEqual(dropped, [])
  for (const [name, s] of sounds) {
    assert.ok(s.gain > 0 && s.gain <= 4, `${name}: gain ${s.gain}`)
    for (const url of s.urls) {
      if (name.startsWith('voice.')) {
        assert.match(url, OWN_VOICE, `${name}: ${url}`)
        assert.ok(existsSync(new URL(`../public${url}`, import.meta.url)), `${name}: ${url} is on disk`)
      } else assert.match(url, MEDIA, `${name}: ${url}`)
    }
  }
})

test('every effect, loop and line the game asks for has a recording', () => {
  const { sounds } = parseManifest(manifest)
  const missing = [...SFX, ...Object.keys(LINES)].filter((n) => !sounds.has(n))
  assert.deepEqual(missing, [])
  for (const scene of Object.values(SCENES)) for (const [name] of scene) assert.ok(sounds.get(name)?.loop || name.startsWith('amb.'), `${name} loops`)
})

test('a manifest entry that is malformed or not ours is dropped, not played; loop points are read', () => {
  const { sounds, dropped } = parseManifest({
    sounds: {
      sonar: 'https://media.bennettdishmanmedia.com/a.mp3',
      hit: { src: ['https://media.bennettdishmanmedia.com/b.mp3', 'has space.mp3'], gain: 9 },
      kazoo: 'https://media.bennettdishmanmedia.com/c.mp3',
      far: { src: [] },
      'music.calm': { src: 'https://media.bennettdishmanmedia.com/m.mp3', loopStart: 1.5, loopEnd: 33.5 },
      'music.fight': { src: 'https://media.bennettdishmanmedia.com/f.mp3', loopStart: 3, loopEnd: 2 },
      'voice.helm.full': '/audio/voice/helm-full.mp3',
      'voice.captain.full': '/audio/voice/x.mp3',
    },
  })
  assert.deepEqual([...sounds.keys()], ['sonar', 'hit', 'music.calm', 'music.fight', 'voice.helm.full'])
  assert.equal(sounds.get('hit').gain, 1, 'a gain out of range falls back to 1')
  assert.deepEqual(sounds.get('hit').urls, ['https://media.bennettdishmanmedia.com/b.mp3'])
  assert.deepEqual(sounds.get('music.calm').loop, { start: 1.5, end: 33.5 })
  assert.equal(sounds.get('music.fight').loop, null, 'an end before the start is no loop')
  assert.equal(dropped.length, 3)
  assert.deepEqual(parseManifest(null).dropped, ['manifest is not an object'])
  assert.deepEqual(parseManifest({}).dropped, ['manifest has no sounds'])
  assert.ok(!isSoundName('kazoo'))
  assert.ok(!isSoundName('voice.helm.'))
  assert.ok(!isSoundName('voice.helm.a b'))
})

test('the deck decodes first: the clicks and its music before the effects, the voices, then the hunt music', () => {
  const names = new Map(['music.fight', 'voice.helm.full', 'blip', 'music.menu', 'ui.click'].map((n) => [n, {}]))
  assert.deepEqual(decodeOrder(names), ['ui.click', 'music.menu', 'blip', 'voice.helm.full', 'music.fight'])
})

test('saved sound settings are read safely', () => {
  assert.deepEqual(prefsFrom(null), DEFAULT_PREFS)
  assert.deepEqual(prefsFrom('not json'), DEFAULT_PREFS)
  assert.deepEqual(prefsFrom('{"muted":true,"master":3,"music":-1}'), { muted: true, master: 1, music: 0 })
  assert.deepEqual(prefsFrom('{"muted":"yes","master":"loud"}'), DEFAULT_PREFS)
})

test('the crew lines are short, each spoken by a station or the deck, and the batch keeps to its budget', () => {
  for (const [name, text] of Object.entries(LINES)) {
    assert.ok(isSoundName(name), name)
    assert.ok(['helm', 'listener', 'weapons', 'chief', 'deck'].includes(speakerOf(name)), name)
    assert.ok(text.length <= 48, `${name} is short`)
  }
  assert.ok(totalCharacters() < 2000, `${totalCharacters()} characters`)
})
