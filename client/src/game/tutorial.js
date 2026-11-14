// The tutorial's words, and the control each step lights up, keyed by the server's step
// (server/game/tutorial.js runs the steps, stops the clock, drives the training boat and moves the
// player on). Pure: the coach (TutorialCoach.jsx) shows lessonCard() for the view's step and puts
// its spotlight on spotlight()'s control, found on the page by its data-tut name.
import { HEADINGS, HEADING_NAMES, STATION_INFO, cellName } from './rules.js'

// The chapters, in order, and who on the crew teaches each one.
export const CHAPTERS = [
  { id: 'start', name: 'Getting started', teacher: 'helm', steps: ['welcome', 'chart', 'stations', 'crew', 'hulls'] },
  { id: 'helm', name: 'The helm', teacher: 'helm', steps: ['helm-slow', 'helm-way', 'helm-turn', 'helm-compass', 'helm-stop'] },
  { id: 'listen', name: 'Listening', teacher: 'listener', steps: ['listen-wait', 'listen-bearing', 'listen-list', 'cross-turn', 'cross-slow', 'cross-run', 'cross-stop', 'cross-listen', 'cross-mark'] },
  { id: 'charge', name: 'Why not charge?', teacher: 'helm', steps: ['charge-aim', 'charge-full', 'charge-run', 'evade-slow', 'evade-decoy', 'evade-watch', 'evade-after'] },
  { id: 'torpedo', name: 'The torpedo room', teacher: 'weapons', steps: ['ping', 'ping-mark', 'load', 'load-wait', 'aim', 'fire', 'fire-watch', 'fire-result'] },
  { id: 'engine', name: 'The engine room', teacher: 'chief', steps: ['engine-fire', 'engine-repair', 'engine-reactor', 'engine-tubes', 'engine-balance', 'engine-vent', 'calls'] },
  { id: 'hunt', name: 'Practice hunt', teacher: 'helm', steps: ['hunt'] },
]

const heading = (tu) => (Number.isInteger(tu?.want?.heading) ? tu.want.heading : 0)
const here = (view) => (view?.boat ? cellName(view.boat.x, view.boat.y) : 'our cell')

// Each step: its title, a line or two of what is going on, the one thing to do (do steps), the
// control to light up (target: a data-tut name, or a list to try in order) and the short label next
// to it saying what that control does (tag). `stuck` is what to say and light up instead while a
// watch step cannot go on (the boat has stopped).
export const LESSONS = {
  welcome: {
    title: 'Welcome aboard the Marlin',
    text: [
      'This lesson stops the clock at every step, so take your time.',
      'Each step lights up one control and says what it does. Use it, or press Next when there is nothing to click.',
      'Back goes one step back. Leave tutorial takes you to the deck.',
    ],
  },
  chart: {
    title: 'The chart',
    text: (_, view) => [
      `This is the sea from above. Our boat is the blue one in the ring, at ${here(view)}.`,
      'A training boat is hiding out there. You will never see it on the chart: you have to hear it.',
    ],
    target: 'chart',
    tag: 'The chart: our boat, and everything we hear',
  },
  stations: {
    title: 'Four stations',
    text: [
      'You run all four: the Helm, Listening, Torpedoes and the Engine Room. These tabs switch between them (keys 1 to 4).',
      'In a real hunt the auto-crew runs the stations you are not looking at. In this lesson they wait for you.',
    ],
    target: 'tabs',
    tag: 'Station tabs: keys 1 to 4',
  },
  crew: {
    title: 'Your crew',
    text: [
      'One face for each station. A face talks when that station calls out, and a yellow light means it needs a hand.',
      'You can also click a face to go to its station.',
    ],
    target: 'crew',
    tag: 'The crew: who is calling out',
  },
  hulls: {
    title: 'Hull',
    text: [
      'Up here, our hull on the left: five hits and we sink. The training boat\'s hull is on the right.',
      'Put it on the bottom to finish the lesson.',
    ],
    target: 'header',
    tag: 'Our hull, and the training boat\'s',
  },

  'helm-slow': {
    title: 'The telegraph sets our speed',
    text: ['Four speeds: All stop, Slow, Half and Full. The faster we go, the louder we are.'],
    do: 'Click Slow.',
    target: 'tele-1',
    tag: 'Slow: quiet. One cell every 2.6 s',
  },
  'helm-way': {
    title: 'Making way',
    text: ['The clock runs now. Watch our boat move one cell.'],
    target: 'chart',
    tag: 'Our boat, making way',
    stuck: { text: 'We have stopped. Click Slow to get going again.', target: 'tele-1', tag: 'Slow: get going again' },
  },
  'helm-turn': {
    title: 'Turning',
    text: ['The wheel turns us 45° at a time.'],
    do: 'Click ◀ Port to turn left.',
    target: 'turn-port',
    tag: 'Port: turn left 45° (Stbd turns right; keys ← →)',
  },
  'helm-compass': {
    title: 'The compass',
    text: [
      'You can also click a point on the compass to steer straight to it. A red point means rock or the edge of the chart that way.',
      'With the Helm on screen, clicking the chart steers toward the cell you click.',
    ],
    target: 'compass',
    tag: 'Compass: click a point to steer that way',
  },
  'helm-stop': {
    title: 'All stop',
    text: ['A stopped boat is silent and hears best.'],
    do: 'Click All stop.',
    target: 'tele-0',
    tag: 'All stop: silent, and hears best',
  },

  'listen-wait': {
    title: 'Listen',
    text: ['We are stopped and listening. The clock runs until the hydrophones hear the training boat.'],
    target: 'chart',
    tag: 'Bearings show up here',
  },
  'listen-bearing': {
    title: 'A bearing',
    text: [
      'That line is a bearing: the training boat\'s engines, heard from where we were. It points at the noise.',
      'The wedge around it shows how sure we are: the louder the noise, the narrower the wedge.',
    ],
    target: 'chart',
    tag: 'A bearing: the direction of a noise',
  },
  'listen-list': {
    title: 'The Listening Post',
    text: [
      'Every sound we hear is listed here: what it was, its bearing, and how long ago.',
      'Machinery is a boat. Biologic is a whale. The scope above shows the same bearings round our boat.',
    ],
    target: 'contacts',
    tag: 'What we heard, newest first',
  },
  'cross-turn': {
    title: 'How far away is it?',
    text: ['One bearing gives a direction, not a distance. To find the distance, move across the line and listen again.'],
    do: (tu) => `Click ${HEADINGS[heading(tu)]} on the compass.`,
    target: (tu) => `compass-${heading(tu)}`,
    tag: (tu) => `${HEADING_NAMES[heading(tu)]}: across the bearing`,
  },
  'cross-slow': {
    title: 'Slow ahead',
    text: ['Slow is quiet: the training boat will not hear us.'],
    do: 'Click Slow.',
    target: 'tele-1',
    tag: 'Slow: quiet',
  },
  'cross-run': {
    title: 'Crossing the line',
    text: ['Watch: three cells across the bearing.'],
    target: 'chart',
    tag: 'Our boat, crossing the line',
    stuck: { text: 'We have stopped. Click Slow to get going again.', target: 'tele-1', tag: 'Slow: get going again' },
  },
  'cross-stop': {
    title: 'Stop and listen',
    text: ['Stop again to hear it from here.'],
    do: 'Click All stop.',
    target: 'tele-0',
    tag: 'All stop: hears best',
  },
  'cross-listen': {
    title: 'Listening again',
    text: ['Wait for a new bearing from where we are now.'],
    target: 'chart',
    tag: 'The new bearing shows up here',
  },
  'cross-mark': {
    title: 'Where the lines cross',
    text: ['Where two bearings cross (a small amber ×) is the training boat. With Listening on screen, a click on the chart puts the target mark there.'],
    do: 'Click the chart on the amber ×.',
    target: 'chart',
    tag: 'Click where the lines cross',
    hint: (tu) => (tu.markedWrong ? 'Not quite: the mark has to sit within two cells of it. Click right on the ×.' : null),
  },

  'charge-aim': {
    title: 'Why not just charge?',
    text: ['We know where it is. Why not charge straight at it? Let\'s try.'],
    do: 'Click the mark on the chart: the helm turns toward any cell you click.',
    target: 'chart',
    tag: 'Click the mark to steer at it',
  },
  'charge-full': {
    title: 'Full ahead',
    text: ['Full is the fastest we go.'],
    do: 'Click Full.',
    target: 'tele-3',
    tag: 'Full: fast, LOUD, and nearly deaf',
  },
  'charge-run': {
    title: 'Charging',
    text: ['Full speed ahead. Watch the chart.'],
    target: 'chart',
    tag: 'Charging at Full',
    stuck: { text: 'We have slowed down. Click Full to carry on the charge.', target: 'tele-3', tag: 'Full: carry on' },
  },
  'evade-slow': {
    title: 'Torpedo in the water!',
    text: [
      'They heard us coming. At Full we are the loudest thing in the sea, and nearly deaf. The red dot on the chart is their torpedo.',
      'A torpedo\'s seeker hears loud boats.',
    ],
    do: 'Click Slow, so it cannot hear us.',
    target: 'tele-1',
    tag: 'Slow: too quiet for its seeker',
  },
  'evade-decoy': {
    title: 'Throw a decoy',
    text: ['A decoy sounds like a boat at Full for 8 seconds, and a seeker goes for a decoy first.'],
    do: (tu) => `Click ${HEADINGS[heading(tu)]} to throw one toward the torpedo.`,
    target: (tu) => `decoy-${heading(tu)}`,
    tag: (tu) => `Decoy ${HEADINGS[heading(tu)]}: toward the torpedo`,
  },
  'evade-watch': {
    title: 'Hold steady',
    text: ['Watch the torpedo go by.'],
    target: 'chart',
    tag: 'Their torpedo is the red dot',
  },
  'evade-after': {
    title: (tu) => (tu.hitInCharge ? 'That hit is what charging gets you' : 'It ran past us'),
    text: (tu) => [
      tu.hitInCharge ? 'Back at Full, its seeker heard us. They hear you long before you hear them.' : 'Quiet boats live longer. They hear a loud boat long before it hears them.',
      'Now we hunt the careful way. Stop first.',
    ],
    do: 'Click All stop.',
    target: 'tele-0',
    tag: 'All stop',
  },

  ping: {
    title: 'Ping',
    text: [
      'The training boat is close now. A ping shows everything within 6 cells, exactly.',
      'But it also tells them exactly where we are, so save it for when you need it.',
    ],
    do: 'Click PING.',
    target: 'ping',
    tag: 'Ping: exact, but it gives us away',
  },
  'ping-mark': {
    title: 'Mark it exactly',
    text: (tu) => [tu.pingFound === false
      ? 'The ping found nothing within 6 cells. Mark where the bearings cross instead.'
      : 'There it is: the red diamond marked ENEMY. Move our mark onto it.'],
    do: (tu) => (tu.pingFound === false ? 'Click the chart where the lines cross.' : 'Click the red diamond on the chart.'),
    target: 'chart',
    tag: 'Click it to mark it',
    hint: (tu) => (tu.markedWrong ? 'Not quite: click right on the red diamond.' : null),
  },
  load: {
    title: 'Load a tube',
    text: ['Two tubes, one torpedo in each. At 2 power a tube takes about 12 seconds to load.'],
    do: 'Click Load.',
    target: ['load-0', 'load-1'],
    tag: 'Load: a torpedo into this tube',
  },
  'load-wait': {
    title: 'Loading',
    text: ['The clock runs until the tube is loaded. More power on the tubes loads faster: that is the engine room\'s job, later.'],
    target: 'tubes',
    tag: 'Loading',
  },
  aim: {
    title: 'Aim',
    text: [
      'A torpedo runs to the mark, or to any cell you click on the chart with the Torpedo Room on screen. This line says what we are aiming at, and whether the shot is clear.',
      'It arms after 3 cells (closer, it cannot hurt them), and its blast reaches the cells around where it goes off.',
    ],
    target: 'aim',
    tag: 'The target, and whether the shot is clear',
  },
  fire: {
    title: 'Fire!',
    text: ['The shot is on the mark.'],
    do: 'Click Fire.',
    target: ['fire-0', 'fire-1'],
    tag: 'Fire: the torpedo runs to the target',
  },
  'fire-watch': {
    title: 'Torpedo running',
    text: ['Watch it run. You can steer a running torpedo: click it here, then click the chart where it should go.'],
    target: ['running', 'chart'],
    tag: 'Our torpedo: click to steer it',
  },
  'fire-result': {
    title: (tu) => (tu.lastShot === 'hit' ? 'A hit!' : 'A miss'),
    text: (tu) => (tu.lastShot === 'hit'
      ? ['The training boat is hurt: look at its hull. One more lesson, the engine room, then you finish it.']
      : ['A torpedo has to go off on the boat or right next to it. Check the mark, then load and fire again.']),
    target: (tu) => (tu.lastShot === 'hit' ? 'hull-theirs' : null),
    tag: 'The training boat\'s hull',
  },

  'engine-fire': {
    title: 'Fire in the engine room!',
    text: ['Things break when we are hit, or run too hard. A fire slows the engines and heats the reactor.'],
    do: 'Click Repair.',
    target: 'repair-fire',
    tag: 'Repair: 4 s with you on it',
  },
  'engine-repair': {
    title: 'Repairing',
    text: ['The clock runs while the crew puts the fire out.'],
    target: 'faults',
    tag: 'Damage control',
  },
  'engine-reactor': {
    title: 'The reactor',
    text: [
      'The reactor gives 6 power without heating up. Up to 9 is overdrive: it heats up, and at 100° it scrams and the whole boat goes dead for 8 seconds.',
    ],
    target: 'reactor',
    tag: 'Power in use, out of 9',
  },
  'engine-tubes': {
    title: 'Sharing the power',
    text: ['Engines give speed, Sonar gives hearing and pings, Tubes load torpedoes. Each takes 0 to 4.'],
    do: 'Click ▲ on Tubes.',
    target: 'lever-tubes-up',
    tag: 'More power to the tubes: faster loading',
  },
  'engine-balance': {
    title: 'Back to 6',
    text: ['That makes 7: overdrive, and the reactor heats up.'],
    do: 'Click ▼ on Engines to take one off.',
    target: 'lever-engines-down',
    tag: 'Less power to the engines',
  },
  'engine-vent': {
    title: 'Vent',
    text: ['Venting cools a hot reactor fast, but the steam is heard. Use it when the heat climbs.'],
    target: 'vent',
    tag: 'Vent: cools fast, but it is loud',
  },
  calls: {
    title: 'Crew calls',
    text: [
      'In a real hunt the auto-crew runs every station you are not looking at. These calls give it orders: more power to something, go quiet, hold fire.',
    ],
    target: 'calls',
    tag: 'Orders for the rest of the crew',
  },

  hunt: {
    title: 'Practice hunt',
    text: [
      'The training boat has slipped away and is creeping about. Find it and sink it with what you have learned. The clock runs from here.',
    ],
    list: [
      'Stop and listen for a bearing.',
      'Move across it at Slow, stop, listen again.',
      'Mark where the lines cross.',
      'Load, and fire from 3 cells or more.',
    ],
  },
}

const call = (v, tu, view) => (typeof v === 'function' ? v(tu, view) : v)

/** A station's room as said in a sentence: "the Listening Post", "The Helm" stays "the Helm". */
export const roomName = (station) => {
  const room = STATION_INFO[station]?.room || ''
  return room.startsWith('The ') ? `the ${room.slice(4)}` : `the ${room}`
}

/** The chapter a step is in, and where in it. */
export function chapterOf(step) {
  const i = CHAPTERS.findIndex((c) => c.steps.includes(step))
  if (i < 0) return null
  const c = CHAPTERS[i]
  return { ...c, number: i + 1, step: c.steps.indexOf(step) + 1, of: c.steps.length }
}

/** The card for a view's step: its words, the one thing to do, and any hint earned. */
export function lessonCard(tu, view) {
  const lesson = tu && LESSONS[tu.step]
  const chapter = tu && chapterOf(tu.step)
  if (!lesson || !chapter) return null
  const hints = []
  const hint = call(lesson.hint, tu, view)
  if (hint) hints.push(hint)
  if (tu.stalled && lesson.stuck) hints.push(lesson.stuck.text)
  return {
    step: tu.step,
    kind: tu.kind,
    title: call(lesson.title, tu, view),
    text: call(lesson.text, tu, view) || [],
    do: call(lesson.do, tu, view) || null,
    list: lesson.list || null,
    hints,
    chapter: chapter.name,
    chapterNumber: chapter.number,
    chapters: CHAPTERS.length,
    place: `${chapter.step} of ${chapter.of}`,
    teacher: tu.station || chapter.teacher,
    number: (tu.index ?? 0) + 1,
    total: tu.total,
  }
}

// Which station's screen each control is on (the rest are always on screen).
const ON_STATION = [
  [/^(tele-|turn-|compass)/, 'helm'],
  [/^(ping|contacts|scope)/, 'listener'],
  [/^(load-|fire-|tubes|aim|running|decoy)/, 'weapons'],
  [/^(repair-|faults|reactor|lever-|vent|heat)/, 'chief'],
]
export const stationOf = (key) => ON_STATION.find(([re]) => re.test(key || ''))?.[1] || null

/**
 * The control to light up now: { key (its data-tut name), tag, station, opening }. When the
 * control is on a station that is not on screen, that station's tab instead (opening), with a tag
 * saying so. `active` is the station on screen; `has(key)` says whether the page shows that control.
 */
export function spotlight(tu, view, active, has = () => true) {
  const lesson = tu && LESSONS[tu.step]
  if (!lesson) return null
  const stuck = tu.stalled && lesson.stuck
  const raw = stuck ? lesson.stuck.target : call(lesson.target, tu, view)
  if (!raw) return null
  const keys = [].concat(raw)
  const tag = stuck ? lesson.stuck.tag : call(lesson.tag, tu, view)
  // a chart click does the station's job (mark, aim, steer), so a do step on the chart needs its station
  const needs = stationOf(keys[0]) || (keys[0] === 'chart' && tu.kind === 'do' ? tu.station : null)
  if (needs && needs !== active) {
    const info = STATION_INFO[needs]
    return { key: `tab-${needs}`, tag: `First open ${roomName(needs)} (key ${info.key})`, station: needs, opening: true }
  }
  return { key: keys.find((k) => has(k)) || keys[0], tag, station: needs, opening: false }
}

/** A cell on the chart the step points at (the mark, for the charge), or null. */
export function chartFocus(tu, view) {
  if (tu?.step === 'charge-aim' && view?.boat?.marker) return view.boat.marker
  return null
}
