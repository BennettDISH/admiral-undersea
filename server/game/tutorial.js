// The tutorial: a guided first dive against a training boat, one station at a time, ending on
// why charging in loses. Pure, like the engine: it places the boats, drives the training boat
// (bravo), checks each lesson's goal and moves the player on. The engine calls tick() every tick
// and act() when the player presses Next or Skip; the words for each step are the client's
// (client/src/game/tutorial.js), keyed by the step's id.
const { dist, chebyshev, bearing, headingFor, stepFrom, routeTo } = require('./map');
const { POWER } = require('./constants');

const STEPS = ['welcome', 'helm', 'listen', 'cross', 'charge', 'evade', 'torpedo', 'engine', 'finish'];
const READ_STEPS = new Set(['welcome']); // moved on from with Next; the others by doing them
// Its own open chart: a charge from wherever the lessons leave us runs through open water (no
// rock to stop it short and save it from the practice torpedo), and a shot has a clear line.
const MAP_ID = 'training-range';
const START = { x: 14, y: 10, heading: 0 }; // our boat at O11, bows north
const HOME = { x: 5, y: 4 };                // the training boat at F5,
const PACE = { x: 6, y: 4 };                // pacing to G5 and back while we learn to listen
const TARGET_HULL = 3;
const CHARGE_MIN_RANGE = 4;                 // the training boat shoots from at least this far (else it backs off first)
// Its practice torpedo is slow (time to read the card and act), armed after a cell, and goes off only on
// what its seeker hears: a boat at Half or Full, or a decoy. Go quiet, or throw a decoy, and it runs past.
const PRACTICE_SPEED = 1;

/** Place the boats for the lesson (the engine has made the match on MAP_ID). */
function setup(state) {
  Object.assign(state.subs.alpha, { x: START.x, y: START.y, heading: START.heading });
  // it paces at Full while we learn to listen: loud, so its bearings come in sharp
  Object.assign(state.subs.bravo, { x: HOME.x, y: HOME.y, heading: 2, hull: TARGET_HULL, power: { engines: 3, sonar: 2, tubes: 1 } });
  state.tutorial = {
    step: STEPS[0],
    since: 0,
    from: { x: START.x, y: START.y },
    orderedFull: false,
    shot: null,
    hitInCharge: null,
    targetHull: TARGET_HULL,
    misses: 0,
    skipped: [],
  };
}

/** Which of our stations the auto-crew runs in this step: the engine room until its own lesson. */
function autoStations(state) {
  const i = STEPS.indexOf(state.tutorial?.step);
  return i >= 0 && i < STEPS.indexOf('engine') ? ['chief'] : [];
}

function go(state, step, events, kit, how = 'done') {
  const tu = state.tutorial;
  if (!STEPS.includes(step) || tu.step === step) return;
  const from = tu.step;
  tu.step = step;
  tu.since = state.t;
  tu.from = { x: state.subs.alpha.x, y: state.subs.alpha.y };
  if (how === 'skip') tu.skipped.push(from);
  const me = state.subs.alpha;
  if (step === 'torpedo') tu.targetHull = state.subs.bravo.hull;
  if (step === 'engine') {
    // The chief hands over the levers as they stand at the reactor's six, and something breaks.
    if (me.scram <= 0) me.power = { ...POWER.start };
    if (!me.faults.length) {
      kit.addFault(state, 'alpha', 'fire', events);
    }
  }
  events.push(kit.teamFx('alpha', 'tutorial', { step, from, how }));
}

// ---- the training boat ----------------------------------------------------------------------
function steerTo(state, kit, cell, speed) {
  const b = state.subs.bravo;
  const map = kit.map(state);
  const r = routeTo(map, b, cell);
  if (r && r.heading !== b.heading) kit.A.setHeading(state, 'bravo', r.heading);
  if (b.ordered !== speed) kit.A.setSpeed(state, 'bravo', r ? speed : 0);
}

function holdStill(state, kit) {
  if (state.subs.bravo.ordered !== 0) kit.A.setSpeed(state, 'bravo', 0);
}

/** Away from our boat at Half, to open the range before its practice shot. */
function backOff(state, kit) {
  const b = state.subs.bravo;
  const map = kit.map(state);
  const away = bearing(state.subs.alpha, b);
  for (const turn of [0, 45, -45, 90, -90, 135, -135]) {
    const h = headingFor(away + turn);
    if (stepFrom(map, b, h).ok) {
      if (b.heading !== h) kit.A.setHeading(state, 'bravo', h);
      if (b.ordered !== 2) kit.A.setSpeed(state, 'bravo', 2);
      return;
    }
  }
  holdStill(state, kit);
}

/** Whether our boat has `cells` of open water ahead of it. */
function clearRun(state, kit, cells) {
  const me = state.subs.alpha;
  const map = kit.map(state);
  let at = { x: me.x, y: me.y };
  for (let i = 0; i < cells; i++) {
    const s = stepFrom(map, at, me.heading);
    if (!s.ok) return false;
    at = s.to;
  }
  return true;
}

/** Down the bearing at our boat: a slow practice torpedo that homes on noise. */
function practiceShot(state, kit, events) {
  const tu = state.tutorial;
  const them = state.subs.bravo;
  const me = state.subs.alpha;
  them.tubes[0] = { state: 'ready', progress: 1 };
  const r = kit.A.fire(state, 'bravo', 0, { x: me.x, y: me.y });
  if (!r.ok) { them.tubes[0] = { state: 'empty', progress: 0 }; return false; }
  events.push(...r.events);
  const tp = state.torpedoes[state.torpedoes.length - 1];
  Object.assign(tp, { speed: PRACTICE_SPEED, arm: 1, practice: true, homing: false });
  tu.shot = tp.id;
  tu.hitInCharge = null;
  return true;
}

function drive(state, dt, events, kit) {
  const tu = state.tutorial;
  const me = state.subs.alpha;
  const them = state.subs.bravo;
  switch (tu.step) {
    case 'listen':
    case 'cross': {
      // pacing between its two cells at Full: machinery to listen for
      const goal = them.x === HOME.x && them.y === HOME.y ? PACE : HOME;
      steerTo(state, kit, goal, 3);
      break;
    }
    case 'charge': {
      // Once we ring for Full and pick up speed, it hears us coming and shoots down the bearing.
      if (me.ordered === 3 && !tu.orderedFull) { tu.orderedFull = true; tu.fullAt = state.t; }
      if (dist(me, them) < CHARGE_MIN_RANGE) { backOff(state, kit); break; }
      holdStill(state, kit);
      // it waits for a clear run ahead of us (not a boat about to stop dead on rock), but not for ever
      const committed = clearRun(state, kit, 3) || state.t - (tu.fullAt ?? state.t) > 6;
      if (tu.orderedFull && kit.effectiveSpeed(me) >= 2 && committed && practiceShot(state, kit, events)) go(state, 'evade', events, kit);
      break;
    }
    default:
      holdStill(state, kit);
  }
}

// ---- the lessons' goals -------------------------------------------------------------------
function heardTarget(state) {
  const since = state.tutorial.since;
  return state.contacts.alpha.some((c) => c.t >= since && c.kind === 'hull' && c.ref === undefined);
}

function check(state, events, kit) {
  const tu = state.tutorial;
  const me = state.subs.alpha;
  const them = state.subs.bravo;
  switch (tu.step) {
    case 'helm':
      if (chebyshev(me, tu.from) >= 2) go(state, 'listen', events, kit);
      break;
    case 'listen':
      if (kit.effectiveSpeed(me) === 0 && heardTarget(state)) go(state, 'cross', events, kit);
      break;
    case 'cross':
      if (me.marker && me.marker.t >= tu.since && (chebyshev(me.marker, them) <= 2 || chebyshev(me.marker, HOME) <= 2)) go(state, 'charge', events, kit);
      break;
    case 'evade':
      // only the torpedo counts (running onto rock at Full is its own lesson)
      if (events.some((e) => e.event === 'fx' && e.payload.type === 'hit' && e.payload.team === 'alpha' && e.payload.cause === 'torpedo')) tu.hitInCharge = true;
      if (!state.torpedoes.some((tp) => tp.id === tu.shot)) {
        tu.hitInCharge = tu.hitInCharge === true;
        go(state, 'torpedo', events, kit);
      }
      break;
    case 'torpedo': {
      if (them.hull < tu.targetHull) { go(state, 'engine', events, kit); break; }
      // a blast of ours this tick that left the training boat whole: a miss, and a hint
      const ours = events.filter((e) => e.event === 'fx' && e.payload.type === 'blast' && e.payload.by === 'alpha');
      if (ours.length) tu.misses += ours.length;
      break;
    }
    case 'engine': {
      const total = me.power.engines + me.power.sonar + me.power.tubes;
      if (!me.faults.length && me.power.tubes >= 3 && total <= POWER.base) go(state, 'finish', events, kit);
      break;
    }
    default:
      break;
  }
}

/** Every tick, after the boats and torpedoes have moved. */
function tick(state, dt, events, kit) {
  if (!state.tutorial || state.over) return;
  drive(state, dt, events, kit);
  check(state, events, kit);
}

/**
 * The player's Next (on a step that is only read) or Skip (any step but the last). Skipping the
 * charge skips its torpedo too. Returns the step it moved to, or null when it may not.
 */
function act(state, action, events, kit) {
  const tu = state.tutorial;
  if (!tu || state.over) return null;
  const i = STEPS.indexOf(tu.step);
  if (action === 'next') {
    if (!READ_STEPS.has(tu.step)) return null;
    go(state, STEPS[i + 1], events, kit);
    return tu.step;
  }
  if (action === 'skip') {
    if (i >= STEPS.length - 1) return null;
    const to = tu.step === 'charge' || tu.step === 'evade' ? 'torpedo' : STEPS[i + 1];
    go(state, to, events, kit, 'skip');
    return tu.step;
  }
  return null;
}

/** What the player's view carries of the lesson. */
function view(state) {
  const tu = state.tutorial;
  if (!tu) return null;
  return {
    step: tu.step,
    index: STEPS.indexOf(tu.step),
    total: STEPS.length,
    since: Math.round(tu.since * 10) / 10,
    hitInCharge: tu.hitInCharge,
    misses: tu.misses,
    canNext: READ_STEPS.has(tu.step),
    canSkip: STEPS.indexOf(tu.step) < STEPS.length - 1,
  };
}

module.exports = {
  STEPS, MAP_ID, START, HOME, TARGET_HULL, setup, autoStations, tick, act, view,
};
