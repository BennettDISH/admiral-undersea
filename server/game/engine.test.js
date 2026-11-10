// The rules engine on its own: no sockets, no database. Matches are made with a fixed seed and a
// fixed start, then boats are placed by hand where a test needs them.
const test = require('node:test');
const assert = require('node:assert');
const engine = require('./engine');
const ai = require('./ai');
const { getMap, stepFrom, bearing, angleDiff, routeTo, cellName, headingFor } = require('./map');
const { TUNING, HULL_MAX, TORPEDO, MAPS, BOARD } = require('./constants');

const SHELF = 'black-shelf';
const fresh = (opts = {}) => engine.initMatch({ seed: 7, mapId: SHELF, startIndex: 0, ...opts });
const run = (state, seconds, brains = null) => {
  const out = [];
  for (let i = 0; i < Math.round(seconds / 0.1); i++) out.push(...engine.tick(state, 0.1, brains));
  return out;
};
const fxOf = (events, type) => events.filter((e) => e.event === 'fx' && e.payload.type === type);
const place = (state, team, x, y, heading = 2) => Object.assign(state.subs[team], { x, y, heading, progress: 0 });
// Full speed needs three power on the engines (a boat starts with 2/2/2).
const fullPower = (state, team) => engine.setPower(state, team, { engines: 3, sonar: 2, tubes: 1 });

test('every chart is 16 by 12, its starts and whales are open water, and every water cell is reachable', () => {
  for (const def of MAPS) {
    assert.equal(def.rows.length, BOARD.height, def.id);
    for (const row of def.rows) assert.equal(row.length, BOARD.width, def.id);
    const map = getMap(def.id);
    for (const pair of def.starts) for (const s of pair) assert.ok(map.isWater(s.x, s.y), `${def.id} start ${cellName(s.x, s.y)}`);
    for (const w of def.whales) assert.ok(map.isWater(w.x, w.y));
    const from = def.starts[0][0];
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        if (map.isWater(x, y) && !(x === from.x && y === from.y)) assert.ok(routeTo(map, from, { x, y }), `${def.id} ${cellName(x, y)} cut off`);
      }
    }
  }
});

test('bearings run clockwise from north, and a diagonal step may not cut a rock corner', () => {
  assert.equal(bearing({ x: 5, y: 5 }, { x: 5, y: 1 }), 0);
  assert.equal(bearing({ x: 5, y: 5 }, { x: 9, y: 5 }), 90);
  assert.equal(bearing({ x: 5, y: 5 }, { x: 5, y: 9 }), 180);
  assert.equal(angleDiff(350, 10), 20);
  assert.equal(headingFor(44), 1);
  const map = getMap(SHELF);
  // (1,1) -> NE (2,0): (2,1) is rock, so the diagonal is refused; (1,0) north is fine
  assert.equal(stepFrom(map, { x: 1, y: 1 }, 1).ok, false);
  assert.equal(stepFrom(map, { x: 1, y: 1 }, 0).ok, true);
  assert.equal(cellName(0, 0), 'A1');
  assert.equal(cellName(15, 11), 'P12');
});

test('a match starts with both boats whole, stopped, apart, and every empty station on the auto-crew', () => {
  const s = fresh({ crew: { alpha: { helm: 'human' } } });
  assert.equal(s.subs.alpha.hull, HULL_MAX);
  assert.equal(s.subs.alpha.ordered, 0);
  assert.ok(Math.hypot(s.subs.alpha.x - s.subs.bravo.x, s.subs.alpha.y - s.subs.bravo.y) > 10);
  assert.deepEqual(s.crew.alpha, { helm: 'human', listener: 'auto', weapons: 'auto', chief: 'auto' });
  assert.deepEqual(s.crew.bravo, { helm: 'auto', listener: 'auto', weapons: 'auto', chief: 'auto' });
  assert.equal(engine.isMatch(s), true);
  assert.equal(engine.isMatch({ submarines: { alpha: {}, bravo: {} } }), false, 'an old-rules match is not one');
});

test('the helm sets a heading and a speed; the boat moves a cell per speed time and makes noise the enemy hears', () => {
  const s = fresh();
  place(s, 'alpha', 3, 6, 2); // facing east, open water ahead
  place(s, 'bravo', 9, 6, 6);
  engine.setSpeed(s, 'alpha', 3);
  assert.equal(engine.effectiveSpeed(s.subs.alpha), 2, 'two power on the engines: half at most');
  fullPower(s, 'alpha');
  const ev = run(s, 1.2);
  assert.equal(s.subs.alpha.x, 4, 'one cell at full speed in 1.1 s');
  const heard = fxOf(ev, 'contact').filter((e) => e.team === 'bravo');
  assert.equal(heard.length, 1);
  const c = heard[0].payload.contact;
  assert.equal(c.kind, 'hull');
  assert.ok(Math.abs(angleDiff(c.bearing, bearing({ x: 9, y: 6 }, { x: 4, y: 6 }))) <= c.width, 'the truth is inside the wedge');
  assert.equal(c.ox, 9);
  assert.equal(engine.turn(s, 'alpha', 1).ok, true);
  assert.equal(s.subs.alpha.heading, 3);
  assert.equal(engine.setSpeed(s, 'alpha', 5).ok, false);
  assert.equal(engine.setHeading(s, 'alpha', 8).ok, false);
});

test('speed is held to the engines power: with one power the boat only goes slow', () => {
  const s = fresh();
  place(s, 'alpha', 3, 6, 2);
  engine.setPower(s, 'alpha', { engines: 1, sonar: 2, tubes: 2 });
  engine.setSpeed(s, 'alpha', 3);
  assert.equal(engine.effectiveSpeed(s.subs.alpha), 1);
  run(s, 1.5);
  assert.equal(s.subs.alpha.x, 3, 'slow takes 2.6 s a cell');
  run(s, 1.2);
  assert.equal(s.subs.alpha.x, 4);
});

test('a slow boat is quieter: heard from less far, and a vent field hides a slow boat altogether', () => {
  const s = fresh();
  place(s, 'bravo', 15, 6);
  place(s, 'alpha', 6, 5, 2); // 9 cells off
  engine.setSpeed(s, 'alpha', 1);
  let ev = run(s, 2.7);
  assert.equal(s.subs.alpha.x, 7);
  assert.equal(fxOf(ev, 'contact').length, 0, 'slow at 8 cells is not heard');
  fullPower(s, 'alpha');
  engine.setSpeed(s, 'alpha', 3);
  ev = run(s, 1.2);
  assert.equal(fxOf(ev, 'contact').length, 1, 'full speed is');
  // into the vent field at B5/C5 (x 1-2, y 4-5), slow: nothing heard even close by
  const t = fresh();
  place(t, 'alpha', 3, 5, 6);
  place(t, 'bravo', 5, 5);
  engine.setSpeed(t, 'alpha', 1);
  ev = run(t, 2.7);
  assert.equal(t.subs.alpha.x, 2);
  assert.equal(fxOf(ev, 'contact').length, 0);
});

test('rocks: the helm is warned, a slow bump only stops the boat, a fast one costs hull and a fault', () => {
  const s = fresh();
  place(s, 'alpha', 1, 2, 2); // east of B3 is the rock at C3
  engine.setSpeed(s, 'alpha', 1);
  let ev = run(s, 2.7);
  assert.equal(fxOf(ev, 'rocks-ahead').length, 1);
  assert.equal(fxOf(ev, 'collision')[0].payload.damage, 0);
  assert.equal(s.subs.alpha.ordered, 0);
  assert.equal(s.subs.alpha.hull, HULL_MAX);
  fullPower(s, 'alpha');
  engine.setSpeed(s, 'alpha', 3);
  ev = run(s, 1.2);
  assert.equal(fxOf(ev, 'collision')[0].payload.damage, 1);
  assert.equal(s.subs.alpha.hull, HULL_MAX - 1);
  assert.equal(s.subs.alpha.faults.length, 1);
  assert.equal(fxOf(ev, 'hit')[0].payload.cause, 'rock');
});

test('power: each system 0-4, at most 9 in all; overdrive heats the reactor to a scram, venting cools it', () => {
  const s = fresh();
  assert.equal(engine.setPower(s, 'alpha', { engines: 5, sonar: 0, tubes: 0 }).ok, false);
  assert.equal(engine.setPower(s, 'alpha', { engines: 4, sonar: 4, tubes: 4 }).ok, false);
  assert.equal(engine.setPower(s, 'alpha', { engines: 1.5, sonar: 2, tubes: 2 }).ok, false);
  assert.equal(engine.setPower(s, 'alpha', { engines: 3, sonar: 3, tubes: 3 }).ok, true);
  let ev = run(s, 4);
  assert.ok(s.subs.alpha.heat > 70 && s.subs.alpha.heat < 100);
  assert.equal(fxOf(ev, 'heat-warning').length, 1);
  assert.equal(engine.vent(s, 'alpha').ok, true);
  assert.ok(s.subs.alpha.heat < 45);
  assert.equal(engine.vent(s, 'alpha').ok, false, 'one vent, then a cooldown');
  ev = run(s, 6);
  assert.equal(fxOf(ev, 'scram').length, 1);
  assert.deepEqual(engine.effectivePower(s.subs.alpha), { engines: 0, sonar: 0, tubes: 0 });
  ev = run(s, TUNING.SCRAM_SECONDS + 0.2);
  assert.equal(fxOf(ev, 'power-up').length, 1);
});

test('the torpedo room loads a tube by power, fires at a cell in range, and the blast hurts 2 on the cell and 1 beside it', () => {
  const s = fresh();
  place(s, 'alpha', 2, 11); // the bottom row is open water all the way
  place(s, 'bravo', 8, 11);
  assert.equal(engine.fire(s, 'alpha', 0, { x: 8, y: 11 }).ok, false, 'not loaded');
  engine.setPower(s, 'alpha', { engines: 0, sonar: 2, tubes: 4 });
  engine.loadTube(s, 'alpha', 0);
  assert.equal(engine.loadTube(s, 'alpha', 0).ok, false, 'already loading');
  let ev = run(s, TORPEDO.loadSecondsAtOnePower / 4 + 0.2);
  assert.equal(fxOf(ev, 'tube-loaded').length, 1);
  assert.equal(engine.fire(s, 'alpha', 0, { x: 2, y: 11 }).ok, false, 'not our own cell');
  assert.equal(engine.fire(s, 'alpha', 0, { x: 15, y: 0 }).ok, false, 'out of range');
  const shot = engine.fire(s, 'alpha', 0, { x: 8, y: 11 });
  assert.equal(shot.ok, true);
  assert.equal(fxOf(shot.events, 'contact')[0].payload.contact.kind, 'launch', 'the enemy hears the launch');
  ev = run(s, 3.5);
  assert.equal(fxOf(ev, 'blast').length, 1);
  assert.equal(s.subs.bravo.hull, HULL_MAX - 2);
  assert.equal(s.subs.bravo.faults.length, 2);
  assert.ok(fxOf(ev, 'contact').some((e) => e.team === 'bravo' && e.payload.contact.kind === 'torpedo'), 'a running torpedo is heard');
});

test('a running torpedo can be steered onto a new cell, blows on rock, and is spent after its run', () => {
  const s = fresh();
  place(s, 'alpha', 3, 6);
  place(s, 'bravo', 14, 11);
  s.subs.alpha.tubes[0] = { state: 'ready', progress: 1 };
  s.subs.alpha.tubes[1] = { state: 'ready', progress: 1 };
  engine.fire(s, 'alpha', 0, { x: 3, y: 0 });
  const id = s.torpedoes[0].id;
  assert.equal(engine.guide(s, 'bravo', id, { x: 6, y: 6 }).ok, false, 'not theirs to steer');
  assert.equal(engine.guide(s, 'alpha', id, { x: 6, y: 6 }).ok, true);
  // straight at the rock at G7 (6,6)
  let ev = run(s, 2);
  assert.equal(fxOf(ev, 'blast').length, 1);
  assert.deepEqual({ x: fxOf(ev, 'blast')[0].payload.x, y: fxOf(ev, 'blast')[0].payload.y }, { x: 6, y: 6 });
  // an endless chase: steered back and forth each tick, it is spent after its run
  engine.fire(s, 'alpha', 1, { x: 3, y: 11 });
  place(s, 'alpha', 12, 11); // out of its way
  const tp = s.torpedoes[0];
  ev = [];
  for (let i = 0; i < 80 && s.torpedoes.length; i++) {
    tp.tx = 3; tp.ty = i % 2 ? 11 : 0;
    ev.push(...engine.tick(s, 0.1));
  }
  assert.equal(fxOf(ev, 'torpedo-spent').length, 1);
  assert.equal(fxOf(ev, 'blast').length, 0);
  assert.equal(s.torpedoes.length, 0);
});

test('a ping finds what is within reach and tells the enemy exactly where we are', () => {
  const s = fresh();
  place(s, 'alpha', 4, 6);
  place(s, 'bravo', 8, 6);
  assert.equal(engine.ping(s, 'alpha').ok, false, 'not charged');
  run(s, 21);
  const r = engine.ping(s, 'alpha');
  assert.equal(r.ok, true);
  const result = fxOf(r.events, 'ping-result')[0].payload.ping;
  assert.ok(result.found.some((f) => f.kind === 'boat' && f.x === 8 && f.y === 6));
  const told = fxOf(r.events, 'contact').find((e) => e.team === 'bravo').payload.contact;
  assert.deepEqual({ kind: told.kind, exact: told.exact, x: told.x, y: told.y }, { kind: 'ping', exact: true, x: 4, y: 6 });
  assert.equal(fxOf(r.events, 'pinged')[0].team, 'bravo');
  assert.equal(s.subs.alpha.pingCharge, 0);
});

test('a decoy sounds like a boat at full speed, then dies away', () => {
  const s = fresh();
  place(s, 'alpha', 4, 6);
  place(s, 'bravo', 12, 6);
  assert.equal(engine.launchDecoy(s, 'alpha', 4).ok, true);
  assert.equal(engine.launchDecoy(s, 'alpha', 4).ok, false, 'recharging');
  const ev = run(s, 12);
  const fake = fxOf(ev, 'contact').filter((e) => e.team === 'bravo' && e.payload.contact.kind === 'hull');
  assert.ok(fake.length >= 5);
  assert.equal(s.decoys.length, 0);
});

test('faults: a hit breaks things; the engine room repairs one at a time; a flood left alone costs hull', () => {
  const s = fresh();
  const ev = [];
  engine.addFaults(s, 'alpha', 4, ev);
  assert.deepEqual(s.subs.alpha.faults.map((f) => f.kind).sort(), ['fire', 'flood', 'rudder', 'sonar']);
  assert.equal(engine.setHeading(s, 'alpha', 4).ok, false, 'the rudder is jammed');
  assert.equal(engine.effectivePower(s.subs.alpha).tubes, 0, 'flooding stops the tubes');
  assert.equal(engine.ping(s, 'alpha').ok, false, 'a damaged dome cannot ping');
  const rudder = s.subs.alpha.faults.find((f) => f.kind === 'rudder');
  assert.equal(engine.startRepair(s, 'alpha', rudder.id).ok, true);
  let out = run(s, 4.2);
  assert.equal(fxOf(out, 'repaired')[0].payload.kind, 'rudder');
  assert.equal(engine.setHeading(s, 'alpha', 4).ok, true);
  out = run(s, TUNING.FLOOD_DAMAGE_SECONDS);
  assert.equal(fxOf(out, 'hit').filter((e) => e.payload.cause === 'flood').length, 1);
  assert.equal(s.subs.alpha.hull, HULL_MAX - 1);
  assert.equal(engine.startRepair(s, 'alpha', 999).ok, false);
});

test('the last hull ends the match for the other boat, once; at the end of the clock the hull count decides', () => {
  const s = fresh();
  s.subs.bravo.hull = 1;
  place(s, 'bravo', 9, 6);
  const ev = [];
  engine.blast(s, { x: 9, y: 7 }, 'alpha', ev);
  engine.tick(s, 0.1).forEach((e) => ev.push(e));
  assert.equal(s.over.winner, 'alpha');
  assert.equal(ev.filter((e) => e.event === 'game-over').length, 1);
  assert.deepEqual(engine.tick(s, 0.1), [], 'nothing moves after the end');
  assert.equal(engine.setSpeed(s, 'alpha', 1).ok, false);

  const c = fresh();
  c.t = TUNING.MATCH_SECONDS - 125;
  let out = run(c, 10);
  assert.equal(fxOf(out, 'clock')[0].payload.left, 120);
  c.subs.alpha.hull = 3;
  out = run(c, 120);
  assert.deepEqual({ winner: c.over.winner, how: c.over.how }, { winner: 'bravo', how: 'clock' });
});

test("a team's view has its own boat in full and nothing of the enemy's but its hull", () => {
  const s = fresh();
  place(s, 'alpha', 2, 11);
  s.subs.alpha.tubes[0] = { state: 'ready', progress: 1 };
  assert.equal(engine.fire(s, 'alpha', 0, { x: 7, y: 11 }).ok, true);
  engine.setMarker(s, 'bravo', { x: 2, y: 2 });
  const view = engine.teamView(s, 'bravo', { contacts: true });
  assert.equal(view.boat.x, s.subs.bravo.x);
  assert.equal(view.boat.marker.x, 2);
  assert.deepEqual(view.enemy, { hull: HULL_MAX });
  assert.equal(view.torpedoes.length, 0, "the other boat's torpedo is not on our chart");
  assert.equal(engine.teamView(s, 'alpha').torpedoes.length, 1);
  assert.equal('contacts' in engine.teamView(s, 'alpha'), false, 'contacts only on a full view');
  for (const k of ['whales', 'ai', 'subs', 'rng']) assert.equal(k in view, false, `no ${k} in a view`);
});

test('crew calls reach the team, wait a moment between, and the auto chief answers a call for power', () => {
  const s = fresh();
  s.ai.alpha = ai.newBrain(s, 'alpha');
  const r = engine.call(s, 'alpha', 'helm', 'power-engines');
  assert.equal(r.ok, true);
  assert.equal(fxOf(r.events, 'call')[0].team, 'alpha');
  assert.equal(engine.call(s, 'alpha', 'helm', 'evade').ok, false, 'too soon');
  assert.equal(engine.call(s, 'alpha', 'listener', 'nonsense').ok, false);
  run(s, 1, ai);
  assert.equal(s.subs.alpha.power.engines, 4);
});

test('the auto-crew only uses what its boat heard: its belief does not move without contacts', () => {
  const s = fresh();
  const brain = ai.newBrain(s, 'alpha');
  s.ai.alpha = brain;
  place(s, 'bravo', 12, 3);
  ai.observe(s, 'alpha', brain);
  const before = brain.best;
  s.subs.bravo.x = 2; // move the enemy by hand: nothing heard
  s.t += 0.2;
  ai.observe(s, 'alpha', brain);
  assert.deepEqual(brain.best, before);
});

test('two auto crews fight it out to a result inside the clock, on every seed tried', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const s = engine.initMatch({ seed });
    let fired = 0;
    while (!s.over) fired += fxOf(engine.tick(s, 0.1, ai), 'fired').length;
    assert.ok(s.over.t <= TUNING.MATCH_SECONDS + 0.2, `seed ${seed}`);
    assert.ok(fired > 0, `seed ${seed}: somebody shot`);
    assert.ok(engine.isMatch(JSON.parse(JSON.stringify(s))), 'a match survives JSON (the database)');
  }
});

test('a stored match carries on the same: JSON in, the same ticks out', () => {
  const a = engine.initMatch({ seed: 11 });
  run(a, 30, ai);
  const b = JSON.parse(JSON.stringify(a));
  run(a, 20, ai);
  run(b, 20, ai);
  assert.deepEqual(JSON.parse(JSON.stringify(b.subs)), JSON.parse(JSON.stringify(a.subs)));
});
