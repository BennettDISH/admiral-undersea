// The tutorial on its own: the guided first dive, played by a scripted player through every
// lesson, and the charge lesson both ways (staying at Full gets the boat hit; slowing does not).
const test = require('node:test');
const assert = require('node:assert');
const engine = require('./engine');
const ai = require('./ai');
const tutorial = require('./tutorial');
const { getMap, bearing, headingFor, stepFrom, routeTo, dist } = require('./map');
const { TUNING } = require('./constants');

const ALL = { helm: 'human', listener: 'human', weapons: 'human', chief: 'human' };
const lesson = () => engine.initMatch({ seed: 3, tutorial: true, crew: { alpha: ALL } });
const fxOf = (events, type) => events.filter((e) => e.event === 'fx' && e.payload.type === type);
const tickFor = (s, seconds, each = () => {}) => {
  const out = [];
  for (let i = 0; i < Math.round(seconds / 0.1) && !s.over; i++) { each(); out.push(...engine.tick(s, 0.1, ai)); }
  return out;
};
// tick until the lesson reaches `step` (or `seconds` pass), doing `each` before every tick
function reach(s, step, seconds, each = () => {}) {
  for (let i = 0; i < Math.round(seconds / 0.1) && s.tutorial.step !== step && !s.over; i++) { each(); engine.tick(s, 0.1, ai); }
  assert.equal(s.tutorial.step, step, `reached ${step} by ${s.t.toFixed(1)}s`);
}

/** Through the first lessons by the book, to the charge. */
function toCharge(s) {
  const me = s.subs.alpha;
  const them = s.subs.bravo;
  assert.equal(engine.tutorialAct(s, 'alpha', 'next').ok, true);
  engine.setSpeed(s, 'alpha', 1);
  reach(s, 'listen', 20);
  engine.setSpeed(s, 'alpha', 0);
  reach(s, 'cross', 30);
  engine.setMarker(s, 'alpha', { x: them.x, y: them.y });
  reach(s, 'charge', 1);
  const map = getMap(s.mapId);
  const direct = headingFor(bearing(me, them));
  engine.setHeading(s, 'alpha', stepFrom(map, me, direct).ok ? direct : routeTo(map, me, them).heading);
  engine.setSpeed(s, 'alpha', 3);
  reach(s, 'evade', 20);
}

const shoot = (s) => () => {
  const me = s.subs.alpha;
  if (!me.tubes.some((t) => t.state === 'loading')) {
    const e = me.tubes.findIndex((t) => t.state === 'empty');
    if (e >= 0) engine.loadTube(s, 'alpha', e);
  }
  const ready = me.tubes.findIndex((t) => t.state === 'ready');
  if (ready >= 0 && !s.torpedoes.some((tp) => tp.team === 'alpha')) engine.fire(s, 'alpha', ready, { x: s.subs.bravo.x, y: s.subs.bravo.y });
};

test('the tutorial sets out both boats, keeps no clock, and lets the auto-crew run only the engine room', () => {
  const s = lesson();
  assert.equal(s.mapId, tutorial.MAP_ID);
  assert.deepEqual({ x: s.subs.alpha.x, y: s.subs.alpha.y }, { x: tutorial.START.x, y: tutorial.START.y });
  assert.deepEqual({ x: s.subs.bravo.x, y: s.subs.bravo.y }, tutorial.HOME);
  assert.equal(s.subs.bravo.hull, tutorial.TARGET_HULL);
  assert.equal(s.tutorial.step, 'welcome');
  assert.deepEqual(['helm', 'listener', 'weapons', 'chief'].filter((st) => engine.isAuto(s, 'alpha', st)), ['chief']);
  const view = engine.teamView(s, 'alpha');
  assert.deepEqual({ step: view.tutorial.step, index: view.tutorial.index, canNext: view.tutorial.canNext }, { step: 'welcome', index: 0, canNext: true });
  assert.equal('tutorial' in engine.teamView(s, 'bravo'), false);
  const ev = tickFor(s, TUNING.MATCH_SECONDS + 30);
  assert.equal(s.over, null, 'no end of the clock');
  assert.equal(fxOf(ev, 'clock').length, 0, 'and no warnings for it');
  assert.equal(fxOf(ev, 'fired').length, 0, 'the training boat never shoots unprompted');
});

test('Next works only on a step that is read; Skip moves on, past the practice torpedo from the charge', () => {
  const s = lesson();
  assert.equal(engine.tutorialAct(s, 'bravo', 'next').ok, false, 'only our boat');
  assert.equal(engine.tutorialAct(s, 'alpha', 'jump').ok, false);
  assert.equal(engine.tutorialAct(s, 'alpha', 'next').ok, true);
  assert.equal(engine.tutorialAct(s, 'alpha', 'next').error.reason, 'not-now');
  for (const step of ['listen', 'cross', 'charge', 'torpedo']) {
    assert.equal(engine.tutorialAct(s, 'alpha', 'skip').ok, true);
    assert.equal(s.tutorial.step, step);
  }
  assert.equal(s.torpedoes.length, 0, 'skipping the charge fires nothing');
  engine.tutorialAct(s, 'alpha', 'skip');
  engine.tutorialAct(s, 'alpha', 'skip');
  assert.equal(s.tutorial.step, 'finish');
  assert.equal(engine.tutorialAct(s, 'alpha', 'skip').ok, false, 'the last lesson is done by doing it');
  assert.equal(engine.tutorialAct(engine.initMatch({ seed: 1 }), 'alpha', 'next').error.reason, 'not-tutorial');
});

test('played by the book, every lesson moves on and the training boat goes to the bottom', () => {
  const s = lesson();
  const seen = [];
  const me = s.subs.alpha;
  toCharge(s);
  seen.push('evade');
  // slow, and a decoy at the torpedo
  engine.setSpeed(s, 'alpha', 1);
  const tp = s.torpedoes.find((t) => t.team === 'bravo');
  assert.ok(tp, 'it shot at us');
  assert.equal(engine.launchDecoy(s, 'alpha', headingFor(bearing(me, tp))).ok, true);
  reach(s, 'torpedo', 20);
  assert.equal(s.tutorial.hitInCharge, false, 'it ran past');
  engine.setSpeed(s, 'alpha', 0);
  reach(s, 'engine', 90, shoot(s));
  assert.equal(me.faults.length > 0, true, 'the engine room has a fault to mend');
  assert.equal(engine.isAuto(s, 'alpha', 'chief'), false, 'and it is ours now');
  engine.setPower(s, 'alpha', { engines: 1, sonar: 2, tubes: 3 });
  reach(s, 'finish', 60, () => {
    if (!me.repair && me.faults.length) engine.startRepair(s, 'alpha', me.faults[0].id);
  });
  tickFor(s, 90, shoot(s));
  assert.deepEqual({ winner: s.over?.winner, hull: s.subs.bravo.hull }, { winner: 'alpha', hull: 0 });
  assert.equal(me.hull, 5, 'without a scratch');
});

test('charging on at Full through the practice torpedo gets the boat hit, and in training it is never sunk', () => {
  const s = lesson();
  toCharge(s);
  reach(s, 'torpedo', 30);
  assert.equal(s.tutorial.hitInCharge, true);
  assert.ok(s.subs.alpha.hull < 5);
  // whatever else happens, a training boat is left with a hull
  for (let i = 0; i < 6; i++) engine.blast(s, { x: s.subs.alpha.x, y: s.subs.alpha.y }, 'bravo', []);
  assert.equal(s.subs.alpha.hull, 1);
  assert.equal(s.over, null);
});

test('dropping to Slow, even late, lets the practice torpedo run past', () => {
  for (const wait of [0.5, 1.5, 2.5]) {
    const s = lesson();
    toCharge(s);
    tickFor(s, wait);
    engine.setSpeed(s, 'alpha', 1);
    reach(s, 'torpedo', 30);
    assert.equal(s.tutorial.hitInCharge, false, `slowed after ${wait}s`);
  }
});

test('the engine room lesson wants every fault mended, the tubes on three or more, and six or less in all', () => {
  const s = lesson();
  for (let i = 0; i < 6; i++) engine.tutorialAct(s, 'alpha', 'skip');
  assert.equal(s.tutorial.step, 'engine');
  const me = s.subs.alpha;
  assert.deepEqual(me.faults.map((f) => f.kind), ['fire']);
  assert.deepEqual(me.power, { engines: 2, sonar: 2, tubes: 2 });
  engine.setPower(s, 'alpha', { engines: 2, sonar: 2, tubes: 3 });
  engine.startRepair(s, 'alpha', me.faults[0].id);
  tickFor(s, 5);
  assert.equal(s.tutorial.step, 'engine', 'seven in all: not yet');
  engine.setPower(s, 'alpha', { engines: 1, sonar: 2, tubes: 3 });
  tickFor(s, 0.2);
  assert.equal(s.tutorial.step, 'finish');
});

test('a tutorial survives the database: JSON in, the same lesson out', () => {
  const s = lesson();
  engine.tutorialAct(s, 'alpha', 'next');
  const back = JSON.parse(JSON.stringify(s));
  assert.equal(engine.isMatch(back), true);
  assert.deepEqual(engine.teamView(back, 'alpha').tutorial, engine.teamView(s, 'alpha').tutorial);
  assert.ok(dist(back.subs.alpha, back.subs.bravo) > 8);
});
