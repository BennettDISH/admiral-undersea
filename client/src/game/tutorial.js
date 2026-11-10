// The tutorial's words, one card per lesson, keyed by the server's step (server/game/tutorial.js
// runs the lessons, drives the training boat and moves the player on). Pure: the Game page shows
// the card for view.tutorial.step, with the face of the station that teaches it.
import { headingFor } from './rules.js'

export const LESSONS = {
  welcome: {
    station: 'helm',
    title: 'Welcome aboard the Marlin',
    text: [
      'Somewhere on this chart is a training boat. You will never see it: you have to hear it.',
      'You hold all four stations. We take them one at a time; the tabs on the left (keys 1 to 4) switch between them.',
    ],
  },
  helm: {
    station: 'helm',
    title: 'The helm',
    text: [
      'Ring for Slow ahead (↑, or the telegraph), and steer with the wheel or by clicking the chart.',
      'The faster we go, the louder we are. Slow is quiet; Full is heard across the sea.',
    ],
    goal: 'Make two cells of way.',
  },
  listen: {
    station: 'listener',
    title: 'Listening',
    text: [
      'Ring for All stop and listen: a stopped boat hears best.',
      'When the training boat moves, its machinery comes in as a bearing: a line on the chart from where we were. The louder it is, the sharper the line.',
    ],
    goal: 'Stop, and hear the training boat.',
    actions: ['stop'],
  },
  cross: {
    station: 'listener',
    title: 'Where the lines cross',
    text: [
      'One bearing gives a direction, not a distance. Move four or five cells across the line at Slow, stop, and listen again.',
      'Where bearings from two places cross (a small amber ×) is the boat. Click the chart there to mark it.',
    ],
    goal: 'Mark the training boat, within two cells.',
    hint: { after: 50, text: 'Stuck? Ping (P): it finds everything within 6 cells exactly, but tells them exactly where we are.' },
  },
  charge: {
    station: 'helm',
    title: 'Why not just charge?',
    text: [
      'You know where it is. Try it: ring for Full and head for the mark (the helm calls out rocks; at Full they hurt).',
      'Keep an eye on the bearings while you go.',
    ],
    goal: 'Ring for Full ahead.',
  },
  evade: {
    station: 'weapons',
    title: 'Torpedo in the water!',
    text: [
      'They heard us coming. At Full our own flow noise leaves us nearly deaf, and we were the loudest thing in the sea.',
      'A torpedo\'s seeker hears loud boats. Drop to Slow so it cannot hear us, and throw a decoy toward it: a seeker goes for a decoy first.',
    ],
    goal: 'Live through the practice torpedo.',
    actions: ['slow', 'decoy'],
  },
  torpedo: {
    station: 'weapons',
    title: 'The torpedo room',
    lead: (tu) => (tu.hitInCharge ? 'That hit is what charging gets you: they hear you long before you hear them.' : 'It ran past us. Quiet boats live longer.'),
    text: [
      'Our turn. Load a tube (L), and when it is loaded fire on the mark (F), or click the chart to aim.',
      'A torpedo only arms after 3 cells, so fire from farther off. Its blast reaches the cells around where it goes off.',
    ],
    goal: 'Hit the training boat.',
    missHint: 'A miss. Check the line on the chart: green is a clear shot, red means rock in the way. Move the mark, or ping to be sure.',
  },
  engine: {
    station: 'chief',
    title: 'The engine room',
    text: [
      'Something shook loose: a fire. Click Repair on it; a person mends faster than the auto-crew.',
      'The reactor gives 6 without heating up. Put 3 on the tubes so they load faster, and take one off engines or sonar to stay at 6.',
    ],
    goal: 'Mend every fault, tubes on 3 or more, 6 in all.',
  },
  finish: {
    station: 'weapons',
    title: 'Finish it',
    text: ['Load, aim and fire. Put the training boat on the bottom.'],
    goal: 'Sink the training boat.',
  },
}

/** The card for a view's lesson: its words, plus the hint that time on the step or a miss has earned. */
export function lessonCard(tu, t) {
  const lesson = tu && LESSONS[tu.step]
  if (!lesson) return null
  const onStep = t - (tu.since ?? 0)
  const hints = []
  if (lesson.hint && onStep >= lesson.hint.after) hints.push(lesson.hint.text)
  if (lesson.missHint && tu.misses > 0) hints.push(lesson.missHint)
  return {
    ...lesson,
    lead: typeof lesson.lead === 'function' ? lesson.lead(tu) : lesson.lead || null,
    hints,
    number: tu.index + 1,
    total: tu.total,
  }
}

/** Which way to throw a decoy: at the newest torpedo or launch we heard, else straight ahead. */
export function decoyHeading(contacts, boat) {
  const threat = [...(contacts || [])].reverse().find((c) => (c.kind === 'torpedo' || c.kind === 'launch') && typeof c.bearing === 'number')
  return threat ? headingFor(threat.bearing) : boat.heading
}
