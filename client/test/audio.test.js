// The boat's sound (src/lib/audio.js, src/lib/soundNames.js, public/audio/manifest.json) and what a
// blast feels like from each side (src/game/blastFeedback.js).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DEFAULT_PREFS, parseManifest, prefsFrom } from '../src/lib/audio.js'
import { SFX, isSoundName } from '../src/lib/soundNames.js'
import { AYE_GAP, AYE_PITCH, MOVE_HZ, NEAR_MISS, TORPEDO_RUN, blastFeedback } from '../src/game/blastFeedback.js'

const manifest = JSON.parse(readFileSync(new URL('../public/audio/manifest.json', import.meta.url), 'utf8'))

test('the manifest names every sound the boat asks for, each one our own on the media host', () => {
  const { sounds, dropped } = parseManifest(manifest)
  assert.deepEqual(dropped, [])
  assert.deepEqual([...sounds.keys()].sort(), [...SFX].sort())
  for (const [name, s] of sounds) {
    assert.ok(s.gain > 0 && s.gain <= 1, `${name}: gain ${s.gain}`)
    for (const url of s.urls) {
      assert.match(url, /^https:\/\/media\.bennettdishmanmedia\.com\/sounds\/admiral-[a-z-]+\/admiral-[a-z-]+-\d-[0-9a-f]{8}\.mp3$/, `${name}: ${url}`)
    }
  }
})

test('a manifest entry that is malformed or not ours is dropped, not played', () => {
  const { sounds, dropped } = parseManifest({
    sounds: {
      sonar: 'https://media.bennettdishmanmedia.com/a.mp3',
      hit: { src: ['https://media.bennettdishmanmedia.com/b.mp3', 'has space.mp3'], gain: 9 },
      kazoo: 'https://media.bennettdishmanmedia.com/c.mp3',
      far: { src: [] },
    },
  })
  assert.deepEqual([...sounds.keys()], ['sonar', 'hit'])
  assert.equal(sounds.get('hit').gain, 1, 'a gain out of range falls back to 1')
  assert.deepEqual(sounds.get('hit').urls, ['https://media.bennettdishmanmedia.com/b.mp3'])
  assert.equal(dropped.length, 2)
  assert.deepEqual(parseManifest(null).dropped, ['manifest is not an object'])
  assert.deepEqual(parseManifest({}).dropped, ['manifest has no sounds'])
  assert.ok(!isSoundName('kazoo'))
})

test('saved sound settings are read safely', () => {
  assert.deepEqual(prefsFrom(null), DEFAULT_PREFS)
  assert.deepEqual(prefsFrom('not json'), DEFAULT_PREFS)
  assert.deepEqual(prefsFrom('{"muted":true,"master":3}'), { muted: true, master: 1 })
  assert.deepEqual(prefsFrom('{"muted":"yes","master":"loud"}'), DEFAULT_PREFS)
})

const blast = (by, weapon, origin, dmg) => ({ by, weapon, origin, results: [{ team: 'alpha', damage: dmg.alpha ?? 0 }, { team: 'bravo', damage: dmg.bravo ?? 0 }] })

test('our torpedo landing on the enemy: the launch, then a far boom after its run, and no shake', () => {
  const fx = blastFeedback(blast('alpha', 'torpedo', { x: 9, y: 9 }, { bravo: 2 }), 'alpha', { x: 5, y: 9 })
  assert.deepEqual(fx, { launch: true, boom: 'far', vol: 0.6, delay: TORPEDO_RUN, shake: null, flash: false, creak: false })
})

test('a blast that hurts us: the close boom, the creak, a big shake and the flash, whoever set it off', () => {
  const theirs = blastFeedback(blast('bravo', 'torpedo', { x: 5, y: 9 }, { alpha: 1 }), 'alpha', { x: 5, y: 8 })
  assert.deepEqual(theirs, { launch: false, boom: 'hit', vol: 1, delay: 0, shake: 'big', flash: true, creak: true })
  const ownGoal = blastFeedback(blast('alpha', 'torpedo', { x: 5, y: 9 }, { alpha: 2 }), 'alpha', { x: 5, y: 9 })
  assert.equal(ownGoal.launch, true)
  assert.equal(ownGoal.boom, 'hit')
  assert.equal(ownGoal.delay, TORPEDO_RUN)
  const mine = blastFeedback(blast('bravo', 'mine', { x: 3, y: 3 }, { alpha: 1 }), 'alpha', { x: 4, y: 4 })
  assert.equal(mine.launch, false)
  assert.equal(mine.shake, 'big')
})

test(`a blast that misses us by ${NEAR_MISS} cells is a near miss: the far boom at full level and a small shake`, () => {
  const near = blastFeedback(blast('bravo', 'torpedo', { x: 5, y: 9 }, {}), 'alpha', { x: 7, y: 7 })
  assert.deepEqual(near, { launch: false, boom: 'far', vol: 1, delay: 0, shake: 'small', flash: false, creak: false })
  const far = blastFeedback(blast('bravo', 'torpedo', { x: 5, y: 9 }, {}), 'alpha', { x: 8, y: 9 })
  assert.equal(far.shake, null)
  assert.equal(far.vol, 0.6)
  const lost = blastFeedback(blast('bravo', 'mine', { x: 5, y: 9 }, {}), 'alpha', null)
  assert.equal(lost.shake, null, 'with our position unknown, a miss is a far one')
})

test('each station answers in its own pitch, and each heading keeps its own move tone', () => {
  assert.deepEqual(Object.keys(AYE_PITCH).sort(), ['engineer', 'first-mate', 'radio-operator'])
  assert.equal(new Set(Object.values(AYE_PITCH)).size, 3)
  assert.ok(AYE_GAP >= 0.25 && AYE_GAP <= 0.5, 'answers that arrive together are spaced about one intercom blip apart')
  assert.deepEqual(MOVE_HZ, { N: 440, S: 330, E: 550, W: 220 })
})
