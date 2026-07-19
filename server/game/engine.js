// Pure Captain Sonar rules engine. No socket.io, no DB, no timers.
// Every action returns { ok, error?, events } where events are { scope, event, payload }.
//   scope: 'room'  -> everyone in the game
//          'team'  -> payload.team's room (may be the acting team OR the enemy)
//          'actor' -> just the socket that triggered the action
// The socket adapter maps these to io.to(...).emit(...) and re-broadcasts filtered state.
const {
  MAP, START_POSITIONS, MAX_HEALTH, getSystemMax, ENGINEER_SLOTS, CIRCUITS,
  TORPEDO_RANGE, SILENCE_RANGE, MINE_RANGE, REQUIRED_ROLES, DIRECTIONS, BOARD, TUNABLES,
} = require('./constants');
const {
  isWater, inBounds, sectorOf, step, bfsWaterDistance, blastDamageAt, manhattan,
} = require('./map');

const enemyOf = (team) => (team === 'alpha' ? 'bravo' : 'alpha');
const MAX_SECTOR = BOARD.sectorCols * Math.ceil(BOARD.height / BOARD.sectorHeight);

// Monotonic ids so stale timers (sonar auto-answer, turn watchdog) can detect that the
// thing they were scheduled for has since been superseded.
let sonarSeq = 0;

// ---- result builders -------------------------------------------------------
const ok = (events = []) => ({ ok: true, events });
const reject = (action, reason, extra = {}) => ({ ok: false, error: { action, reason, ...extra }, events: [] });

// ---- state -----------------------------------------------------------------
function newSubmarine(team) {
  return {
    position: { ...START_POSITIONS[team] },
    path: [],
    lastMoveDir: null,
    health: MAX_HEALTH,
    alive: true,
    systems: { torpedo: 0, mine: 0, drone: 0, sonar: 0, silence: 0 },
    mines: [],
    damage: [],
    surfaced: false,
    surfacedUntil: null,
    surfacedSector: null,
    // turn-based confirm loop
    awaitingConfirmation: false,
    confirmedRoles: [],
    chargedThisMove: false,
    turnSeq: 0, // bumped per move so a stale watchdog can tell it's a newer turn
    // real-time pacing
    chargeTokens: 0,
    breakdownQueue: [],
    moveCooldownUntil: 0,
    lastActionAt: 0,
    // sonar round-trip
    pendingSonar: null,
    // config
    automatedRoles: [],
  };
}

function initGameState(mode = 'turn-based', sameRoom = false) {
  return {
    submarines: { alpha: newSubmarine('alpha'), bravo: newSubmarine('bravo') },
    mode,
    sameRoom,
    winner: null,
    gameOver: false,
    automatedRoles: {},
    systemPriority: {},
  };
}

// ---- geometry helpers on a sub --------------------------------------------
const trailOf = (sub) => [...sub.path, sub.position];
const isOnTrail = (sub, x, y) => trailOf(sub).some((c) => c.x === x && c.y === y);

function moveLegality(state, team, dir) {
  const sub = state.submarines[team];
  const target = step(sub.position, dir);
  if (!inBounds(target.x, target.y)) return { ok: false, reason: 'edge', target };
  if (MAP[target.y][target.x] === 1) return { ok: false, reason: 'island', target };
  if (isOnTrail(sub, target.x, target.y)) return { ok: false, reason: 'trail', target };
  return { ok: true, target };
}

function legalMoves(state, team) {
  return DIRECTIONS.filter((d) => moveLegality(state, team, d).ok);
}

// ---- combat ---------------------------------------------------------------
// Apply a detonation at `origin` to BOTH subs (self-damage possible). Mutates health.
function resolveBlast(state, origin) {
  const results = [];
  for (const t of ['alpha', 'bravo']) {
    const sub = state.submarines[t];
    const dmg = blastDamageAt(sub.position, origin);
    if (dmg > 0) {
      sub.health = Math.max(0, sub.health - dmg);
      if (sub.health === 0) sub.alive = false;
    }
    results.push({ team: t, damage: dmg, health: sub.health });
  }
  return results;
}

// If anyone is dead, set winner/gameOver. The acting team loses a mutual-kill tie.
function deathCheck(state, actorTeam) {
  if (state.gameOver) return null;
  const aDead = state.submarines.alpha.health <= 0;
  const bDead = state.submarines.bravo.health <= 0;
  if (!aDead && !bDead) return null;
  state.gameOver = true;
  if (aDead && bDead) state.winner = enemyOf(actorTeam);
  else state.winner = aDead ? 'bravo' : 'alpha';
  return { scope: 'room', event: 'game-over', payload: { winner: state.winner } };
}

// ---- movement -------------------------------------------------------------
function applyMove(state, team, dir, opts = {}) {
  if (state.gameOver) return reject('move', 'game-over');
  const now = opts.now ?? Date.now();
  const sub = state.submarines[team];
  if (sub.surfaced) return reject('move', 'surfaced');

  // pacing gate
  if (state.mode === 'live') {
    if (now < sub.moveCooldownUntil) return reject('move', 'cooldown');
    if (sub.breakdownQueue.length >= TUNABLES.MAX_PENDING_BREAKDOWNS) return reject('move', 'crew-behind');
  } else if (sub.awaitingConfirmation) {
    return reject('move', 'awaiting-confirmation');
  }

  const legal = moveLegality(state, team, dir);
  if (!legal.ok) return reject('move', legal.reason);

  sub.path.push({ ...sub.position });
  sub.position = legal.target;
  sub.lastMoveDir = dir;
  sub.turnSeq += 1;

  if (state.mode === 'live') {
    sub.chargeTokens += 1;
    sub.breakdownQueue.push(dir);
    const cd = state.sameRoom ? TUNABLES.MOVE_COOLDOWN_MS_SAME_ROOM : TUNABLES.MOVE_COOLDOWN_MS;
    sub.moveCooldownUntil = now + cd;
  } else {
    sub.awaitingConfirmation = true;
    sub.confirmedRoles = [];
    sub.chargedThisMove = false;
  }

  return ok([
    { scope: 'room', event: 'move-announced', payload: { team, direction: dir, awaitingConfirmation: sub.awaitingConfirmation } },
    { scope: 'team', event: 'play-move-sound', payload: { team, direction: dir }, team: enemyOf(team) },
  ]);
}

// ---- first mate: charge ----------------------------------------------------
function chargeSystem(state, team, system) {
  if (state.gameOver) return reject('charge', 'game-over');
  const sub = state.submarines[team];
  if (sub.systems[system] === undefined) return reject('charge', 'bad-system');
  const max = getSystemMax(system);

  if (state.mode === 'live') {
    if (sub.chargeTokens <= 0) return reject('charge', 'no-tokens');
    if (sub.systems[system] >= max) return reject('charge', 'system-full'); // don't waste a token
    sub.systems[system] += 1;
    sub.chargeTokens -= 1;
  } else {
    if (!sub.awaitingConfirmation) return reject('charge', 'not-awaiting');
    if (sub.chargedThisMove) return reject('charge', 'already-charged');
    if (sub.systems[system] >= max) return reject('charge', 'system-full');
    sub.systems[system] += 1;
    sub.chargedThisMove = true;
  }
  return ok([{ scope: 'team', event: 'system-charged', payload: { team, system, value: sub.systems[system] }, team }]);
}

// ---- engineer: breakdowns + hull damage -----------------------------------
// Unifies the manual + automated paths. `slotId` optional (auto picks first free).
function markBreakdown(state, team, direction, slotId, actorTeam) {
  if (state.gameOver) return reject('mark-damage', 'game-over');
  const sub = state.submarines[team];
  const dirSlots = ENGINEER_SLOTS.filter((s) => s.dir === direction);
  const damagedIds = sub.damage.map((d) => d.slotId);
  const available = dirSlots.filter((s) => !damagedIds.includes(s.id));

  // Cannot mark this direction -> 1 hull damage + reactor reset (faithful rule).
  if (available.length === 0) {
    sub.health = Math.max(0, sub.health - 1);
    if (sub.health === 0) sub.alive = false;
    sub.damage = [];
    const events = [
      { scope: 'team', event: 'damage-marked', payload: { team, slotId: null, direction, completedCircuits: [], finalDamagedSlots: [] }, team },
      { scope: 'room', event: 'hull-damage', payload: { team, source: 'engineering', health: sub.health } },
    ];
    const death = deathCheck(state, actorTeam || team);
    if (death) events.push(death);
    return ok(events);
  }

  const chosen = slotId ? dirSlots.find((s) => s.id === slotId) : available[0];
  if (!chosen || !available.some((s) => s.id === chosen.id)) return reject('mark-damage', 'bad-slot');

  sub.damage.push({ slotId: chosen.id });
  const nowDamaged = sub.damage.map((d) => d.slotId);

  const completedCircuits = [];
  for (const [cid, ids] of Object.entries(CIRCUITS)) {
    if (ids.every((id) => nowDamaged.includes(id))) completedCircuits.push(cid);
  }
  if (completedCircuits.length) {
    const clear = completedCircuits.flatMap((c) => CIRCUITS[c]);
    sub.damage = sub.damage.filter((d) => !clear.includes(d.slotId));
  }

  const events = [];
  // Full reactor (all 16) -> hull damage + reset. Unreachable while circuits auto-clear, kept as a guard.
  if (sub.damage.length >= ENGINEER_SLOTS.length) {
    sub.health = Math.max(0, sub.health - 1);
    if (sub.health === 0) sub.alive = false;
    sub.damage = [];
    events.push({ scope: 'room', event: 'hull-damage', payload: { team, source: 'reactor', health: sub.health } });
  }
  events.push({
    scope: 'team', team,
    event: 'damage-marked',
    payload: { team, slotId: chosen.id, direction, completedCircuits, finalDamagedSlots: sub.damage.map((d) => d.slotId) },
  });
  const death = deathCheck(state, actorTeam || team);
  if (death) events.push(death);
  return ok(events);
}

// ---- confirm loop (turn-based) --------------------------------------------
function confirmRole(state, team, role) {
  if (state.gameOver) return reject('confirm', 'game-over');
  const sub = state.submarines[team];
  if (!sub.confirmedRoles.includes(role)) sub.confirmedRoles.push(role);
  const events = [{ scope: 'room', event: 'role-confirmed', payload: { team, role } }];
  const allDone = REQUIRED_ROLES.every((r) => sub.confirmedRoles.includes(r) || sub.automatedRoles.includes(r));
  if (allDone) {
    sub.awaitingConfirmation = false;
    sub.confirmedRoles = [];
    events.push({ scope: 'room', event: 'turn-complete', payload: { team } });
  }
  return ok(events);
}

// ---- weapons & detection ---------------------------------------------------
function fireTorpedo(state, team, target) {
  if (state.gameOver) return reject('fire-torpedo', 'game-over');
  const sub = state.submarines[team];
  if (sub.surfaced) return reject('fire-torpedo', 'surfaced');
  if (sub.systems.torpedo < getSystemMax('torpedo')) return reject('fire-torpedo', 'not-charged');
  if (!isWater(target.x, target.y)) return reject('fire-torpedo', 'target-island');
  const dist = bfsWaterDistance(sub.position, target);
  if (dist < 1 || dist > TORPEDO_RANGE) return reject('fire-torpedo', 'out-of-range');

  sub.systems.torpedo = 0;
  const results = resolveBlast(state, target);
  const enemyRes = results.find((r) => r.team === enemyOf(team));
  const events = [{ scope: 'room', event: 'blast-resolved', payload: { by: team, weapon: 'torpedo', origin: target, results } }];
  // Legacy events the existing client still binds.
  if (enemyRes.damage > 0) {
    events.push({ scope: 'room', event: 'torpedo-hit', payload: { team, target, damage: enemyRes.damage, enemyHealth: enemyRes.health } });
  } else {
    events.push({ scope: 'room', event: 'torpedo-miss', payload: { team, target } });
  }
  const death = deathCheck(state, team);
  if (death) events.push(death);
  return ok(events);
}

function placeMine(state, team, target) {
  if (state.gameOver) return reject('place-mine', 'game-over');
  const sub = state.submarines[team];
  if (sub.surfaced) return reject('place-mine', 'surfaced');
  if (sub.systems.mine < getSystemMax('mine')) return reject('place-mine', 'not-charged');
  if (!isWater(target.x, target.y)) return reject('place-mine', 'target-island');
  if (manhattan(sub.position, target) !== MINE_RANGE) return reject('place-mine', 'not-adjacent');
  if (sub.mines.some((m) => m.x === target.x && m.y === target.y)) return reject('place-mine', 'mine-exists');
  if (sub.position.x === target.x && sub.position.y === target.y) return reject('place-mine', 'on-self');

  sub.systems.mine = 0;
  sub.mines.push({ x: target.x, y: target.y });
  return ok([{ scope: 'team', team, event: 'mine-placed', payload: { team, x: target.x, y: target.y } }]);
}

function detonateMine(state, team, target) {
  if (state.gameOver) return reject('detonate-mine', 'game-over');
  const sub = state.submarines[team];
  const idx = sub.mines.findIndex((m) => m.x === target.x && m.y === target.y);
  if (idx === -1) return reject('detonate-mine', 'no-mine');
  sub.mines.splice(idx, 1);
  const results = resolveBlast(state, target);
  const events = [{ scope: 'room', event: 'mine-exploded', payload: { team, origin: target, results } }];
  const death = deathCheck(state, team);
  if (death) events.push(death);
  return ok(events);
}

function launchDrone(state, team, sector) {
  if (state.gameOver) return reject('launch-drone', 'game-over');
  const sub = state.submarines[team];
  if (sub.surfaced) return reject('launch-drone', 'surfaced');
  if (sub.systems.drone < getSystemMax('drone')) return reject('launch-drone', 'not-charged');
  if (!Number.isInteger(sector) || sector < 1 || sector > MAX_SECTOR) return reject('launch-drone', 'bad-sector');
  sub.systems.drone = 0;
  const enemy = state.submarines[enemyOf(team)];
  const inSector = sectorOf(enemy.position.x, enemy.position.y) === sector;
  return ok([{ scope: 'team', team, event: 'drone-result', payload: { team, sector, inSector } }]);
}

function useSonar(state, team) {
  if (state.gameOver) return reject('use-sonar', 'game-over');
  const sub = state.submarines[team];
  if (sub.surfaced) return reject('use-sonar', 'surfaced');
  if (sub.systems.sonar < getSystemMax('sonar')) return reject('use-sonar', 'not-charged');
  const enemyTeam = enemyOf(team);
  const enemy = state.submarines[enemyTeam];
  if (enemy.pendingSonar) return reject('use-sonar', 'sonar-pending');
  sub.systems.sonar = 0;
  enemy.pendingSonar = { askingTeam: team, id: ++sonarSeq };
  return ok([{ scope: 'team', team: enemyTeam, event: 'sonar-request', payload: { askingTeam: team } }]);
}

const factIsTrue = (sub, fact) => {
  if (fact.type === 'row') return fact.value === sub.position.y;
  if (fact.type === 'col') return fact.value === sub.position.x;
  if (fact.type === 'sector') return fact.value === sectorOf(sub.position.x, sub.position.y);
  return false;
};

// The responding (enemy) team answers a pending sonar with two facts: exactly one true, one false,
// of two different types. `facts` may come from a human responder or from autoSonarFacts().
function resolveSonar(state, respondingTeam, facts, opts = {}) {
  if (state.gameOver) return reject('sonar-response', 'game-over');
  const sub = state.submarines[respondingTeam];
  if (!sub.pendingSonar) return reject('sonar-response', 'no-pending');
  if (!Array.isArray(facts) || facts.length !== 2) return reject('sonar-response', 'need-two-facts');
  if (!facts[0] || !facts[1] || facts[0].type === facts[1].type) return reject('sonar-response', 'same-type');
  const trueCount = facts.filter((f) => factIsTrue(sub, f)).length;
  if (trueCount !== 1) return reject('sonar-response', 'need-one-true-one-false');

  const askingTeam = sub.pendingSonar.askingTeam;
  sub.pendingSonar = null;
  const out = opts.shuffle === false ? facts : (Math.random() < 0.5 ? facts : [facts[1], facts[0]]);
  return ok([
    { scope: 'team', team: askingTeam, event: 'sonar-result', payload: { facts: out } },
    // Tell the responder their reply was accepted so the client can close the prompt.
    { scope: 'team', team: respondingTeam, event: 'sonar-answered', payload: {} },
  ]);
}

// Auto-generate a valid pair for a stalled / automated responder: one true, one false, different types.
function autoSonarFacts(sub) {
  const trueSector = sectorOf(sub.position.x, sub.position.y);
  const falseRow = (sub.position.y + 1) % BOARD.height;
  return [
    { type: 'sector', value: trueSector },
    { type: 'row', value: falseRow },
  ];
}

function applySilence(state, team, direction, distance) {
  if (state.gameOver) return reject('use-silence', 'game-over');
  const sub = state.submarines[team];
  if (sub.surfaced) return reject('use-silence', 'surfaced');
  if (sub.systems.silence < getSystemMax('silence')) return reject('use-silence', 'not-charged');
  if (!DIRECTIONS.includes(direction)) return reject('use-silence', 'bad-direction');
  if (!Number.isInteger(distance) || distance < 0 || distance > SILENCE_RANGE) return reject('use-silence', 'bad-distance');

  // Validate the whole straight path before committing.
  let cursor = { ...sub.position };
  const path = [];
  for (let i = 0; i < distance; i++) {
    cursor = step(cursor, direction);
    if (!isWater(cursor.x, cursor.y)) return reject('use-silence', 'blocked');
    if (isOnTrail(sub, cursor.x, cursor.y)) return reject('use-silence', 'trail');
    path.push({ ...cursor });
  }

  sub.systems.silence = 0;
  for (const cell of path) {
    sub.path.push({ ...sub.position });
    sub.position = cell;
  }
  return ok([
    { scope: 'team', team, event: 'silence-used', payload: { team, direction, distance, position: { ...sub.position } } },
    // Enemy learns a silence happened, but never the direction/distance/destination.
    { scope: 'team', team: enemyOf(team), event: 'silence-activated', payload: { team } },
  ]);
}

function surface(state, team, opts = {}) {
  if (state.gameOver) return reject('surface', 'game-over');
  const now = opts.now ?? Date.now();
  const sub = state.submarines[team];
  const sector = sectorOf(sub.position.x, sub.position.y);
  sub.path = [];
  sub.damage = [];
  if (TUNABLES.SURFACE_REPAIRS_HULL) sub.health = MAX_HEALTH;
  sub.surfaced = true;
  sub.surfacedSector = sector;
  sub.surfacedUntil = now + TUNABLES.SURFACE_SECONDS * 1000;
  // clear both pacing systems
  sub.awaitingConfirmation = false;
  sub.confirmedRoles = [];
  sub.chargedThisMove = false;
  sub.chargeTokens = 0;
  sub.breakdownQueue = [];
  const evt = opts.forced ? 'forced-surface' : 'surface-announced';
  return ok([{ scope: 'room', event: evt, payload: { team, sector } }]);
}

function resurface(state, team) {
  const sub = state.submarines[team];
  sub.surfaced = false;
  sub.surfacedUntil = null;
  sub.surfacedSector = null;
  return ok([{ scope: 'room', event: 'resurfaced', payload: { team } }]);
}

// ---- visibility ------------------------------------------------------------
function getTeamVisibleState(state, team) {
  const enemyTeam = enemyOf(team);
  const own = state.submarines[team];
  const enemy = state.submarines[enemyTeam];
  return {
    submarines: {
      [team]: own, // full info for own sub
      [enemyTeam]: {
        health: enemy.health,
        alive: enemy.alive,
        position: null,
        path: [],
        systems: {},
        surfaced: enemy.surfaced,
        surfacedSector: enemy.surfaced ? enemy.surfacedSector : null,
      },
    },
    legalMoves: legalMoves(state, team),
    mode: state.mode,
    sameRoom: state.sameRoom,
    winner: state.winner,
    gameOver: state.gameOver,
  };
}

module.exports = {
  enemyOf,
  MAX_SECTOR,
  newSubmarine,
  initGameState,
  trailOf,
  isOnTrail,
  moveLegality,
  legalMoves,
  resolveBlast,
  deathCheck,
  applyMove,
  chargeSystem,
  markBreakdown,
  confirmRole,
  fireTorpedo,
  placeMine,
  detonateMine,
  launchDrone,
  useSonar,
  resolveSonar,
  autoSonarFacts,
  factIsTrue,
  applySilence,
  surface,
  resurface,
  getTeamVisibleState,
};
