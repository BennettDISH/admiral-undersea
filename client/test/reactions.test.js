// What a player hears, sees and reads for each thing the server says happened (src/game/reactions.js),
// and the client's copy of the rules (src/game/rules.js).
import test from 'node:test'
import assert from 'node:assert/strict'
import { react, ending, newMemory } from '../src/game/reactions.js'
import { chart, shotProblem, cellsAlong, cellName, clockText, canStep, bearing, headingFor, loadSeconds, crossing } from '../src/game/rules.js'
import { isSoundName } from '../src/lib/soundNames.js'
import { LINES } from '../src/game/voice.js'

const ctx = (over = {}) => ({ team: 'alpha', boat: { x: 5, y: 5 }, now: 1000, memory: newMemory(), ...over })
const contact = (kind, extra = {}) => ({ type: 'contact', contact: { id: 1, t: 10, kind, bearing: 90, width: 12, ox: 5, oy: 5, ...extra } })

test('every sound and line a reaction asks for is one the boat knows', () => {
  const events = [
    contact('hull'), contact('bio'), contact('launch'), contact('torpedo', { ref: 3 }), contact('ping', { exact: true, x: 1, y: 1 }),
    { type: 'ping-result', ping: { t: 1, x: 5, y: 5, radius: 6, found: [{ kind: 'boat', x: 6, y: 6 }] } },
    { type: 'ping-result', ping: { t: 1, x: 5, y: 5, radius: 6, found: [] } },
    { type: 'fired', tube: 0, tx: 8, ty: 5 }, { type: 'tube-loaded', tube: 1 }, { type: 'decoy-out' }, { type: 'torpedo-spent' },
    { type: 'blast', x: 9, y: 5 }, { type: 'hit', team: 'alpha', damage: 2, hull: 3, cause: 'torpedo' }, { type: 'hit', team: 'bravo', damage: 1, hull: 4, cause: 'torpedo' },
    { type: 'hit', team: 'alpha', damage: 1, hull: 2, cause: 'rock' }, { type: 'hit', team: 'alpha', damage: 1, hull: 1, cause: 'flood' },
    ...['fire', 'flood', 'sonar', 'rudder'].map((kind) => ({ type: 'fault', kind })),
    { type: 'repaired', kind: 'fire' }, { type: 'scram' }, { type: 'power-up' }, { type: 'heat-warning' }, { type: 'vented' },
    { type: 'rocks-ahead' }, { type: 'collision', damage: 1 }, { type: 'helm', heading: 2, speed: 3 }, { type: 'marker', marker: { x: 1, y: 1 } },
    ...['power-engines', 'evade', 'hold-fire'].map((call) => ({ type: 'call', station: 'helm', call })),
    { type: 'clock', left: 120 }, { type: 'sunk', team: 'bravo' },
  ]
  for (const ev of events) {
    const cue = react(ev, ctx())
    for (const [name] of cue.sounds) assert.ok(isSoundName(name), `${ev.type}: ${name}`)
    if (cue.say) assert.ok(LINES[cue.say], `${ev.type}: ${cue.say}`)
  }
})

test('a torpedo in the water: the klaxon, the listener calls it once per torpedo, and the alarm lights', () => {
  const memory = newMemory()
  const first = react(contact('torpedo', { ref: 7 }), ctx({ memory }))
  assert.equal(first.say, 'voice.listener.torpedo')
  assert.ok(first.sounds.some(([n]) => n === 'klaxon'))
  assert.ok(first.alarm > 0)
  assert.equal(first.tension, 1)
  const again = react(contact('torpedo', { ref: 7 }), ctx({ memory, now: 1600 }))
  assert.equal(again.say, null, 'the same torpedo is not called twice')
  assert.equal(react(contact('torpedo', { ref: 8 }), ctx({ memory, now: 1700 })).say, 'voice.listener.torpedo', 'a second torpedo is')
})

test('a hit on us shakes and flashes the room; a hit on them is the torpedo room cheering', () => {
  const us = react({ type: 'hit', team: 'alpha', damage: 2, hull: 3, cause: 'torpedo' }, ctx())
  assert.deepEqual([us.shake, us.flash, us.say], ['big', true, 'voice.deck.hit-us'])
  const them = react({ type: 'hit', team: 'bravo', damage: 2, hull: 3, cause: 'torpedo' }, ctx())
  assert.deepEqual([them.shake, them.flash, them.say], [null, false, 'voice.weapons.hit'])
})

test('a blast far off is a far boom that arrives late; one on top of us is left to the hit', () => {
  const far = react({ type: 'blast', x: 15, y: 5 }, ctx())
  const boom = far.sounds.find(([n]) => n === 'far')
  assert.ok(boom[1].delay > 0.5)
  assert.equal(far.visual.kind, 'blast')
  const close = react({ type: 'blast', x: 5, y: 6 }, ctx())
  assert.equal(close.sounds.length, 0)
})

test('the helm calls a new speed once, and repeated contacts do not chatter', () => {
  const memory = newMemory()
  assert.equal(react({ type: 'helm', heading: 2, speed: 3 }, ctx({ memory })).say, 'voice.helm.full')
  assert.equal(react({ type: 'helm', heading: 3, speed: 3 }, ctx({ memory, now: 5000 })).say, null, 'a turn at the same speed says nothing')
  assert.equal(react(contact('hull'), ctx({ memory })).say, 'voice.listener.contact')
  assert.equal(react(contact('hull'), ctx({ memory, now: 9000 })).say, null)
})

test('the end: a win, a loss and a draw each have their title, sting and last word', () => {
  assert.deepEqual([ending('alpha', 'alpha').title, ending('alpha', 'alpha').sound], ['Victory', 'sting.win'])
  assert.deepEqual([ending('bravo', 'alpha').title, ending('bravo', 'alpha').say], ['Sunk', 'voice.deck.lose'])
  assert.equal(ending(null, 'alpha').title, 'Stalemate')
})

test('the client rules agree with the chart: steps, shots, names and the clock', () => {
  const map = chart('black-shelf')
  assert.equal(map.isRock(2, 1), true)
  assert.equal(map.isVent(1, 4), true)
  assert.equal(canStep(map, { x: 1, y: 1 }, 1), false, 'no cutting a rock corner')
  assert.equal(shotProblem(map, { x: 2, y: 11 }, { x: 8, y: 11 }), null)
  assert.match(shotProblem(map, { x: 3, y: 6 }, { x: 9, y: 6 }), /Rock/)
  assert.match(shotProblem(map, { x: 0, y: 11 }, { x: 15, y: 0 }), /range/)
  assert.match(shotProblem(map, { x: 2, y: 11 }, { x: 3, y: 11 }), /close/)
  assert.deepEqual(cellsAlong({ x: 0, y: 0 }, { x: 2, y: 0 }), [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }])
  assert.equal(cellName(3, 4), 'D5')
  assert.equal(clockText(600), '10:00')
  assert.equal(clockText(59.2), '1:00')
  assert.equal(headingFor(bearing({ x: 5, y: 5 }, { x: 8, y: 2 })), 1)
  assert.equal(loadSeconds(0), Infinity)
  assert.equal(loadSeconds(2, 2), loadSeconds(1))
})

test('two bearings from two spots cross on the boat they both heard; parallel or same-spot ones do not', () => {
  const at = { x: 10, y: 4 }
  const from = (ox, oy) => ({ ox, oy, bearing: bearing({ x: ox, y: oy }, at) })
  const p = crossing(from(2, 4), from(6, 10))
  assert.ok(Math.abs(p.x - 10) < 1e-6 && Math.abs(p.y - 4) < 1e-6)
  assert.equal(crossing(from(2, 4), from(2.5, 4.5)), null, 'too close together to fix anything')
  assert.equal(crossing({ ox: 0, oy: 0, bearing: 90 }, { ox: 0, oy: 3, bearing: 90 }), null, 'parallel')
  assert.equal(crossing({ ox: 0, oy: 0, bearing: 90 }, { ox: 5, oy: 5, bearing: 180 }), null, 'they would only meet behind one of them')
})
