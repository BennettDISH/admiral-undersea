// The tutorial's words and spotlight (src/game/tutorial.js) against the server's steps, the
// difficulty pick's modes (src/game/rules.js), and what the boat says for the new hunt events.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import serverTutorial from '../../server/game/tutorial.js'
import engine from '../../server/game/engine.js'
import ai from '../../server/game/ai.js'
import { LESSONS, CHAPTERS, lessonCard, spotlight, stationOf, chartFocus } from '../src/game/tutorial.js'
import { STATIONS, AI_LEVELS, isVsAi, isTutorial, aiLevelOf, modeId, HEARING_AT_SPEED, crossing } from '../src/game/rules.js'
import { react, newMemory } from '../src/game/reactions.js'
import { isSoundName } from '../src/lib/soundNames.js'
import { LINES } from '../src/game/voice.js'

const ctx = (over = {}) => ({ team: 'alpha', boat: { x: 5, y: 5 }, now: 1000, memory: newMemory(), ...over })
const tuOf = (step, over = {}) => ({ step, kind: 'read', index: 3, total: serverTutorial.STEPS.length, station: null, ...over })
const VIEW = { boat: { x: 14, y: 10, marker: { x: 5, y: 4 } } }

test('every step the server runs has its words, in one chapter, in the server\'s order', () => {
  assert.deepEqual(Object.keys(LESSONS), serverTutorial.STEPS)
  assert.deepEqual(CHAPTERS.flatMap((c) => c.steps), serverTutorial.STEPS)
  for (const c of CHAPTERS) assert.ok(STATIONS.includes(c.teacher), c.id)
  for (const step of serverTutorial.STEPS) {
    for (const over of [{}, { hitInCharge: true, lastShot: 'hit', pingFound: false, want: { heading: 3 } }]) {
      const card = lessonCard(tuOf(step, over), VIEW)
      assert.ok(card.title && card.text.length > 0, step)
      assert.ok(card.text.every((p) => typeof p === 'string' && p.length < 260), `${step}: short, plain lines`)
    }
  }
})

test('a card says where in the lesson it is, and what to do; the charge and the shot change its words', () => {
  const card = lessonCard(tuOf('helm-turn', { kind: 'do', index: 7 }), VIEW)
  assert.deepEqual([card.chapter, card.place, card.number, card.do], ['The helm', '3 of 5', 8, 'Click ◀ Port to turn left.'])
  assert.match(lessonCard(tuOf('evade-after', { hitInCharge: true }), VIEW).title, /charging/)
  assert.match(lessonCard(tuOf('evade-after', { hitInCharge: false }), VIEW).title, /ran past/)
  assert.equal(lessonCard(tuOf('fire-result', { lastShot: 'hit' }), VIEW).title, 'A hit!')
  assert.equal(lessonCard(tuOf('fire-result', { lastShot: 'miss' }), VIEW).title, 'A miss')
  assert.match(lessonCard(tuOf('cross-turn', { want: { heading: 2 } }), VIEW).do, /Click E on the compass/)
  assert.deepEqual(lessonCard(tuOf('cross-mark'), VIEW).hints, [])
  assert.match(lessonCard(tuOf('cross-mark', { markedWrong: true }), VIEW).hints[0], /Not quite/)
  assert.match(lessonCard(tuOf('helm-way', { kind: 'watch', stalled: true }), VIEW).hints[0], /stopped/)
  assert.equal(lessonCard(tuOf('nope'), VIEW), null)
  assert.equal(lessonCard(null, VIEW), null)
})

test('the spotlight lights the station\'s tab first when another station is on screen, then the control', () => {
  const slow = tuOf('helm-slow', { kind: 'do', station: 'helm' })
  assert.deepEqual(spotlight(slow, VIEW, 'helm'), { key: 'tele-1', tag: 'Slow: quiet. One cell every 2.6 s', station: 'helm', opening: false })
  const opening = spotlight(slow, VIEW, 'listener')
  assert.deepEqual([opening.key, opening.opening], ['tab-helm', true])
  assert.match(opening.tag, /Helm \(key 1\)/)
  // a click on the chart does the station's job, so marking needs Listening on screen
  const mark = tuOf('cross-mark', { kind: 'do', station: 'listener' })
  assert.equal(spotlight(mark, VIEW, 'helm').key, 'tab-listener')
  assert.equal(spotlight(mark, VIEW, 'listener').key, 'chart')
  // a step that only shows the chart needs no station
  assert.equal(spotlight(tuOf('listen-bearing'), VIEW, 'weapons').key, 'chart')
  // a stopped boat on a watch step: light the telegraph instead
  assert.equal(spotlight(tuOf('cross-run', { kind: 'watch', stalled: true }), VIEW, 'helm').key, 'tele-1')
  // the first of a list the page shows
  assert.equal(spotlight(tuOf('load', { kind: 'do', station: 'weapons' }), VIEW, 'weapons', (k) => k === 'load-1').key, 'load-1')
  assert.equal(spotlight(tuOf('evade-decoy', { kind: 'do', station: 'weapons', want: { heading: 6 } }), VIEW, 'weapons').key, 'decoy-6')
  assert.equal(spotlight(tuOf('welcome'), VIEW, 'helm'), null, 'nothing lit on the welcome')
  assert.equal(spotlight(tuOf('hunt', { kind: 'hunt' }), VIEW, 'helm'), null, 'nothing lit in the practice hunt')
  assert.deepEqual(chartFocus(tuOf('charge-aim'), VIEW), VIEW.boat.marker)
  assert.equal(chartFocus(tuOf('charge-full'), VIEW), null)
})

test('every control the lesson lights up is on the page, by its data-tut name', () => {
  const src = ['src/pages/Game.jsx', 'src/game/Stations.jsx', 'src/game/CrewPanel.jsx', 'src/game/ChartCanvas.jsx']
    .map((f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')).join('\n')
  // data-tut="name" and data-tut={`name-${i}`} as patterns
  const names = [...src.matchAll(/data-tut=(?:"([^"]+)"|\{`([^`]+)`\})/g)].map((m) => m[1] || m[2])
  const patterns = names.map((n) => new RegExp(`^${n.replace(/\$\{[^}]+\}/g, '[a-z0-9]+')}$`))
  const onPage = (key) => patterns.some((re) => re.test(key))
  const keys = new Set()
  for (const step of serverTutorial.STEPS) {
    for (const station of [null, ...STATIONS]) {
      for (const over of [{ want: { heading: 0 } }, { want: { heading: 5 }, lastShot: 'hit', stalled: true }]) {
        for (const active of STATIONS) {
          const s = spotlight(tuOf(step, { kind: 'do', station, ...over }), VIEW, active, () => false)
          if (s) keys.add(s.key)
        }
      }
    }
    const raw = LESSONS[step].target
    for (const k of [].concat(typeof raw === 'function' ? [raw({ want: { heading: 7 }, lastShot: 'hit' })] : raw || [])) if (k) keys.add(k)
  }
  for (const key of keys) assert.ok(onPage(key), `${key} is on the page`)
  assert.equal(stationOf('lever-tubes-up'), 'chief')
  assert.equal(stationOf('chart'), null)
})

test('the listening lesson\'s two bearings make one amber cross, within two cells of the training boat', () => {
  const ALL = { helm: 'human', listener: 'human', weapons: 'human', chief: 'human' }
  for (let seed = 1; seed <= 20; seed++) {
    const s = engine.initMatch({ seed, tutorial: true, crew: { alpha: ALL } })
    for (let i = 0; i < 4000 && s.tutorial.step !== 'cross-mark'; i++) {
      const v = engine.teamView(s, 'alpha').tutorial
      if (['helm-slow', 'cross-slow'].includes(v.step)) engine.setSpeed(s, 'alpha', 1)
      else if (['helm-stop', 'cross-stop'].includes(v.step)) engine.setSpeed(s, 'alpha', 0)
      else if (v.step === 'helm-turn') engine.turn(s, 'alpha', -1)
      else if (v.step === 'cross-turn') engine.setHeading(s, 'alpha', v.want.heading)
      else if (v.kind === 'read') engine.tutorialAct(s, 'alpha', 'next')
      engine.tick(s, 0.1, ai)
    }
    assert.equal(s.tutorial.step, 'cross-mark', `seed ${seed}`)
    // the chart's amber crosses, as ChartCanvas finds them
    const lines = s.contacts.alpha.filter((c) => !c.exact && c.kind === 'hull' && s.t - c.t < 25)
    const crosses = []
    for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) { const p = crossing(lines[i], lines[j]); if (p) crosses.push(p) }
    assert.equal(crosses.length, 1, `seed ${seed}: one cross`)
    const b = s.subs.bravo
    const off = Math.max(Math.abs(Math.round(crosses[0].x) - b.x), Math.abs(Math.round(crosses[0].y) - b.y))
    assert.ok(off <= 2, `seed ${seed}: the cross is ${off} cells off`)
  }
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
  for (const ev of [{ type: 'seeker', id: 4, on: 'boat' }, { type: 'seeker', id: 4, on: 'decoy' }, { type: 'torpedo-dud', id: 4 }, { type: 'tutorial', step: 'helm' }, { type: 'helm', heading: 2, speed: 3 }]) {
    const cue = react(ev, ctx())
    for (const [name] of cue.sounds) assert.ok(isSoundName(name), `${ev.type}: ${name}`)
    if (cue.say) assert.ok(LINES[cue.say], `${ev.type}: ${cue.say}`)
    if (cue.then) assert.ok(LINES[cue.then.name], `${ev.type}: ${cue.then.name}`)
  }
  const homing = react({ type: 'seeker', id: 4, on: 'boat' }, ctx())
  assert.deepEqual([homing.say, /homing/.test(homing.log.text)], ['voice.weapons.homing', true])
  const decoyed = react({ type: 'seeker', id: 4, on: 'decoy' }, ctx())
  assert.deepEqual([decoyed.say, /decoy/.test(decoyed.log.text)], ['voice.weapons.decoyed', true])
  assert.equal(react({ type: 'torpedo-dud', id: 4 }, ctx()).say, 'voice.weapons.too-close')
  const memory = newMemory()
  const full = react({ type: 'helm', heading: 2, speed: 3 }, ctx({ memory }))
  assert.deepEqual([full.say, full.then.name], ['voice.helm.full', 'voice.listener.deaf'], 'the helm answers, then the listener complains')
  react({ type: 'helm', heading: 2, speed: 1 }, ctx({ memory, now: 3000 }))
  assert.equal(react({ type: 'helm', heading: 2, speed: 3 }, ctx({ memory, now: 6000 })).then, null, 'not every time')
  assert.equal(react({ type: 'helm', heading: 2, speed: 2 }, ctx()).then, null, 'only at Full')
})

test('every crew line has its recording in the manifest, served from this site', async () => {
  const { readFileSync } = await import('node:fs')
  const manifest = JSON.parse(readFileSync(new URL('../public/audio/manifest.json', import.meta.url), 'utf8'))
  for (const name of Object.keys(LINES)) {
    const entry = manifest.sounds[name]
    assert.ok(entry, `${name} is in the manifest`)
    const src = [].concat(entry.src)[0]
    assert.match(src, /^\/audio\/voice\/[a-z0-9-]+\.mp3$/, name)
    assert.ok(readFileSync(new URL(`../public${src}`, import.meta.url)).length > 1000, `${name} has a recording`)
  }
})
