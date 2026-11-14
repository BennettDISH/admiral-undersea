// The tutorial: a guided first dive against a training boat, one control at a time. Pure, like the
// engine: it places the boats, drives the training boat (bravo), stops the clock while the player
// reads a step or finds the control it asks for, checks each step's goal and moves the player on.
//
// Every step is one of four kinds:
//   read   the clock is stopped; Next moves on.
//   do     the clock is stopped until the player does the one thing the step asks (ring for Slow,
//          click Load...). "Skip this step" does it for them.
//   watch  the clock runs until what the player set going has happened (a cell of way, a bearing
//          heard, a tube loaded). Nothing moves on by time alone.
//   hunt   the last step: the clock runs, the training boat creeps about, and it ends when it sinks.
// Back puts the boat back as it was when the step before began, a few steps deep. The words, and
// the control each step lights up, are the client's (client/src/game/tutorial.js), by step id.
const {
  dist, chebyshev, bearing, angleDiff, headingFor, stepFrom, routeTo,
} = require('./map');
const { POWER } = require('./constants');

// Its own open chart: a charge from wherever the lessons leave us runs through open water (no
// rock to stop it short and save it from the practice torpedo), and a shot has a clear line.
const MAP_ID = 'training-range';
const START = { x: 14, y: 10, heading: 0 }; // our boat at O11, bows north
const HOME = { x: 5, y: 4 };                // the training boat at F5,
const PACE = { x: 6, y: 4 };                // pacing to G5 and back while we learn to listen
const TARGET_HULL = 3;
const CHARGE_MIN_RANGE = 4;                 // the training boat shoots from at least this far (else it backs off first)
// Its practice torpedo is slow, armed after a cell, and goes off only on what its seeker hears: a
// boat at Half or Full, or a decoy. Go quiet, or throw a decoy, and it runs past.
const PRACTICE_SPEED = 1;
const HISTORY = 6;                          // steps kept for Back (each a copy of the boat as the step began)
const HUNT_SHOT_EVERY = 30;                 // in the practice hunt, a boat at Full is shot at this often
// Where the training boat hides for the practice hunt: open water, off the vent fields.
const HIDEOUTS = [{ x: 2, y: 1 }, { x: 9, y: 1 }, { x: 15, y: 4 }, { x: 1, y: 6 }, { x: 8, y: 7 }, { x: 1, y: 11 }, { x: 8, y: 11 }];

const me = (state) => state.subs.alpha;
const them = (state) => state.subs.bravo;
const totalPower = (p) => p.engines + p.sonar + p.tubes;
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** A machinery bearing on the training boat heard since this step began. */
function heardTarget(state) {
  const seen = state.tutorial.seenId ?? 0;
  return state.contacts.alpha.some((c) => c.id > seen && c.kind === 'hull' && c.ref === undefined);
}
const ourTorpedo = (state) => state.torpedoes.some((tp) => tp.team === 'alpha');
/** A mark put down in this step (not the one it began with), within `cells` of the training boat. */
const markedNear = (state, tu, cells) => {
  const m = me(state).marker;
  return Boolean(m) && !same(m, tu.markWas) && chebyshev(m, them(state)) <= cells;
};

// ---- the steps -------------------------------------------------------------------------------
// kind, the station whose screen it is taught on (the client lights that tab first when another is
// up), what the training boat does while the clock runs (boat), what the step sets up as it begins
// (enter), its goal (done), and what "Skip this step" does for the player (auto).
const LESSON = [
  { id: 'welcome', kind: 'read' },
  { id: 'chart', kind: 'read' },
  { id: 'stations', kind: 'read' },
  { id: 'crew', kind: 'read' },
  { id: 'hulls', kind: 'read' },

  // the helm
  { id: 'helm-slow', kind: 'do', station: 'helm', done: (s) => me(s).ordered === 1, auto: (s, k) => k.A.setSpeed(s, 'alpha', 1) },
  { id: 'helm-way', kind: 'watch', needsWay: true, done: (s, tu) => chebyshev(me(s), tu.from) >= 1 },
  { id: 'helm-turn', kind: 'do', station: 'helm', done: (s, tu) => me(s).heading !== tu.fromHeading, auto: (s, k) => k.A.turn(s, 'alpha', -1) },
  { id: 'helm-compass', kind: 'read', station: 'helm' },
  { id: 'helm-stop', kind: 'do', station: 'helm', done: (s) => me(s).ordered === 0, auto: (s, k) => k.A.setSpeed(s, 'alpha', 0) },

  // listening, and finding the range by crossing two bearings
  { id: 'listen-wait', kind: 'watch', boat: 'pace', done: heardTarget },
  { id: 'listen-bearing', kind: 'read' },
  { id: 'listen-list', kind: 'read', station: 'listener' },
  {
    id: 'cross-turn', kind: 'do', station: 'helm',
    enter: (s, k) => { s.tutorial.want = { heading: crossHeading(s, k) }; },
    done: (s, tu) => me(s).heading === tu.want?.heading,
    auto: (s, k, tu) => k.A.setHeading(s, 'alpha', tu.want.heading),
  },
  { id: 'cross-slow', kind: 'do', station: 'helm', done: (s) => me(s).ordered >= 1, auto: (s, k) => k.A.setSpeed(s, 'alpha', 1) },
  { id: 'cross-run', kind: 'watch', needsWay: true, done: (s, tu) => chebyshev(me(s), tu.from) >= 3 },
  { id: 'cross-stop', kind: 'do', station: 'helm', done: (s) => me(s).ordered === 0, auto: (s, k) => k.A.setSpeed(s, 'alpha', 0) },
  { id: 'cross-listen', kind: 'watch', boat: 'pace', done: heardTarget },
  {
    id: 'cross-mark', kind: 'do', station: 'listener',
    done: (s, tu) => markedNear(s, tu, 2) || (Boolean(me(s).marker) && !same(me(s).marker, tu.markWas) && chebyshev(me(s).marker, HOME) <= 2),
    auto: (s, k) => k.A.setMarker(s, 'alpha', { x: them(s).x, y: them(s).y }),
  },

  // why not charge
  {
    id: 'charge-aim', kind: 'do', station: 'helm',
    done: (s) => Math.abs(angleDiff(me(s).heading * 45, bearing(me(s), them(s)))) <= 50,
    auto: (s, k) => k.A.setHeading(s, 'alpha', headingFor(bearing(me(s), them(s)))),
  },
  { id: 'charge-full', kind: 'do', station: 'helm', done: (s) => me(s).ordered === 3, auto: (s, k) => k.A.setSpeed(s, 'alpha', 3) },
  { id: 'charge-run', kind: 'watch', boat: 'charge', needsFull: true, done: (s, tu) => Boolean(tu.shot) },
  { id: 'evade-slow', kind: 'do', station: 'helm', done: (s) => me(s).ordered <= 1, auto: (s, k) => k.A.setSpeed(s, 'alpha', 1) },
  {
    id: 'evade-decoy', kind: 'do', station: 'weapons',
    enter: (s) => { s.tutorial.want = { heading: threatHeading(s) }; },
    done: (s) => s.decoys.some((d) => d.team === 'alpha') || me(s).decoyCooldown > 0,
    auto: (s, k, tu) => k.A.launchDecoy(s, 'alpha', tu.want.heading),
  },
  { id: 'evade-watch', kind: 'watch', done: (s, tu) => !s.torpedoes.some((tp) => tp.id === tu.shot) },
  {
    id: 'evade-after', kind: 'do', station: 'helm',
    enter: (s) => { s.tutorial.hitInCharge = s.tutorial.hitInCharge === true; },
    done: (s) => me(s).ordered === 0,
    auto: (s, k) => k.A.setSpeed(s, 'alpha', 0),
  },

  // lining up a shot, and the torpedo room
  {
    id: 'ping', kind: 'do', station: 'listener',
    enter: (s) => {
      // the crew has patched whatever the practice torpedo broke, and the ping is charged
      const b = me(s);
      b.faults = [];
      b.repair = null;
      if (b.power.sonar < 2) b.power = { ...POWER.start };
      b.pingCharge = 1;
      s.tutorial.pingWas = s.pings.alpha || null;
    },
    done: (s, tu) => {
      const p = s.pings.alpha;
      if (!p || same(p, tu.pingWas)) return false;
      tu.pingFound = p.found.some((f) => f.kind === 'boat');
      return true;
    },
    auto: (s, k) => k.A.ping(s, 'alpha'),
  },
  {
    id: 'ping-mark', kind: 'do', station: 'listener',
    done: (s, tu) => markedNear(s, tu, 1) || (!tu.pingFound && markedNear(s, tu, 2)),
    auto: (s, k) => k.A.setMarker(s, 'alpha', { x: them(s).x, y: them(s).y }),
  },
  {
    id: 'load', kind: 'do', station: 'weapons',
    done: (s) => me(s).tubes.some((tb) => tb.state !== 'empty'),
    auto: (s, k) => k.A.loadTube(s, 'alpha', Math.max(0, me(s).tubes.findIndex((tb) => tb.state === 'empty'))),
  },
  { id: 'load-wait', kind: 'watch', done: (s) => me(s).tubes.some((tb) => tb.state === 'ready') },
  { id: 'aim', kind: 'read', station: 'weapons' },
  {
    id: 'fire', kind: 'do', station: 'weapons',
    enter: (s) => { s.tutorial.targetHull = them(s).hull; },
    done: ourTorpedo,
    auto: (s, k) => {
      const i = me(s).tubes.findIndex((tb) => tb.state === 'ready');
      return i < 0 ? { ok: false, events: [] } : k.A.fire(s, 'alpha', i, { x: them(s).x, y: them(s).y });
    },
  },
  {
    id: 'fire-watch', kind: 'watch',
    done: (s, tu) => {
      if (them(s).hull < tu.targetHull) { tu.lastShot = 'hit'; return true; }
      if (ourTorpedo(s)) return false;
      tu.lastShot = 'miss';
      tu.misses = (tu.misses || 0) + 1;
      return true;
    },
  },
  { id: 'fire-result', kind: 'read', next: (s, tu) => (tu.lastShot === 'hit' ? 'engine-fire' : 'load') },

  // the engine room
  {
    id: 'engine-fire', kind: 'do', station: 'chief',
    enter: (s, k, events) => {
      // the chief hands over the levers as they stand at the reactor's six, and something breaks
      const b = me(s);
      if (b.scram <= 0) b.power = { ...POWER.start };
      b.faults = [];
      b.repair = null;
      k.addFault(s, 'alpha', 'fire', events);
    },
    done: (s) => !me(s).faults.length || Boolean(me(s).repair),
    auto: (s, k) => (me(s).faults[0] ? k.A.startRepair(s, 'alpha', me(s).faults[0].id) : { ok: true, events: [] }),
  },
  { id: 'engine-repair', kind: 'watch', done: (s) => !me(s).faults.length },
  { id: 'engine-reactor', kind: 'read', station: 'chief' },
  {
    id: 'engine-tubes', kind: 'do', station: 'chief',
    done: (s) => me(s).power.tubes >= 3,
    auto: (s, k) => k.A.setPower(s, 'alpha', { ...me(s).power, tubes: 3 }),
  },
  {
    id: 'engine-balance', kind: 'do', station: 'chief',
    done: (s) => me(s).power.tubes >= 3 && totalPower(me(s).power) <= POWER.base,
    auto: (s, k) => k.A.setPower(s, 'alpha', { engines: 1, sonar: 2, tubes: 3 }),
  },
  { id: 'engine-vent', kind: 'read', station: 'chief' },
  { id: 'calls', kind: 'read' },

  // the practice hunt
  { id: 'hunt', kind: 'hunt', boat: 'hunt', enter: (s, k) => hideOut(s, k) },
];
const BY_ID = new Map(LESSON.map((st, i) => [st.id, { ...st, index: i }]));
const STEPS = LESSON.map((st) => st.id);
const stepOf = (state) => BY_ID.get(state.tutorial?.step);

// Old stored lessons (before the step-by-step tutorial) pick up at the start of their chapter.
const OLD_STEPS = {
  helm: 'helm-slow', listen: 'listen-wait', cross: 'cross-turn', charge: 'charge-aim', evade: 'evade-slow',
  torpedo: 'ping', engine: 'engine-fire', finish: 'hunt',
};

// ---- helpers for the steps -----------------------------------------------------------------
/** Whether our boat has `cells` of open water ahead of it on `heading`. */
function clearRun(state, kit, cells, heading = me(state).heading) {
  const map = kit.map(state);
  let at = { x: me(state).x, y: me(state).y };
  for (let i = 0; i < cells; i++) {
    const s = stepFrom(map, at, heading);
    if (!s.ok) return false;
    at = s.to;
  }
  return true;
}

/** A heading across the bearing to the training boat with room to run three cells. */
function crossHeading(state, kit) {
  const to = bearing(me(state), them(state));
  for (const turn of [90, -90, 135, -135, 45, -45]) {
    const h = headingFor(to + turn);
    if (clearRun(state, kit, 3, h)) return h;
  }
  return headingFor(to + 90);
}

/** From us toward the practice torpedo (or the training boat, when there is none). */
function threatHeading(state) {
  const tp = state.torpedoes.find((x) => x.id === state.tutorial.shot);
  return headingFor(bearing(me(state), tp || them(state)));
}

// ---- the training boat -----------------------------------------------------------------------
function steerTo(state, kit, cell, speed) {
  const b = them(state);
  const r = routeTo(kit.map(state), b, cell);
  if (r && r.heading !== b.heading) kit.A.setHeading(state, 'bravo', r.heading);
  if (b.ordered !== (r ? speed : 0)) kit.A.setSpeed(state, 'bravo', r ? speed : 0);
}

function holdStill(state, kit) {
  if (them(state).ordered !== 0) kit.A.setSpeed(state, 'bravo', 0);
}

/** Away from our boat at Half, to open the range before its practice shot. */
function backOff(state, kit) {
  const b = them(state);
  const map = kit.map(state);
  const away = bearing(me(state), b);
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

/** Down the bearing at our boat: a slow practice torpedo that homes on noise. */
function practiceShot(state, kit, events) {
  const tu = state.tutorial;
  const b = them(state);
  b.tubes[0] = { state: 'ready', progress: 1 };
  const r = kit.A.fire(state, 'bravo', 0, { x: me(state).x, y: me(state).y });
  if (!r.ok) { b.tubes[0] = { state: 'empty', progress: 0 }; return false; }
  events.push(...r.events);
  const tp = state.torpedoes[state.torpedoes.length - 1];
  Object.assign(tp, { speed: PRACTICE_SPEED, arm: 1, practice: true, homing: false });
  tu.shot = tp.id;
  tu.hitInCharge = null;
  return true;
}

/** The practice hunt: it slips off to a hideout some way from us, then paces there at Half. */
function hideOut(state, kit) {
  const tu = state.tutorial;
  const map = kit.map(state);
  const ours = me(state);
  const b = them(state);
  const fits = HIDEOUTS.filter((c) => map.isWater(c.x, c.y) && !map.isVent(c.x, c.y) && dist(ours, c) >= 6 && dist(ours, c) <= 10);
  const pool = fits.length ? fits : HIDEOUTS;
  const spot = pool.reduce((best, c) => (dist(b, c) > dist(b, best) ? c : best), pool[0]);
  const next = [0, 2, 4, 6].map((h) => stepFrom(map, spot, h)).find((s) => s.ok && !map.isVent(s.to.x, s.to.y));
  tu.hideout = { x: spot.x, y: spot.y };
  tu.hideout2 = next ? next.to : { x: spot.x, y: spot.y };
  tu.hidden = false;
}

function drive(state, events, kit) {
  const tu = state.tutorial;
  const b = them(state);
  const step = stepOf(state);
  switch (step?.boat) {
    case 'pace': {
      // pacing between its two cells at Full: machinery to listen for
      const goal = b.x === HOME.x && b.y === HOME.y ? PACE : HOME;
      steerTo(state, kit, goal, 3);
      break;
    }
    case 'charge': {
      // Once we ring for Full and make a cell of way, it hears us coming and shoots down the bearing.
      const ours = me(state);
      if (ours.ordered === 3 && tu.fullAt == null) tu.fullAt = state.t;
      if (dist(ours, b) < CHARGE_MIN_RANGE) { backOff(state, kit); break; }
      holdStill(state, kit);
      // it waits for a clear run ahead of us (not a boat about to stop dead on rock), but not for ever
      const atFull = state.t - (tu.fullAt ?? state.t);
      const committed = clearRun(state, kit, 3) || atFull > 6;
      const moved = chebyshev(ours, tu.from) >= 1 || atFull > 3;
      if (ours.ordered === 3 && kit.effectiveSpeed(ours) >= 2 && committed && moved) practiceShot(state, kit, events);
      break;
    }
    case 'hunt': {
      if (!tu.hideout) hideOut(state, kit);
      const at = (c) => b.x === c.x && b.y === c.y;
      if (!tu.hidden && at(tu.hideout)) tu.hidden = true;
      if (!tu.hidden) steerTo(state, kit, tu.hideout, 2);
      else steerTo(state, kit, at(tu.hideout) ? tu.hideout2 : tu.hideout, 2);
      // charging still gets a practice torpedo down the bearing
      const ours = me(state);
      const running = state.torpedoes.some((tp) => tp.team === 'bravo');
      if (!running && kit.effectiveSpeed(ours) >= 3 && dist(ours, b) >= CHARGE_MIN_RANGE && state.t - (tu.huntShotAt ?? -Infinity) >= HUNT_SHOT_EVERY) {
        if (practiceShot(state, kit, events)) tu.huntShotAt = state.t;
      }
      break;
    }
    default:
      holdStill(state, kit);
  }
}

// ---- moving between steps, and Back ----------------------------------------------------------
// What a step's copy of the boat holds: everything the rules play on (not who is aboard, which is
// the sockets', and not the auto-crew's notes, which it keeps up itself).
const KEPT = ['t', 'rng', 'nextId', 'subs', 'torpedoes', 'decoys', 'whales', 'blasts', 'contacts', 'pings', 'calls', 'lastBlastBy'];
const copy = (v) => JSON.parse(JSON.stringify(v));

function snapshot(state) {
  const { history, ...tu } = state.tutorial;
  const kept = {};
  for (const k of KEPT) if (state[k] !== undefined) kept[k] = state[k];
  return copy({ state: kept, tutorial: tu });
}

function go(state, id, events, kit, how = 'done') {
  const tu = state.tutorial;
  const to = BY_ID.get(id);
  if (!to || tu.step === id) return;
  const from = tu.step;
  Object.assign(tu, {
    step: id,
    since: state.t,
    from: { x: me(state).x, y: me(state).y },
    fromHeading: me(state).heading,
    seenId: state.nextId,
    markWas: me(state).marker ? { ...me(state).marker } : null,
    want: null,
    fullAt: null,
  });
  if (how === 'skip') tu.skipped.push(from);
  if (to.enter) to.enter(state, kit, events);
  const history = [...(tu.history || []), snapshot(state)];
  tu.history = history.slice(-HISTORY);
  events.push(kit.teamFx('alpha', 'tutorial', { step: id, from, how }));
}

function back(state, events, kit) {
  const tu = state.tutorial;
  const history = (tu.history || []).slice(0, -1);
  const prev = history[history.length - 1];
  if (!prev) return false;
  const from = tu.step;
  const nextId = state.nextId;
  const was = copy(prev);
  for (const k of KEPT) delete state[k];
  Object.assign(state, was.state);
  state.nextId = Math.max(nextId, state.nextId || 0); // ids are never handed out twice
  state.tutorial = { ...was.tutorial, history };
  events.push(kit.teamFx('alpha', 'tutorial', { step: state.tutorial.step, from, how: 'back' }));
  return true;
}

function nextOf(state, step) {
  if (step.next) return step.next(state, state.tutorial);
  return STEPS[step.index + 1];
}

// ---- the clock -------------------------------------------------------------------------------
/** A stored lesson from before the step-by-step tutorial, brought up to date. */
function normalise(state) {
  const tu = state.tutorial;
  if (!tu) return;
  if (!BY_ID.has(tu.step)) {
    tu.step = OLD_STEPS[tu.step] || 'welcome';
    tu.history = [];
  }
  if (!Array.isArray(tu.skipped)) tu.skipped = [];
  if (typeof tu.misses !== 'number') tu.misses = 0;
  if (tu.seenId == null) tu.seenId = state.nextId;
  if (!Array.isArray(tu.history) || !tu.history.length) tu.history = [snapshot(state)];
}

/** Whether the clock is stopped: the player is reading a step or finding the control it asks for. */
function paused(state) {
  if (!state.tutorial || state.over) return false;
  const step = stepOf(state) || BY_ID.get(OLD_STEPS[state.tutorial.step]);
  return Boolean(step) && (step.kind === 'read' || step.kind === 'do');
}

/** The goal of the step on now: met, it moves on (a step met at once moves on again, and so on). */
function check(state, events, kit) {
  normalise(state);
  for (let guard = 0; guard < 4 && !state.over; guard++) {
    const tu = state.tutorial;
    const step = stepOf(state);
    if (!step?.done || !step.done(state, tu)) return;
    go(state, nextOf(state, step), events, kit);
  }
}

/** Every tick the clock runs, after the boats and torpedoes have moved. */
function tick(state, dt, events, kit) {
  if (!state.tutorial || state.over) return;
  normalise(state);
  // a torpedo hit on us (the practice torpedo, from the charge on): the next card says so
  if (events.some((e) => e.event === 'fx' && e.payload.type === 'hit' && e.payload.team === 'alpha' && e.payload.cause === 'torpedo')) {
    state.tutorial.hitInCharge = true;
  }
  drive(state, events, kit);
  check(state, events, kit);
}

/** Which of our stations the auto-crew runs: the engine room until its own lesson. */
function autoStations(state) {
  const i = stepOf(state)?.index ?? 0;
  return i < BY_ID.get('engine-fire').index ? ['chief'] : [];
}

/**
 * Whether a noise comes in as a sharp bearing: the training boat's, in the lessons (not the
 * practice hunt), so the two bearings of the listening lesson cross right on it.
 */
function sharpBearing(state, noise) {
  return Boolean(state.tutorial) && noise.source === 'bravo' && noise.kind === 'hull' && state.tutorial.step !== 'hunt';
}

/** Whether the training boat is kept afloat (it is, until the practice hunt). */
function spareTarget(state) {
  return Boolean(state.tutorial) && state.tutorial.step !== 'hunt';
}

/**
 * The player's Next (a step that is only read), Skip (this step, done for them), or Back (to the
 * step before, as it began). Returns the step it moved to, or null when it may not.
 */
function act(state, action, events, kit) {
  const tu = state.tutorial;
  if (!tu || state.over) return null;
  normalise(state);
  const step = stepOf(state);
  if (action === 'back') return back(state, events, kit) ? state.tutorial.step : null;
  if (action !== 'next' && action !== 'skip') return null;
  if (step.kind === 'read') {
    go(state, nextOf(state, step), events, kit, action === 'skip' ? 'skip' : 'done');
    check(state, events, kit);
    return state.tutorial.step;
  }
  if (action !== 'skip' || step.kind !== 'do' || !step.auto) return null;
  const r = step.auto(state, kit, tu);
  if (r && !r.ok) return null;
  if (r?.events) events.push(...r.events);
  if (!step.done(state, tu)) return null;
  tu.skipped.push(step.id);
  check(state, events, kit);
  return state.tutorial.step;
}

/** What the player's view carries of the lesson. */
function view(state) {
  const tu = state.tutorial;
  if (!tu) return null;
  const step = stepOf(state) || BY_ID.get(OLD_STEPS[tu.step]) || BY_ID.get('welcome');
  const ours = me(state);
  const threat = state.torpedoes.find((tp) => tp.team === 'bravo' && tp.practice);
  return {
    step: step.id,
    kind: step.kind,
    station: step.station || null,
    index: step.index,
    total: STEPS.length,
    since: Math.round(tu.since * 10) / 10,
    paused: paused(state),
    hitInCharge: tu.hitInCharge ?? null,
    misses: tu.misses || 0,
    lastShot: tu.lastShot || null,
    pingFound: tu.pingFound ?? null,
    want: tu.want || null,
    // a mark put down on a marking step that is still on: it was not close enough
    markedWrong: (step.id === 'cross-mark' || step.id === 'ping-mark') && Boolean(ours.marker) && !same(ours.marker, tu.markWas),
    // a step that needs way on, with the boat stopped (it ran onto rock, or the player rang Stop)
    stalled: Boolean((step.needsWay && ours.ordered === 0) || (step.needsFull && ours.ordered < 3 && !tu.shot)),
    // the practice torpedo, drawn on the chart in training so the player can see it coming
    threat: threat ? { x: Math.round(threat.x * 10) / 10, y: Math.round(threat.y * 10) / 10 } : null,
    canNext: step.kind === 'read',
    canSkip: step.kind === 'do' && Boolean(step.auto),
    canBack: (tu.history || []).length > 1,
  };
}

/** Place the boats for the lesson (the engine has made the match on MAP_ID). */
function setup(state) {
  Object.assign(state.subs.alpha, { x: START.x, y: START.y, heading: START.heading });
  // it paces at Full while we learn to listen: loud, so its bearings come in sharp
  Object.assign(state.subs.bravo, { x: HOME.x, y: HOME.y, heading: 2, hull: TARGET_HULL, power: { engines: 3, sonar: 2, tubes: 1 } });
  state.tutorial = {
    step: STEPS[0],
    since: 0,
    from: { x: START.x, y: START.y },
    fromHeading: START.heading,
    seenId: state.nextId,
    markWas: null,
    shot: null,
    hitInCharge: null,
    targetHull: TARGET_HULL,
    misses: 0,
    skipped: [],
    history: [],
  };
  state.tutorial.history = [snapshot(state)];
}

module.exports = {
  STEPS, MAP_ID, START, HOME, TARGET_HULL, HISTORY,
  setup, autoStations, spareTarget, sharpBearing, paused, check, tick, act, view,
};
