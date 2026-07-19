const test = require('node:test');
const assert = require('node:assert');
const E = require('./engine');
const { sectorOf } = require('./map');

// Helper: fresh turn-based game, optionally place a sub.
function game(mode = 'turn-based') {
  return E.initGameState(mode, false);
}
function place(state, team, x, y, patch = {}) {
  Object.assign(state.submarines[team], { position: { x, y }, ...patch });
}
const has = (events, name) => events.some((e) => e.event === name);
const find = (events, name) => events.find((e) => e.event === name);

// ---------------------------------------------------------------- movement
test('legalMoves excludes island / edge / trail', () => {
  const s = game();
  // alpha starts at (1,1); (2,1) is an island so E is illegal.
  assert.deepStrictEqual(E.legalMoves(s, 'alpha').sort(), ['N', 'S', 'W']);

  place(s, 'alpha', 0, 0); // corner: N and W leave the board
  assert.deepStrictEqual(E.legalMoves(s, 'alpha').sort(), ['E', 'S']);

  place(s, 'alpha', 5, 5, { path: [{ x: 5, y: 4 }] }); // came from the north
  assert.ok(!E.legalMoves(s, 'alpha').includes('N'));
});

test('applyMove rejects an illegal direction and does not move', () => {
  const s = game();
  const before = { ...s.submarines.alpha.position };
  const r = E.applyMove(s, 'alpha', 'E'); // into the island at (2,1)
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.reason, 'island');
  assert.deepStrictEqual(s.submarines.alpha.position, before);
});

test('applyMove commits a legal move, records trail, announces', () => {
  const s = game();
  const r = E.applyMove(s, 'alpha', 'S');
  assert.ok(r.ok);
  assert.deepStrictEqual(s.submarines.alpha.position, { x: 1, y: 2 });
  assert.deepStrictEqual(s.submarines.alpha.path, [{ x: 1, y: 1 }]);
  assert.ok(has(r.events, 'move-announced'));
  const sound = find(r.events, 'play-move-sound');
  assert.strictEqual(sound.team, 'bravo'); // only the enemy radio hears it
  assert.strictEqual(s.submarines.alpha.awaitingConfirmation, true);
});

test('a trapped sub has no legal moves (forced-surface trigger)', () => {
  const s = game();
  place(s, 'alpha', 0, 0, { path: [{ x: 1, y: 0 }, { x: 0, y: 1 }] });
  assert.deepStrictEqual(E.legalMoves(s, 'alpha'), []);
});

// ---------------------------------------------------------------- torpedo
test('torpedo: direct hit is 2, adjacent is 1, and range/island are enforced', () => {
  let s = game();
  place(s, 'alpha', 5, 5, { systems: { ...s.submarines.alpha.systems, torpedo: 3 } });
  place(s, 'bravo', 6, 5); // 1 cell away -> in blast ring, distance 1 (in range)
  const r = E.fireTorpedo(s, 'alpha', { x: 6, y: 5 });
  assert.ok(r.ok);
  assert.strictEqual(s.submarines.bravo.health, 2); // 4 - 2 direct
  assert.ok(has(r.events, 'torpedo-hit'));
  assert.strictEqual(s.submarines.alpha.systems.torpedo, 0);

  s = game();
  place(s, 'alpha', 5, 5, { systems: { ...s.submarines.alpha.systems, torpedo: 3 } });
  place(s, 'bravo', 7, 5); // Chebyshev 1 from target (6,5) -> 1 dmg
  const r2 = E.fireTorpedo(s, 'alpha', { x: 6, y: 5 });
  assert.ok(r2.ok);
  assert.strictEqual(s.submarines.bravo.health, 3);
});

test('torpedo rejects out-of-range and island targets and uncharged fire', () => {
  const s = game();
  place(s, 'alpha', 1, 1, { systems: { ...s.submarines.alpha.systems, torpedo: 3 } });
  assert.strictEqual(E.fireTorpedo(s, 'alpha', { x: 14, y: 9 }).error.reason, 'out-of-range');
  assert.strictEqual(E.fireTorpedo(s, 'alpha', { x: 2, y: 1 }).error.reason, 'target-island');
  const uncharged = game();
  assert.strictEqual(E.fireTorpedo(uncharged, 'alpha', { x: 1, y: 2 }).error.reason, 'not-charged');
});

test('torpedo can damage the firing sub (self-splash)', () => {
  const s = game();
  place(s, 'alpha', 5, 5, { systems: { ...s.submarines.alpha.systems, torpedo: 3 } });
  place(s, 'bravo', 0, 9);
  const r = E.fireTorpedo(s, 'alpha', { x: 6, y: 5 }); // alpha is Chebyshev 1 from blast
  assert.ok(r.ok);
  assert.strictEqual(s.submarines.alpha.health, 3);
});

// ---------------------------------------------------------------- mine
test('mine: place adjacent, reject non-adjacent/island, detonate blasts', () => {
  const s = game();
  place(s, 'alpha', 5, 5, { systems: { ...s.submarines.alpha.systems, mine: 3 } });
  assert.strictEqual(E.placeMine(s, 'alpha', { x: 8, y: 5 }).error.reason, 'not-adjacent');
  const ok = E.placeMine(s, 'alpha', { x: 6, y: 5 });
  assert.ok(ok.ok);
  assert.deepStrictEqual(s.submarines.alpha.mines, [{ x: 6, y: 5 }]);
  assert.strictEqual(s.submarines.alpha.systems.mine, 0);

  place(s, 'bravo', 6, 5);
  const det = E.detonateMine(s, 'alpha', { x: 6, y: 5 });
  assert.ok(det.ok);
  assert.strictEqual(s.submarines.bravo.health, 2);
  assert.strictEqual(s.submarines.alpha.mines.length, 0);
  assert.strictEqual(E.detonateMine(s, 'alpha', { x: 6, y: 5 }).error.reason, 'no-mine');
});

// ---------------------------------------------------------------- drone
test('drone answers truthfully about a sector', () => {
  const s = game();
  place(s, 'alpha', 1, 1, { systems: { ...s.submarines.alpha.systems, drone: 4 } });
  place(s, 'bravo', 0, 0); // sector 1
  const yes = E.launchDrone(s, 'alpha', sectorOf(0, 0));
  assert.strictEqual(find(yes.events, 'drone-result').payload.inSector, true);

  place(s, 'alpha', 1, 1, { systems: { ...s.submarines.alpha.systems, drone: 4 } });
  const no = E.launchDrone(s, 'alpha', 6);
  assert.strictEqual(find(no.events, 'drone-result').payload.inSector, false);
});

// ---------------------------------------------------------------- sonar
test('sonar requires exactly one true + one false, of different types', () => {
  const s = game();
  place(s, 'alpha', 1, 1, { systems: { ...s.submarines.alpha.systems, sonar: 3 } });
  place(s, 'bravo', 3, 4); // row 4, col 3, sector 1
  E.useSonar(s, 'alpha');
  assert.ok(s.submarines.bravo.pendingSonar);

  // two-true -> rejected
  assert.strictEqual(
    E.resolveSonar(s, 'bravo', [{ type: 'sector', value: 1 }, { type: 'col', value: 3 }]).error.reason,
    'need-one-true-one-false',
  );
  // same-type -> rejected
  assert.strictEqual(
    E.resolveSonar(s, 'bravo', [{ type: 'row', value: 4 }, { type: 'row', value: 9 }]).error.reason,
    'same-type',
  );
  // valid: true sector + false row
  const good = E.resolveSonar(s, 'bravo', [{ type: 'sector', value: 1 }, { type: 'row', value: 9 }], { shuffle: false });
  assert.ok(good.ok);
  assert.strictEqual(find(good.events, 'sonar-result').team, 'alpha');
  assert.strictEqual(s.submarines.bravo.pendingSonar, null);
});

test('sonar gets a unique id and resolveSonar guards on game-over', () => {
  const s = game();
  place(s, 'alpha', 1, 1, { systems: { ...s.submarines.alpha.systems, sonar: 3 } });
  place(s, 'bravo', 3, 4);
  E.useSonar(s, 'alpha');
  assert.ok(typeof s.submarines.bravo.pendingSonar.id === 'number');
  // resolveSonar answered event for the responder + result for the asker
  const r = E.resolveSonar(s, 'bravo', [{ type: 'sector', value: 1 }, { type: 'row', value: 9 }], { shuffle: false });
  assert.ok(has(r.events, 'sonar-answered'));
  // once the game is over, a stale response is rejected
  s.gameOver = true;
  s.submarines.bravo.pendingSonar = { askingTeam: 'alpha', id: 99 };
  assert.strictEqual(E.resolveSonar(s, 'bravo', [{ type: 'sector', value: 1 }, { type: 'row', value: 9 }]).error.reason, 'game-over');
});

test('autoSonarFacts always yields a valid pair', () => {
  const s = game();
  place(s, 'bravo', 7, 3);
  s.submarines.bravo.pendingSonar = { askingTeam: 'alpha' };
  const facts = E.autoSonarFacts(s.submarines.bravo);
  const r = E.resolveSonar(s, 'bravo', facts, { shuffle: false });
  assert.ok(r.ok);
});

// ---------------------------------------------------------------- silence
test('silence moves silently, respects water/trail, allows distance 0', () => {
  let s = game();
  place(s, 'alpha', 5, 5, { systems: { ...s.submarines.alpha.systems, silence: 6 } });
  const r = E.applySilence(s, 'alpha', 'E', 3);
  assert.ok(r.ok);
  assert.deepStrictEqual(s.submarines.alpha.position, { x: 8, y: 5 });
  assert.ok(!has(r.events, 'move-announced')); // silent
  assert.ok(has(r.events, 'silence-used'));
  assert.strictEqual(s.submarines.alpha.systems.silence, 0);

  s = game();
  place(s, 'alpha', 9, 4, { systems: { ...s.submarines.alpha.systems, silence: 6 } });
  assert.strictEqual(E.applySilence(s, 'alpha', 'E', 1).error.reason, 'blocked'); // (10,4) island

  s = game();
  place(s, 'alpha', 5, 5, { systems: { ...s.submarines.alpha.systems, silence: 6 }, path: [{ x: 6, y: 5 }] });
  assert.strictEqual(E.applySilence(s, 'alpha', 'E', 1).error.reason, 'trail');

  s = game();
  place(s, 'alpha', 5, 5, { systems: { ...s.submarines.alpha.systems, silence: 6 } });
  const zero = E.applySilence(s, 'alpha', 'N', 0);
  assert.ok(zero.ok);
  assert.deepStrictEqual(s.submarines.alpha.position, { x: 5, y: 5 });
});

// ---------------------------------------------------------------- engineer
test('engineer: completing a circuit auto-repairs it', () => {
  const s = game();
  ['N', 'S', 'E'].forEach((d) => E.markBreakdown(s, 'alpha', d)); // n1, s1, e1 (circuit A)
  const r = E.markBreakdown(s, 'alpha', 'W'); // w1 completes circuit A
  const dm = find(r.events, 'damage-marked');
  assert.deepStrictEqual(dm.payload.completedCircuits, ['A']);
  assert.deepStrictEqual(s.submarines.alpha.damage, []); // cleared
});

test('engineer: a full direction causes 1 hull damage and resets', () => {
  const s = game();
  ['N', 'N', 'N', 'N'].forEach(() => E.markBreakdown(s, 'alpha', 'N')); // n1..n4
  assert.strictEqual(s.submarines.alpha.damage.length, 4);
  const r = E.markBreakdown(s, 'alpha', 'N'); // no slot free in N
  assert.strictEqual(s.submarines.alpha.health, 3);
  assert.deepStrictEqual(s.submarines.alpha.damage, []);
  assert.ok(has(r.events, 'hull-damage'));
});

// ---------------------------------------------------------------- death
test('mutual kill: the acting team loses the tie', () => {
  const s = game();
  place(s, 'alpha', 5, 5, { health: 2, mines: [{ x: 5, y: 5 }] });
  place(s, 'bravo', 5, 5, { health: 2 });
  const r = E.detonateMine(s, 'alpha', { x: 5, y: 5 });
  assert.ok(r.ok);
  assert.strictEqual(s.gameOver, true);
  assert.strictEqual(s.winner, 'bravo'); // alpha detonated -> loses tie
  assert.strictEqual(find(r.events, 'game-over').payload.winner, 'bravo');
});

// ---------------------------------------------------------------- charge pacing
test('turn-based charge: one system per move', () => {
  const s = game();
  E.applyMove(s, 'alpha', 'S'); // opens the confirm window
  assert.ok(E.chargeSystem(s, 'alpha', 'torpedo').ok);
  assert.strictEqual(E.chargeSystem(s, 'alpha', 'mine').error.reason, 'already-charged');
});

test('live charge: gated by move tokens', () => {
  const s = game('live');
  assert.strictEqual(E.chargeSystem(s, 'alpha', 'torpedo').error.reason, 'no-tokens');
  E.applyMove(s, 'alpha', 'S', { now: 1000 });
  assert.strictEqual(s.submarines.alpha.chargeTokens, 1);
  assert.ok(E.chargeSystem(s, 'alpha', 'torpedo').ok);
  assert.strictEqual(s.submarines.alpha.chargeTokens, 0);
  assert.strictEqual(E.chargeSystem(s, 'alpha', 'torpedo').error.reason, 'no-tokens');
});

test('live move respects cooldown', () => {
  const s = game('live');
  E.applyMove(s, 'alpha', 'S', { now: 1000 });
  assert.strictEqual(E.applyMove(s, 'alpha', 'S', { now: 1500 }).error.reason, 'cooldown');
  assert.ok(E.applyMove(s, 'alpha', 'W', { now: 3000 }).ok);
});

// ---------------------------------------------------------------- surface
test('surface clears trail + breakdowns and announces the sector', () => {
  const s = game();
  place(s, 'alpha', 7, 3, { path: [{ x: 7, y: 2 }], damage: [{ slotId: 'n1' }] });
  const r = E.surface(s, 'alpha', { now: 1000 });
  assert.ok(r.ok);
  assert.deepStrictEqual(s.submarines.alpha.path, []);
  assert.deepStrictEqual(s.submarines.alpha.damage, []);
  assert.strictEqual(s.submarines.alpha.surfaced, true);
  assert.strictEqual(find(r.events, 'surface-announced').payload.sector, sectorOf(7, 3));
  assert.strictEqual(s.submarines.alpha.health, 4); // hull NOT repaired (faithful)
});

// ---------------------------------------------------------------- visibility
// ---------------------------------------------------------------- full match
test('full turn-based sequence: charge over 3 moves, confirm, then sink the enemy', () => {
  const s = game();
  place(s, 'alpha', 5, 5);
  place(s, 'bravo', 5, 4, { health: 2 });

  const doTurn = (dir) => {
    assert.ok(E.applyMove(s, 'alpha', dir).ok, `move ${dir}`);
    assert.ok(E.chargeSystem(s, 'alpha', 'torpedo').ok);
    E.confirmRole(s, 'alpha', 'first-mate');
    E.confirmRole(s, 'alpha', 'engineer');
    const done = E.confirmRole(s, 'alpha', 'radio-operator');
    assert.ok(has(done.events, 'turn-complete'));
    assert.strictEqual(s.submarines.alpha.awaitingConfirmation, false);
  };

  doTurn('N'); // (5,5)->(5,4)? bravo is there but overlap allowed... wait alpha starts 5,5
  // alpha path: after N -> (5,4). Continue north to stay legal (no trail re-cross).
  doTurn('N'); // (5,4)->(5,3)
  doTurn('N'); // (5,3)->(5,2)
  assert.strictEqual(s.submarines.alpha.systems.torpedo, 3);

  const fire = E.fireTorpedo(s, 'alpha', { x: 5, y: 4 }); // direct hit on bravo (2 dmg)
  assert.ok(fire.ok);
  assert.strictEqual(s.gameOver, true);
  assert.strictEqual(s.winner, 'alpha');
});

test('surface clears the confirm window and charge tokens', () => {
  const s = game('live');
  E.applyMove(s, 'alpha', 'S', { now: 1000 });
  assert.strictEqual(s.submarines.alpha.chargeTokens, 1);
  E.surface(s, 'alpha', { now: 2000 });
  assert.strictEqual(s.submarines.alpha.chargeTokens, 0);
  assert.deepStrictEqual(s.submarines.alpha.breakdownQueue, []);
});

test('enemy view hides position/path/systems/mines but shows health + surface', () => {
  const s = game();
  place(s, 'alpha', 5, 5, { mines: [{ x: 6, y: 5 }], surfaced: true, surfacedSector: 3 });
  const view = E.getTeamVisibleState(s, 'bravo');
  assert.strictEqual(view.submarines.alpha.position, null);
  assert.deepStrictEqual(view.submarines.alpha.systems, {});
  assert.strictEqual(view.submarines.alpha.mines, undefined);
  assert.strictEqual(view.submarines.alpha.surfacedSector, 3);
  assert.ok(Array.isArray(view.legalMoves));
});
