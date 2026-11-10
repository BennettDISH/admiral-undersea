// The tutorial's cards (src/game/tutorial.js) against the server's lessons, the difficulty pick's
// modes (src/game/rules.js), and what the boat says for the new hunt events (seekers, duds, Full).
import test from 'node:test'
import assert from 'node:assert/strict'
import serverTutorial from '../../server/game/tutorial.js'
import { LESSONS, lessonCard, decoyHeading } from '../src/game/tutorial.js'
import { STATIONS, AI_LEVELS, isVsAi, isTutorial, aiLevelOf, modeId, HEARING_AT_SPEED } from '../src/game/rules.js'
import { react, newMemory } from '../src/game/reactions.js'
import { isSoundName } from '../src/lib/soundNames.js'
import { LINES } from '../src/game/voice.js'

const ctx = (over = {}) => ({ team: 'alpha', boat: { x: 5, y: 5 }, now: 1000, memory: newMemory(), ...over })

test('every lesson the server runs has a card, taught by one of the four stations', () => {
  assert.deepEqual(Object.keys(LESSONS), serverTutorial.STEPS)
  for (const [step, l] of Object.entries(LESSONS)) {
    assert.ok(STATIONS.includes(l.station), step)
    assert.ok(l.title && l.text.length > 0, step)
  }
})

test('a card earns its hint with time on the lesson or a miss, and its first line says how the charge went', () => {
  const tu = (over) => ({ step: 'cross', index: 3, total: 9, since: 10, misses: 0, hitInCharge: null, ...over })
  assert.deepEqual(lessonCard(tu(), 20).hints, [])
  assert.equal(lessonCard(tu(), 70).hints.length, 1, 'stuck a while: the ping hint')
  assert.equal(lessonCard(tu({ step: 'torpedo' }), 11).hints.length, 0)
  assert.match(lessonCard(tu({ step: 'torpedo', misses: 1 }), 11).hints[0], /miss/i)
  assert.match(lessonCard(tu({ step: 'torpedo', hitInCharge: true }), 11).lead, /charging/)
  assert.match(lessonCard(tu({ step: 'torpedo', hitInCharge: false }), 11).lead, /Quiet/)
  assert.deepEqual([lessonCard(tu(), 0).number, lessonCard(tu(), 0).total], [4, 9])
  assert.equal(lessonCard({ step: 'nope' }, 0), null)
  assert.equal(lessonCard(null, 0), null)
})

test('the decoy button throws at the newest torpedo heard, else straight ahead', () => {
  const contacts = [
    { kind: 'launch', bearing: 270, t: 1 },
    { kind: 'hull', bearing: 0, t: 2 },
    { kind: 'torpedo', bearing: 92, t: 3 },
  ]
  assert.equal(decoyHeading(contacts, { heading: 4 }), 2)
  assert.equal(decoyHeading([{ kind: 'hull', bearing: 10 }], { heading: 4 }), 4)
  assert.equal(decoyHeading([], { heading: 6 }), 6)
})

test('the deck\'s modes: the tutorial and the three crews are played against one boat; old names keep working', () => {
  assert.deepEqual(AI_LEVELS.map((l) => l.mode), ['vs-ai-easy', 'vs-ai-normal', 'vs-ai-hard'])
  for (const m of ['tutorial', 'vs-ai-easy', 'vs-ai-normal', 'vs-ai-hard', 'vs-ai', 'vs-ai-veteran']) assert.equal(isVsAi(m), true, m)
  for (const m of ['crews', 'live', 'vs-ai-insane', 'constructor', undefined]) assert.equal(isVsAi(m), false, String(m))
  assert.equal(isTutorial('tutorial'), true)
  assert.equal(aiLevelOf('vs-ai').name, 'Easy')
  assert.equal(aiLevelOf('vs-ai-veteran').name, 'Hard')
  assert.equal(aiLevelOf('crews'), null)
  assert.equal(modeId('constructor'), 'constructor', 'no names borrowed from Object')
  assert.ok(HEARING_AT_SPEED[3] < HEARING_AT_SPEED[1] / 2, 'Full is nearly deaf')
})

test('the new hunt events: our seeker homing, a dud, and the listener going deaf at Full (once in a while)', () => {
  for (const ev of [{ type: 'seeker', id: 4, on: 'boat' }, { type: 'seeker', id: 4, on: 'decoy' }, { type: 'torpedo-dud', id: 4 }, { type: 'tutorial', step: 'helm' }]) {
    const cue = react(ev, ctx())
    for (const [name] of cue.sounds) assert.ok(isSoundName(name), `${ev.type}: ${name}`)
    if (cue.say) assert.ok(LINES[cue.say], `${ev.type}: ${cue.say}`)
  }
  assert.match(react({ type: 'seeker', id: 4, on: 'boat' }, ctx()).log.text, /homing/)
  assert.match(react({ type: 'seeker', id: 4, on: 'decoy' }, ctx()).log.text, /decoy/)
  const memory = newMemory()
  const full = react({ type: 'helm', heading: 2, speed: 3 }, ctx({ memory }))
  assert.deepEqual([full.say, full.caption.station], ['voice.helm.full', 'listener'])
  react({ type: 'helm', heading: 2, speed: 1 }, ctx({ memory, now: 3000 }))
  assert.equal(react({ type: 'helm', heading: 2, speed: 3 }, ctx({ memory, now: 6000 })).caption, null, 'not every time')
  assert.equal(react({ type: 'helm', heading: 2, speed: 2 }, ctx()).caption, null, 'only at Full')
})
