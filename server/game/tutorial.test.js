// The tutorial on its own: the step-by-step first dive played by a scripted player through every
// step to the bottom of the training boat, the clock standing still on every read and do step,
// Back and Skip, the charge lesson both ways, and what a stored lesson costs.
const test = require('node:test');
const assert = require('node:assert');
const engine = require('./engine');
const ai = require('./ai');
const tutorial = require('./tutorial');
const { bearing, headingFor, dist } = require('./map');
const { TUNING } = require('./constants');

const ALL = { helm: 'human', listener: 'human', weapons: 'human', chief: 'human' };
const lesson = () => engine.initMatch({ seed: 3, tutorial: true, crew: { alpha: ALL } });
const view = (s) => engine.teamView(s, 'alpha').tutorial;
const tickFor = (s, seconds, each = () => {}) => {
  const out = [];
  for (let i = 0; i < Math.round(seconds / 0.1) && !s.over; i++) { each(); out.push(...engine.tick(s, 0.1, ai)); }
  return out;
};
// tick until the lesson reaches `step` (at most `seconds` of ticks), doing `each` before every tick
function reach(s, step, seconds, each = () => {}) {
  for (let i = 0; i < Math.round(seconds / 0.1) && s.tutorial.step !== step && !s.over; i++) { each(); engine.tick(s, 0.1, ai); }
  assert.equal(s.tutorial.step, step, `reached ${step} by ${s.t.toFixed(1)}s`);
}

/** What a player following the cards does on each step (nothing on a watch step: they wait). */
function byTheBook(s) {
  const me = s.subs.alpha;
  const them = s.subs.bravo;
  const tu = view(s);
  const A = engine;
  switch (tu.step) {
    case 'helm-slow': case 'cross-slow': case 'evade-slow': return A.setSpeed(s, 'alpha', 1);
    case 'helm-stop': case 'cross-stop': case 'evade-after': return A.setSpeed(s, 'alpha', 0);
    case 'helm-turn': return A.turn(s, 'alpha', -1);
    case 'cross-turn': return A.setHeading(s, 'alpha', tu.want.heading);
    case 'cross-mark': return A.setMarker(s, 'alpha', { x: them.x, y: them.y });
    case 'charge-aim': return A.setHeading(s, 'alpha', headingFor(bearing(me, them)));
    case 'charge-full': return A.setSpeed(s, 'alpha', 3);
    case 'evade-decoy': return A.launchDecoy(s, 'alpha', tu.want.heading);
    case 'ping': return A.ping(s, 'alpha');
    case 'ping-mark': {
      const found = s.pings.alpha.found.find((f) => f.kind === 'boat');
      return A.setMarker(s, 'alpha', found || { x: them.x, y: them.y });
    }
    case 'load': return A.loadTube(s, 'alpha', me.tubes.findIndex((t) => t.state === 'empty'));
    case 'fire': return A.fire(s, 'alpha', me.tubes.findIndex((t) => t.state === 'ready'), me.marker);
    case 'engine-fire': return A.startRepair(s, 'alpha', me.faults[0].id);
    case 'engine-tubes': return A.setPower(s, 'alpha', { ...me.power, tubes: me.power.tubes + 1 });
    case 'engine-balance': return A.setPower(s, 'alpha', { ...me.power, engines: me.power.engines - 1 });
    case 'hunt': {
      // a careful hunt with the answers: stopped, mark it, keep a tube loading and fire on the mark
      if (me.ordered) A.setSpeed(s, 'alpha', 0);
      A.setMarker(s, 'alpha', { x: them.x, y: them.y });
      if (!me.tubes.some((t) => t.state === 'loading')) {
        const e = me.tubes.findIndex((t) => t.state === 'empty');
        if (e >= 0) A.loadTube(s, 'alpha', e);
      }
      const ready = me.tubes.findIndex((t) => t.state === 'ready');
      if (ready >= 0 && !s.torpedoes.some((tp) => tp.team === 'alpha')) A.fire(s, 'alpha', ready, { x: them.x, y: them.y });
      return null;
    }
    default:
      return tu.kind === 'read' ? A.tutorialAct(s, 'alpha', 'next') : null;
  }
}

/** Play by the book until the lesson reaches `step` (or ends); returns the steps seen, in order. */
function playTo(s, step, maxSeconds = 400) {
  const seen = [s.tutorial.step];
  for (let i = 0; i < maxSeconds * 10 && !s.over && s.tutorial.step !== step; i++) {
    byTheBook(s);
    engine.tick(s, 0.1, ai);
    if (seen[seen.length - 1] !== s.tutorial.step) seen.push(s.tutorial.step);
  }
  if (step) assert.equal(s.tutorial.step, step, `played to ${step}`);
  return seen;
}

test('the tutorial sets out both boats, starts with its clock stopped, and lets the auto-crew run only the engine room', () => {
  const s = lesson();
  assert.equal(s.mapId, tutorial.MAP_ID);
  assert.deepEqual({ x: s.subs.alpha.x, y: s.subs.alpha.y }, { x: tutorial.START.x, y: tutorial.START.y });
  assert.deepEqual({ x: s.subs.bravo.x, y: s.subs.bravo.y }, tutorial.HOME);
  assert.equal(s.subs.bravo.hull, tutorial.TARGET_HULL);
  assert.deepEqual(['helm', 'listener', 'weapons', 'chief'].filter((st) => engine.isAuto(s, 'alpha', st)), ['chief']);
  const v = view(s);
  assert.deepEqual(
    { step: v.step, kind: v.kind, index: v.index, total: v.total, paused: v.paused, canNext: v.canNext, canBack: v.canBack },
    { step: 'welcome', kind: 'read', index: 0, total: tutorial.STEPS.length, paused: true, canNext: true, canBack: false },
  );
  assert.equal('tutorial' in engine.teamView(s, 'bravo'), false);
  // a whole match's worth of ticks on the first card: nothing moves, no clock, no shot
  const before = JSON.stringify({ t: s.t, subs: s.subs, whales: s.whales });
  const ev = tickFor(s, TUNING.MATCH_SECONDS + 30);
  assert.equal(JSON.stringify({ t: s.t, subs: s.subs, whales: s.whales }), before, 'the clock is stopped');
  assert.deepEqual(ev, [], 'and nothing is heard or said');
  assert.equal(s.over, null);
});

test('played by the book, every step comes up in order and the training boat goes to the bottom', () => {
  const s = lesson();
  const seen = playTo(s, null, 600);
  assert.equal(s.over?.winner, 'alpha', `ended at ${s.tutorial.step} after ${s.t.toFixed(1)}s`);
  assert.equal(s.subs.bravo.hull, 0);
  const firstVisits = seen.filter((st, i) => seen.indexOf(st) === i);
  assert.deepEqual(firstVisits, tutorial.STEPS, 'every step, in the order of the lesson');
  assert.equal(s.subs.alpha.hull, 5, 'without a scratch');
  assert.deepEqual(s.tutorial.skipped, []);
});

test('a read or do step never moves on by itself, however long it waits; a watch step moves on only when its thing happens', () => {
  const s = lesson();
  playTo(s, 'helm-slow');
  tickFor(s, 120);
  assert.equal(s.tutorial.step, 'helm-slow', 'waits for Slow');
  assert.equal(s.t, 0, 'with the clock stopped');
  engine.setSpeed(s, 'alpha', 2); // Half is not what it asked
  tickFor(s, 5);
  assert.equal(s.tutorial.step, 'helm-slow');
  engine.setSpeed(s, 'alpha', 1);
  engine.tick(s, 0.1, ai);
  assert.equal(s.tutorial.step, 'helm-way', 'Slow, and it moves on at once');
  assert.equal(view(s).paused, false, 'the clock runs while the boat makes way');
  reach(s, 'helm-turn', 10);
  const t = s.t;
  tickFor(s, 60);
  assert.equal(s.t, t, 'stopped again for the turn');
  // the practice torpedo hangs where it is while the player reads what to do about it
  playTo(s, 'evade-slow');
  const tp = s.torpedoes.find((x) => x.team === 'bravo');
  assert.ok(tp, 'it shot at us');
  const at = { x: tp.x, y: tp.y };
  tickFor(s, 30);
  assert.deepEqual({ x: tp.x, y: tp.y }, at);
  assert.deepEqual(view(s).threat, { x: Math.round(at.x * 10) / 10, y: Math.round(at.y * 10) / 10 }, 'and the card can show it on the chart');
});

test('Next works only on a read step; Skip does a do step for the player; nothing else is taken', () => {
  const s = lesson();
  assert.equal(engine.tutorialAct(s, 'bravo', 'next').ok, false, 'only our boat');
  for (const bad of ['jump', '__proto__', 'constructor', 'toString', 42, null, undefined]) {
    assert.equal(engine.tutorialAct(s, 'alpha', bad).error.reason, 'bad-action', String(bad));
  }
  assert.equal(engine.tutorialAct(engine.initMatch({ seed: 1 }), 'alpha', 'next').error.reason, 'not-tutorial');
  playTo(s, 'helm-slow');
  assert.equal(engine.tutorialAct(s, 'alpha', 'next').error.reason, 'not-now', 'a do step is done by doing it');
  assert.equal(engine.tutorialAct(s, 'alpha', 'skip').ok, true);
  assert.deepEqual([s.tutorial.step, s.subs.alpha.ordered], ['helm-way', 1], 'Skip rang Slow for them');
  assert.equal(engine.tutorialAct(s, 'alpha', 'skip').error.reason, 'not-now', 'a watch step is waited out');
  assert.deepEqual(s.tutorial.skipped, ['helm-slow']);
});

test('Skip on every do step gets a player who only presses Next and Skip all the way to the practice hunt', () => {
  const s = lesson();
  for (let i = 0; i < 6000 && s.tutorial.step !== 'hunt' && !s.over; i++) {
    const v = view(s);
    if (v.canNext) engine.tutorialAct(s, 'alpha', 'next');
    else if (v.canSkip) engine.tutorialAct(s, 'alpha', 'skip');
    engine.tick(s, 0.1, ai);
  }
  assert.equal(s.tutorial.step, 'hunt');
  assert.ok(s.subs.bravo.hull > 0 && s.subs.bravo.hull < tutorial.TARGET_HULL, 'its skipped shot hit, and it is still afloat');
});

test('Back puts the boat as it was when the step before began, a few steps deep, and no further', () => {
  const s = lesson();
  assert.equal(engine.tutorialAct(s, 'alpha', 'back').error.reason, 'not-now', 'nothing before the first step');
  playTo(s, 'helm-turn');
  const way = s.tutorial.history[s.tutorial.history.length - 2];
  assert.equal(way.tutorial.step, 'helm-way');
  const idBefore = s.nextId;
  assert.equal(engine.tutorialAct(s, 'alpha', 'back').ok, true);
  assert.equal(s.tutorial.step, 'helm-way');
  assert.deepEqual({ x: s.subs.alpha.x, y: s.subs.alpha.y, t: s.t }, { x: tutorial.START.x, y: tutorial.START.y, t: way.state.t }, 'back where the cell of way began');
  assert.ok(s.nextId >= idBefore, 'ids are never handed out twice');
  reach(s, 'helm-turn', 10);
  // back and back: never further than the history kept
  playTo(s, 'listen-list');
  let backs = 0;
  while (engine.tutorialAct(s, 'alpha', 'back').ok) backs += 1;
  assert.equal(backs, tutorial.HISTORY - 1);
  assert.equal(s.tutorial.history.length, 1);
  // and the lesson plays on from there as before
  playTo(s, 'cross-turn');
});

test('Back through the charge takes the practice torpedo back out of the water, and plays it again', () => {
  const s = lesson();
  playTo(s, 'evade-slow');
  assert.equal(s.torpedoes.filter((t) => t.team === 'bravo').length, 1);
  engine.tutorialAct(s, 'alpha', 'back');
  assert.equal(s.tutorial.step, 'charge-run');
  assert.equal(s.torpedoes.length, 0, 'not fired yet');
  assert.equal(s.tutorial.shot, null);
  reach(s, 'evade-slow', 20);
  assert.equal(s.torpedoes.filter((t) => t.team === 'bravo').length, 1, 'fired again');
});

test('charging on at Full through the practice torpedo, with no decoy out, gets the boat hit, and in training it is never sunk', () => {
  const s = lesson();
  playTo(s, 'evade-watch');
  s.decoys = []; // no decoy for its seeker to go for
  engine.setSpeed(s, 'alpha', 3); // back to Full against the card's advice
  // and straight at the torpedo
  const tp = s.torpedoes.find((x) => x.team === 'bravo');
  engine.setHeading(s, 'alpha', headingFor(bearing(s.subs.alpha, tp)));
  reach(s, 'evade-after', 40);
  assert.equal(view(s).hitInCharge, true);
  assert.ok(s.subs.alpha.hull < 5);
  for (let i = 0; i < 6; i++) engine.blast(s, { x: s.subs.alpha.x, y: s.subs.alpha.y }, 'bravo', []);
  assert.equal(s.subs.alpha.hull, 1, 'a training boat is left with a hull');
  assert.equal(s.over, null);
});

test('slowing and a decoy let the practice torpedo run past', () => {
  const s = lesson();
  playTo(s, 'evade-after');
  assert.equal(view(s).hitInCharge, false);
  assert.equal(s.subs.alpha.hull, 5);
});

test('the training boat is kept afloat until the practice hunt, then it can be sunk', () => {
  const s = lesson();
  playTo(s, 'engine-fire');
  for (let i = 0; i < 5; i++) engine.blast(s, { x: s.subs.bravo.x, y: s.subs.bravo.y }, 'alpha', []);
  assert.equal(s.subs.bravo.hull, 1);
  assert.equal(s.over, null);
  playTo(s, 'hunt');
  engine.blast(s, { x: s.subs.bravo.x, y: s.subs.bravo.y }, 'alpha', []);
  engine.tick(s, 0.1, ai);
  assert.equal(s.over?.winner, 'alpha');
});

test('the engine room lesson wants the fire mended, the tubes on three or more, and six or less in all', () => {
  const s = lesson();
  playTo(s, 'engine-fire');
  const me = s.subs.alpha;
  assert.deepEqual(me.faults.map((f) => f.kind), ['fire']);
  assert.deepEqual(me.power, { engines: 2, sonar: 2, tubes: 2 });
  assert.equal(engine.isAuto(s, 'alpha', 'chief'), false, 'the engine room is ours now');
  engine.startRepair(s, 'alpha', me.faults[0].id);
  reach(s, 'engine-reactor', 10);
  engine.tutorialAct(s, 'alpha', 'next');
  engine.setPower(s, 'alpha', { engines: 2, sonar: 2, tubes: 3 });
  engine.tick(s, 0.1, ai);
  assert.equal(s.tutorial.step, 'engine-balance', 'seven in all: on to the balance');
  tickFor(s, 5);
  assert.equal(s.tutorial.step, 'engine-balance');
  engine.setPower(s, 'alpha', { engines: 1, sonar: 2, tubes: 3 });
  engine.tick(s, 0.1, ai);
  assert.equal(s.tutorial.step, 'engine-vent');
});

test('a missed shot comes back round to Load, and says so', () => {
  const s = lesson();
  playTo(s, 'fire');
  const me = s.subs.alpha;
  // fire into open water, well clear of the training boat
  const far = [{ x: 15, y: 11 }, { x: 0, y: 11 }, { x: 15, y: 0 }, { x: 0, y: 0 }].find((c) => dist(c, s.subs.bravo) > 4 && dist(c, me) >= 3 && dist(c, me) <= 11);
  assert.equal(engine.fire(s, 'alpha', me.tubes.findIndex((t) => t.state === 'ready'), far).ok, true);
  reach(s, 'fire-result', 20);
  assert.deepEqual([view(s).lastShot, view(s).misses], ['miss', 1]);
  engine.tutorialAct(s, 'alpha', 'next');
  assert.equal(s.tutorial.step, 'load');
});

test('End leaves the lesson with no winner', () => {
  const s = lesson();
  playTo(s, 'listen-bearing');
  const r = engine.tutorialAct(s, 'alpha', 'end');
  assert.equal(r.ok, true);
  assert.deepEqual(r.events.map((e) => e.event), ['game-over']);
  assert.deepEqual({ winner: s.over.winner, how: s.over.how }, { winner: null, how: 'left' });
  assert.equal(engine.tutorialAct(s, 'alpha', 'back').error.reason, 'game-over');
});

test('a tutorial survives the database: JSON in, the same lesson out, and its Back history stays small', () => {
  const s = lesson();
  let biggest = 0;
  for (let i = 0; i < 6000 && !s.over; i++) {
    byTheBook(s);
    engine.tick(s, 0.1, ai);
    if (i % 50 === 0) biggest = Math.max(biggest, JSON.stringify(s).length);
    if (s.tutorial.history.length > tutorial.HISTORY) assert.fail(`history grew to ${s.tutorial.history.length}`);
  }
  assert.ok(biggest < 150000, `a stored lesson stays under 150 kB (biggest ${biggest})`);
  const t = lesson();
  playTo(t, 'cross-mark');
  const back = JSON.parse(JSON.stringify(t));
  assert.equal(engine.isMatch(back), true);
  assert.deepEqual(engine.teamView(back, 'alpha').tutorial, engine.teamView(t, 'alpha').tutorial);
  assert.equal(engine.tutorialAct(back, 'alpha', 'back').ok, true, 'Back works on a stored lesson');
});

test('a lesson stored before the step-by-step tutorial picks up at the start of its chapter', () => {
  const s = lesson();
  Object.assign(s.tutorial, { step: 'torpedo', history: undefined, seenId: undefined });
  assert.equal(view(s).step, 'ping');
  engine.tick(s, 0.1, ai);
  assert.equal(s.tutorial.step, 'ping');
  assert.equal(s.tutorial.history.length, 1);
});
