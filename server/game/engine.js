// Admiral Undersea's rules: a pure, real-time sim. No sockets, no database, no timers of its own.
// The adapter (sockets/game.js) calls tick() ten times a second and the actions when players play.
//
// Every action and every tick returns events: { scope, team?, event, payload }.
//   scope 'room' -> everyone in the game, 'team' -> that team's room only.
// Most events are { event: 'fx', payload: { type, ... } }: something to see or hear. 'game-over'
// is its own event (the adapter records the result once).
//
// What a boat knows of the other is only what its hydrophones hear (contacts: a bearing wedge from
// where we were, sharper the louder the noise), what its pings return, and the public blasts and hits.
const {
  TEAMS, STATIONS, SECONDS_PER_CELL, HULL_MAX, POWER, TORPEDO, PING, DECOY, VENT, REPAIR_SECONDS,
  FAULT_KINDS, CALL_IDS, TUNING: T,
} = require('./constants');
const {
  getMap, MAP_IDS, stepFrom, bearing, dist, chebyshev, cellOf, sameCell, headingFor,
} = require('./map');

const enemyOf = (team) => (team === 'alpha' ? 'bravo' : 'alpha');
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

// ---- randomness (serialisable, so a stored match carries on the same) -------------------------
function rand(state) {
  state.rng = (state.rng + 0x6d2b79f5) >>> 0;
  let a = state.rng;
  a = Math.imul(a ^ (a >>> 15), a | 1);
  a ^= a + Math.imul(a ^ (a >>> 7), a | 61);
  return ((a ^ (a >>> 14)) >>> 0) / 4294967296;
}
const pick = (state, list) => list[Math.floor(rand(state) * list.length)];
const nextId = (state) => { state.nextId += 1; return state.nextId; };

// ---- results -------------------------------------------------------------------------------
const ok = (events = []) => ({ ok: true, events });
const reject = (action, reason, message) => ({ ok: false, error: { action, reason, ...(message ? { message } : {}) }, events: [] });
const fx = (scope, team, type, data = {}) => ({ scope, ...(scope === 'team' ? { team } : {}), event: 'fx', payload: { type, ...data } });
const teamFx = (team, type, data) => fx('team', team, type, data);
const roomFx = (type, data) => fx('room', null, type, data);

// ---- state ---------------------------------------------------------------------------------
function newBoat(start, map) {
  // Start facing the middle of the chart.
  const heading = headingFor(bearing(start, { x: (map.width - 1) / 2, y: (map.height - 1) / 2 }));
  return {
    x: start.x,
    y: start.y,
    heading,
    ordered: 0,              // the helm's speed order: 0 stop, 1 slow, 2 half, 3 full
    progress: 0,             // towards the next cell
    hull: HULL_MAX,
    power: { ...POWER.start },
    heat: 0,
    scram: 0,                // seconds left with the reactor down
    ventCooldown: 0,
    tubes: [{ state: 'empty', progress: 0 }, { state: 'empty', progress: 0 }],
    decoyCooldown: 0,
    pingCharge: 0,
    faults: [],              // [{ id, kind }]
    repair: null,            // { faultId, left, total }
    floodTime: 0,
    marker: null,            // the team's target mark { x, y, t }
    warned: null,            // the rock we last warned the helm about
    boost: null,             // { system, until }: a crew call for power the auto chief is answering
  };
}

/**
 * A new match. `crew` says, per team, which stations people hold ('human') and which the
 * auto-crew runs ('auto'); a team nobody joined is all auto (the enemy boat when playing the AI).
 */
function initMatch({ mapId, seed = Date.now(), startIndex, crew = {}, vsAi = false, aiSkill = 'green' } = {}) {
  const state = {
    v: 2,
    t: 0,
    rng: seed >>> 0,
    nextId: 0,
    mapId: MAP_IDS.includes(mapId) ? mapId : null,
    vsAi: Boolean(vsAi),
    aiSkill: aiSkill === 'veteran' ? 'veteran' : 'green',
    over: null,
    subs: {},
    torpedoes: [],
    decoys: [],
    whales: [],
    blasts: [],
    contacts: { alpha: [], bravo: [] },
    pings: { alpha: null, bravo: null },
    crew: {},
    away: { alpha: {}, bravo: {} },
    calls: { alpha: {}, bravo: {} },
    ai: { alpha: null, bravo: null },
  };
  if (!state.mapId) state.mapId = pick(state, MAP_IDS);
  const map = getMap(state.mapId);
  const pair = Number.isInteger(startIndex) && map.starts[startIndex] ? map.starts[startIndex] : pick(state, map.starts);
  const flip = rand(state) < 0.5;
  state.subs.alpha = newBoat(flip ? pair[1] : pair[0], map);
  state.subs.bravo = newBoat(flip ? pair[0] : pair[1], map);
  for (const team of TEAMS) {
    state.crew[team] = {};
    for (const s of STATIONS) state.crew[team][s] = crew[team]?.[s] === 'human' ? 'human' : 'auto';
  }
  state.whales = map.whales.map((w) => ({ id: nextId(state), x: w.x, y: w.y, heading: Math.floor(rand(state) * 8), progress: 0, songIn: 3 + rand(state) * 8 }));
  return state;
}

/** Whether a stored object is a match this engine plays. */
const isMatch = (s) => Boolean(s) && typeof s === 'object' && s.v === 2 && Boolean(s.subs?.alpha) && Boolean(s.subs?.bravo);

// ---- what a boat can do right now ----------------------------------------------------------
const hasFault = (b, kind) => b.faults.some((f) => f.kind === kind);
const totalPower = (p) => p.engines + p.sonar + p.tubes;

function effectivePower(b) {
  if (b.scram > 0) return { engines: 0, sonar: 0, tubes: 0 };
  return {
    engines: hasFault(b, 'fire') ? Math.min(b.power.engines, T.FIRE_ENGINE_CAP) : b.power.engines,
    sonar: b.power.sonar,
    tubes: hasFault(b, 'flood') ? 0 : b.power.tubes,
  };
}
const effectiveSpeed = (b) => Math.max(0, Math.min(b.ordered, effectivePower(b).engines, 3));
const isAuto = (state, team, station) => state.crew[team]?.[station] !== 'human' || Boolean(state.away[team]?.[station]);

// ---- noise and hearing -----------------------------------------------------------------------
function hearingRange(b, level) {
  let range = T.HEAR_BASE + T.HEAR_PER_LEVEL * level + T.HEAR_PER_SONAR * effectivePower(b).sonar;
  if (effectiveSpeed(b) >= T.FLOW_NOISE_SPEED) range *= T.FLOW_NOISE_FACTOR;
  if (hasFault(b, 'sonar')) range *= T.SONAR_FAULT_FACTOR;
  if (b.scram > 0) range *= 0.5;
  return range;
}

/** A noise at { x, y }: every boat but its maker's may hear it, as a contact on its plot. */
function emitNoise(state, events, noise) {
  const map = getMap(state.mapId);
  let level = noise.level;
  if (noise.maskable && map.isVent(Math.round(noise.x), Math.round(noise.y))) level -= T.VENT_MASK;
  if (level <= 0 && !noise.exact) return;
  for (const team of TEAMS) {
    if (team === noise.source) continue;
    const b = state.subs[team];
    if (b.hull <= 0) continue;
    const d = dist(b, noise);
    let contact;
    if (noise.exact) {
      contact = { id: nextId(state), t: r1(state.t), kind: noise.kind, exact: true, x: Math.round(noise.x), y: Math.round(noise.y), ox: b.x, oy: b.y, level };
    } else {
      if (d > hearingRange(b, level)) continue;
      const sp = effectivePower(b).sonar;
      const width = clamp((T.WIDTH_BASE - T.WIDTH_PER_LEVEL * level - T.WIDTH_PER_SONAR * sp + T.WIDTH_PER_CELL * d) * (hasFault(b, 'sonar') ? 2 : 1), T.WIDTH_MIN, T.WIDTH_MAX);
      const truth = d < 0.01 ? rand(state) * 360 : bearing(b, noise);
      const told = (truth + (rand(state) * 2 - 1) * width * 0.6 + 360) % 360;
      contact = { id: nextId(state), t: r1(state.t), kind: noise.kind, bearing: r1(told), width: r1(width), ox: b.x, oy: b.y, near: d <= T.NEAR_CELLS, level };
    }
    if (noise.ref !== undefined) contact.ref = noise.ref;
    const list = state.contacts[team];
    list.push(contact);
    if (list.length > T.MAX_CONTACTS) list.splice(0, list.length - T.MAX_CONTACTS);
    events.push(teamFx(team, 'contact', { contact }));
  }
}

// ---- damage --------------------------------------------------------------------------------
function addFaults(state, team, n, events) {
  const b = state.subs[team];
  for (let i = 0; i < n; i++) {
    const free = FAULT_KINDS.filter((k) => !hasFault(b, k));
    if (!free.length) return;
    const kind = pick(state, free);
    b.faults.push({ id: nextId(state), kind });
    if (kind === 'flood') b.floodTime = 0;
    events.push(teamFx(team, 'fault', { kind }));
  }
}

function hurt(state, team, damage, cause, events) {
  const b = state.subs[team];
  if (damage <= 0 || b.hull <= 0) return;
  b.hull = Math.max(0, b.hull - damage);
  events.push(roomFx('hit', { team, damage, hull: b.hull, cause }));
  if (b.hull > 0 && cause !== 'flood') addFaults(state, team, damage, events);
}

function blast(state, at, by, events) {
  const cell = cellOf(at);
  state.blasts.push({ x: cell.x, y: cell.y, t: r1(state.t), by });
  events.push(roomFx('blast', { x: cell.x, y: cell.y, by }));
  for (const team of TEAMS) {
    const b = state.subs[team];
    const gap = chebyshev(b, cell);
    hurt(state, team, gap === 0 ? 2 : gap === 1 ? 1 : 0, 'torpedo', events);
  }
  state.lastBlastBy = by;
}

function checkOver(state, events) {
  if (state.over) return;
  const a = state.subs.alpha.hull <= 0;
  const b = state.subs.bravo.hull <= 0;
  const left = T.MATCH_SECONDS - state.t;
  // The clock: a warning at two minutes and at thirty seconds, then the boat with more hull wins.
  for (const mark of [120, 30]) {
    if (left <= mark && !state.warned?.[mark]) {
      state.warned = { ...(state.warned || {}), [mark]: true };
      events.push(roomFx('clock', { left: mark }));
    }
  }
  if (!a && !b && left > 0) return;
  let winner;
  let how = 'sunk';
  if (a && b) winner = state.lastBlastBy ? enemyOf(state.lastBlastBy) : null;
  else if (a || b) winner = a ? 'bravo' : 'alpha';
  else {
    how = 'clock';
    const ha = state.subs.alpha.hull;
    const hb = state.subs.bravo.hull;
    winner = ha === hb ? null : ha > hb ? 'alpha' : 'bravo';
  }
  state.over = { winner, t: r1(state.t), how };
  for (const team of TEAMS) if (state.subs[team].hull <= 0) events.push(roomFx('sunk', { team }));
  events.push({ scope: 'room', event: 'game-over', payload: { winner } });
}

// ---- the stations' actions -------------------------------------------------------------------
// Each checks only the rules; the adapter has already checked that the player holds the station.
const live = (state, action) => (state.over ? reject(action, 'game-over') : null);

// Helm
function setHeading(state, team, heading) {
  const no = live(state, 'helm');
  if (no) return no;
  if (!Number.isInteger(heading) || heading < 0 || heading > 7) return reject('helm', 'bad-heading');
  const b = state.subs[team];
  if (hasFault(b, 'rudder')) return reject('helm', 'rudder-jammed', 'The rudder is jammed: the engine room has to free it.');
  if (b.heading === heading) return ok();
  b.heading = heading;
  b.warned = null;
  return ok([teamFx(team, 'helm', { heading, speed: b.ordered })]);
}

function turn(state, team, way) {
  if (way !== 1 && way !== -1) return reject('helm', 'bad-turn');
  return setHeading(state, team, (state.subs[team].heading + way + 8) % 8);
}

function setSpeed(state, team, speed) {
  const no = live(state, 'helm');
  if (no) return no;
  if (!Number.isInteger(speed) || speed < 0 || speed > 3) return reject('helm', 'bad-speed');
  const b = state.subs[team];
  if (b.ordered === speed) return ok();
  b.ordered = speed;
  if (speed === 0) b.progress = 0;
  return ok([teamFx(team, 'helm', { heading: b.heading, speed })]);
}

// Listening
function setMarker(state, team, cell) {
  const no = live(state, 'mark');
  if (no) return no;
  const map = getMap(state.mapId);
  const b = state.subs[team];
  if (cell === null) { b.marker = null; return ok([teamFx(team, 'marker', { marker: null })]); }
  if (!cell || !map.inBounds(cell.x, cell.y)) return reject('mark', 'bad-cell');
  const moved = !b.marker || !sameCell(b.marker, cell);
  b.marker = { x: cell.x, y: cell.y, t: r1(state.t) };
  // the same cell again only freshens the mark: nothing to announce
  return ok(moved ? [teamFx(team, 'marker', { marker: b.marker })] : []);
}

function ping(state, team) {
  const no = live(state, 'ping');
  if (no) return no;
  const b = state.subs[team];
  if (hasFault(b, 'sonar')) return reject('ping', 'sonar-damaged', 'The sonar dome is damaged: no pings until it is repaired.');
  if (effectivePower(b).sonar < 2) return reject('ping', 'no-power', 'A ping needs at least 2 power on sonar.');
  if (b.pingCharge < 1) return reject('ping', 'not-charged');
  b.pingCharge = 0;
  const enemy = enemyOf(team);
  const e = state.subs[enemy];
  const near = (p) => dist(b, p) <= PING.radius;
  const found = [];
  if (e.hull > 0 && near(e)) found.push({ kind: 'boat', x: e.x, y: e.y });
  for (const w of state.whales) if (near(w)) found.push({ kind: 'bio', x: w.x, y: w.y });
  for (const d of state.decoys) if (d.team === enemy && near(d)) found.push({ kind: 'small', x: d.x, y: d.y });
  for (const tp of state.torpedoes) if (tp.team === enemy && near(tp)) found.push({ kind: 'torpedo', x: Math.round(tp.x), y: Math.round(tp.y) });
  state.pings[team] = { t: r1(state.t), x: b.x, y: b.y, radius: PING.radius, found };
  const events = [teamFx(team, 'ping-result', { ping: state.pings[team] })];
  // The ping rings through the whole sea: the enemy hears exactly where it came from.
  emitNoise(state, events, { x: b.x, y: b.y, level: 5, kind: 'ping', source: team, exact: true });
  events.push(teamFx(enemy, 'pinged', {}));
  return ok(events);
}

// Torpedo room
function loadTube(state, team, tube) {
  const no = live(state, 'load');
  if (no) return no;
  const b = state.subs[team];
  const tb = b.tubes[tube];
  if (!tb) return reject('load', 'bad-tube');
  if (tb.state !== 'empty') return reject('load', 'tube-busy');
  tb.state = 'loading';
  tb.progress = 0;
  return ok([teamFx(team, 'tube-loading', { tube })]);
}

function fire(state, team, tube, target) {
  const no = live(state, 'fire');
  if (no) return no;
  const map = getMap(state.mapId);
  const b = state.subs[team];
  const tb = b.tubes[tube];
  if (!tb) return reject('fire', 'bad-tube');
  if (tb.state !== 'ready') return reject('fire', 'not-loaded', 'That tube is not loaded yet.');
  if (!target || !map.inBounds(target.x, target.y)) return reject('fire', 'bad-target');
  if (sameCell(b, target)) return reject('fire', 'own-cell', 'That is our own position.');
  if (dist(b, target) > TORPEDO.range) return reject('fire', 'out-of-range', `Out of range: torpedoes run ${TORPEDO.range} cells.`);
  tb.state = 'empty';
  tb.progress = 0;
  const tp = { id: nextId(state), team, tube, x: b.x, y: b.y, tx: target.x, ty: target.y, run: 0, noiseIn: T.TORPEDO_NOISE_EVERY };
  state.torpedoes.push(tp);
  const events = [teamFx(team, 'fired', { tube, id: tp.id, tx: tp.tx, ty: tp.ty })];
  emitNoise(state, events, { x: b.x, y: b.y, level: 5, kind: 'launch', source: team, ref: tp.id });
  return ok(events);
}

function guide(state, team, torpedoId, target) {
  const no = live(state, 'guide');
  if (no) return no;
  const map = getMap(state.mapId);
  const tp = state.torpedoes.find((x) => x.id === torpedoId && x.team === team);
  if (!tp) return reject('guide', 'no-torpedo');
  if (!target || !map.inBounds(target.x, target.y)) return reject('guide', 'bad-target');
  tp.tx = target.x;
  tp.ty = target.y;
  return ok([teamFx(team, 'guided', { id: tp.id, tx: tp.tx, ty: tp.ty })]);
}

function launchDecoy(state, team, heading) {
  const no = live(state, 'decoy');
  if (no) return no;
  const b = state.subs[team];
  if (!Number.isInteger(heading) || heading < 0 || heading > 7) return reject('decoy', 'bad-heading');
  if (b.decoyCooldown > 0) return reject('decoy', 'not-ready');
  b.decoyCooldown = DECOY.rechargeSeconds;
  const d = { id: nextId(state), team, x: b.x, y: b.y, heading, progress: 0, life: DECOY.lifeSeconds, noiseIn: 0.3 };
  state.decoys.push(d);
  return ok([teamFx(team, 'decoy-out', { id: d.id, heading })]);
}

// Engine room
function setPower(state, team, power) {
  const no = live(state, 'power');
  if (no) return no;
  if (!power || typeof power !== 'object') return reject('power', 'bad-power');
  const next = {};
  for (const k of ['engines', 'sonar', 'tubes']) {
    const v = power[k];
    if (!Number.isInteger(v) || v < 0 || v > POWER.perSystemMax) return reject('power', 'bad-power');
    next[k] = v;
  }
  if (totalPower(next) > POWER.max) return reject('power', 'over-max', `The reactor gives at most ${POWER.max}.`);
  const b = state.subs[team];
  const changed = ['engines', 'sonar', 'tubes'].some((k) => b.power[k] !== next[k]);
  b.power = next;
  return ok(changed ? [teamFx(team, 'power', { power: next })] : []);
}

function startRepair(state, team, faultId, { auto = false } = {}) {
  const no = live(state, 'repair');
  if (no) return no;
  const b = state.subs[team];
  const f = b.faults.find((x) => x.id === faultId);
  if (!f) return reject('repair', 'no-fault');
  if (b.repair && b.repair.faultId === faultId) return ok();
  const total = auto ? REPAIR_SECONDS.auto : REPAIR_SECONDS.crew;
  b.repair = { faultId, kind: f.kind, left: total, total };
  return ok([teamFx(team, 'repairing', { kind: f.kind })]);
}

function vent(state, team) {
  const no = live(state, 'vent');
  if (no) return no;
  const b = state.subs[team];
  if (b.ventCooldown > 0) return reject('vent', 'not-ready');
  b.ventCooldown = VENT.cooldownSeconds;
  b.heat = Math.max(0, b.heat - VENT.heat);
  const events = [teamFx(team, 'vented', {})];
  emitNoise(state, events, { x: b.x, y: b.y, level: 3, kind: 'vent', source: team, maskable: true });
  return ok(events);
}

// Any station: a crew call to the rest of the boat (and orders for the auto-crew).
function call(state, team, station, callId) {
  const no = live(state, 'call');
  if (no) return no;
  if (!CALL_IDS.includes(callId) || !STATIONS.includes(station)) return reject('call', 'bad-call');
  const last = state.calls[team][station] ?? -Infinity;
  if (state.t - last < T.CALL_COOLDOWN) return reject('call', 'too-soon');
  state.calls[team][station] = state.t;
  const b = state.subs[team];
  if (callId.startsWith('power-')) b.boost = { system: callId.slice(6), until: state.t + T.CALL_BOOST_SECONDS };
  const brain = state.ai[team];
  if (brain) {
    if (callId === 'evade') brain.evadeUntil = state.t + 6;
    if (callId === 'go-quiet') brain.quietUntil = state.t + 20;
    if (callId === 'hold-fire') brain.holdUntil = state.t + 20;
    if (callId === 'fire-when-ready') brain.holdUntil = 0;
    if (callId === 'ping-now') brain.pingAsked = true;
  }
  return ok([teamFx(team, 'call', { station, call: callId })]);
}

// ---- the clock ---------------------------------------------------------------------------------
function tickBoat(state, team, dt, events) {
  const b = state.subs[team];
  if (b.hull <= 0) return;
  const map = getMap(state.mapId);

  // Reactor: overdrive heats it, a fire heats it, too hot scrams it.
  if (b.scram > 0) {
    b.scram -= dt;
    b.heat = Math.max(0, b.heat - T.HEAT_COOL * dt);
    if (b.scram <= 0) { b.scram = 0; events.push(teamFx(team, 'power-up', {})); }
  } else {
    const total = totalPower(b.power);
    let rate = total > POWER.base ? (total - POWER.base) * T.HEAT_PER_OVER_POWER : -T.HEAT_COOL;
    if (hasFault(b, 'fire')) rate += T.HEAT_FIRE;
    const before = b.heat;
    b.heat = clamp(b.heat + rate * dt, 0, 100);
    if (before < 75 && b.heat >= 75) events.push(teamFx(team, 'heat-warning', {}));
    if (b.heat >= 100) {
      b.scram = T.SCRAM_SECONDS;
      b.heat = T.HEAT_AFTER_SCRAM;
      events.push(teamFx(team, 'scram', {}));
    }
  }
  b.ventCooldown = Math.max(0, b.ventCooldown - dt);
  b.decoyCooldown = Math.max(0, b.decoyCooldown - dt);
  if (b.boost && b.boost.until <= state.t) b.boost = null;

  const eff = effectivePower(b);

  // Ping charge: needs 2 power on sonar and a whole dome.
  if (eff.sonar >= 2 && !hasFault(b, 'sonar') && b.pingCharge < 1) {
    b.pingCharge = Math.min(1, b.pingCharge + dt / PING.chargeSeconds[String(Math.min(eff.sonar, 4))]);
  }

  // Tubes: the power on tubes is shared between the tubes loading.
  const loading = b.tubes.filter((tb) => tb.state === 'loading');
  if (loading.length && eff.tubes > 0) {
    const rate = eff.tubes / TORPEDO.loadSecondsAtOnePower / loading.length;
    b.tubes.forEach((tb, i) => {
      if (tb.state !== 'loading') return;
      tb.progress = Math.min(1, tb.progress + rate * dt);
      if (tb.progress >= 1) { tb.state = 'ready'; events.push(teamFx(team, 'tube-loaded', { tube: i })); }
    });
  }

  // Damage control.
  if (b.repair) {
    if (!b.faults.some((f) => f.id === b.repair.faultId)) b.repair = null;
    else {
      b.repair.left -= dt;
      if (b.repair.left <= 0) {
        const kind = b.repair.kind;
        b.faults = b.faults.filter((f) => f.id !== b.repair.faultId);
        if (kind === 'flood') b.floodTime = 0;
        b.repair = null;
        events.push(teamFx(team, 'repaired', { kind }));
      }
    }
  }
  if (hasFault(b, 'flood')) {
    b.floodTime += dt;
    if (b.floodTime >= T.FLOOD_DAMAGE_SECONDS) {
      b.floodTime = 0;
      hurt(state, team, 1, 'flood', events);
    }
  }

  // Way on: one cell at a time, a speed's time per cell (a diagonal takes longer).
  const speed = effectiveSpeed(b);
  if (speed <= 0) return;
  const step = stepFrom(map, b, b.heading);
  const diagonal = b.heading % 2 === 1;
  b.progress += dt / (SECONDS_PER_CELL[speed] * (diagonal ? 1.41 : 1));
  // The helm hears of a rock a whole cell before the boat reaches it.
  if (!step.ok) {
    const k = `${b.x},${b.y},${b.heading}`;
    if (b.warned !== k) { b.warned = k; events.push(teamFx(team, 'rocks-ahead', {})); }
  }
  if (b.progress < 1) return;
  b.progress = 0;
  if (!step.ok) {
    b.ordered = 0;
    b.warned = null;
    // Only a boat at full speed hurts itself; slower, it bumps and stops.
    if (speed >= 3) {
      events.push(teamFx(team, 'collision', { damage: 1 }));
      emitNoise(state, events, { x: b.x, y: b.y, level: 4, kind: 'scrape', source: team });
      hurt(state, team, 1, 'rock', events);
    } else {
      events.push(teamFx(team, 'collision', { damage: 0 }));
    }
    return;
  }
  b.x = step.to.x;
  b.y = step.to.y;
  b.warned = null;
  emitNoise(state, events, { x: b.x, y: b.y, level: speed, kind: 'hull', source: team, maskable: true });
}

function tickTorpedoes(state, dt, events) {
  const map = getMap(state.mapId);
  const gone = new Set();
  for (const tp of state.torpedoes) {
    const target = { x: tp.tx, y: tp.ty };
    const stepLen = TORPEDO.speed * dt;
    const left = dist(tp, target);
    let detonateAt = null;
    if (left <= stepLen) {
      tp.x = target.x;
      tp.y = target.y;
      tp.run += left;
      detonateAt = target;
    } else {
      tp.x += ((target.x - tp.x) / left) * stepLen;
      tp.y += ((target.y - tp.y) / left) * stepLen;
      tp.run += stepLen;
      const cell = cellOf(tp);
      if (!map.isWater(cell.x, cell.y)) detonateAt = cell;
      else if (tp.run >= TORPEDO.armAfter) {
        for (const team of TEAMS) {
          const b = state.subs[team];
          if (b.hull > 0 && sameCell(b, cell)) { detonateAt = cell; break; }
        }
      }
    }
    if (detonateAt) {
      gone.add(tp.id);
      blast(state, detonateAt, tp.team, events);
      continue;
    }
    if (tp.run >= TORPEDO.maxRun) {
      gone.add(tp.id);
      events.push(teamFx(tp.team, 'torpedo-spent', { id: tp.id }));
      continue;
    }
    tp.noiseIn -= dt;
    if (tp.noiseIn <= 0) {
      tp.noiseIn = T.TORPEDO_NOISE_EVERY;
      emitNoise(state, events, { x: tp.x, y: tp.y, level: 4, kind: 'torpedo', source: tp.team, ref: tp.id });
    }
  }
  if (gone.size) state.torpedoes = state.torpedoes.filter((tp) => !gone.has(tp.id));
}

function tickDecoys(state, dt, events) {
  const map = getMap(state.mapId);
  for (const d of state.decoys) {
    d.life -= dt;
    d.progress += dt / DECOY.secondsPerCell;
    if (d.progress >= 1) {
      d.progress = 0;
      const s = stepFrom(map, d, d.heading);
      if (s.ok) { d.x = s.to.x; d.y = s.to.y; }
    }
    d.noiseIn -= dt;
    if (d.noiseIn <= 0 && d.life > 0) {
      d.noiseIn = T.DECOY_NOISE_EVERY;
      // A decoy sounds like a boat at full speed: that is the point of it.
      emitNoise(state, events, { x: d.x, y: d.y, level: 3, kind: 'hull', source: d.team, maskable: true });
    }
  }
  state.decoys = state.decoys.filter((d) => d.life > 0);
}

function tickWhales(state, dt, events) {
  const map = getMap(state.mapId);
  for (const w of state.whales) {
    w.progress += dt / T.WHALE_SECONDS_PER_CELL;
    if (w.progress >= 1) {
      w.progress = 0;
      if (rand(state) < 0.2) w.heading = (w.heading + (rand(state) < 0.5 ? 1 : 7)) % 8;
      let s = stepFrom(map, w, w.heading);
      for (let tries = 0; !s.ok && tries < 8; tries++) {
        w.heading = Math.floor(rand(state) * 8);
        s = stepFrom(map, w, w.heading);
      }
      if (s.ok) { w.x = s.to.x; w.y = s.to.y; }
    }
    w.songIn -= dt;
    if (w.songIn <= 0) {
      w.songIn = T.WHALE_SONG_MIN + rand(state) * (T.WHALE_SONG_MAX - T.WHALE_SONG_MIN);
      emitNoise(state, events, { x: w.x, y: w.y, level: 3, kind: 'bio', source: null });
    }
  }
}

/**
 * Advance the match by `dt` seconds. `brains` (the auto-crew, ai.js) is passed in by the caller so
 * the rules stay testable on their own; without it nobody acts for the empty stations.
 */
function tick(state, dt = T.TICK_SECONDS, brains = null) {
  if (state.over) return [];
  const events = [];
  state.t += dt;
  for (const team of TEAMS) tickBoat(state, team, dt, events);
  tickTorpedoes(state, dt, events);
  tickDecoys(state, dt, events);
  tickWhales(state, dt, events);
  checkOver(state, events);

  const ttl = state.t - T.CONTACT_TTL;
  for (const team of TEAMS) {
    const list = state.contacts[team];
    if (list.length && list[0].t < ttl) state.contacts[team] = list.filter((c) => c.t >= ttl);
  }
  if (state.blasts.length && state.blasts[0].t < state.t - T.BLAST_TTL) state.blasts = state.blasts.filter((x) => x.t >= state.t - T.BLAST_TTL);

  if (brains && !state.over) {
    // Neither crew always hears the other's latest move first.
    for (const team of rand(state) < 0.5 ? TEAMS : [TEAMS[1], TEAMS[0]]) {
      const auto = STATIONS.filter((s) => isAuto(state, team, s));
      if (state.subs[team].hull > 0) brains.run(state, team, auto, events, ACTIONS);
    }
    checkOver(state, events);
  }
  return events;
}

// ---- what each team sees -------------------------------------------------------------------
function teamView(state, team, { contacts = false } = {}) {
  const b = state.subs[team];
  const enemy = enemyOf(team);
  const crew = {};
  for (const s of STATIONS) crew[s] = isAuto(state, team, s) ? 'auto' : 'human';
  const view = {
    v: 2,
    t: r1(state.t),
    mapId: state.mapId,
    team,
    vsAi: state.vsAi,
    over: state.over,
    boat: {
      x: b.x,
      y: b.y,
      heading: b.heading,
      ordered: b.ordered,
      speed: effectiveSpeed(b),
      progress: r2(b.progress),
      hull: b.hull,
      power: b.power,
      eff: effectivePower(b),
      heat: Math.round(b.heat),
      scram: r1(b.scram),
      ventCooldown: r1(b.ventCooldown),
      tubes: b.tubes.map((tb) => ({ state: tb.state, progress: r2(tb.progress) })),
      decoyCooldown: r1(b.decoyCooldown),
      pingCharge: r2(b.pingCharge),
      faults: b.faults,
      repair: b.repair ? { faultId: b.repair.faultId, kind: b.repair.kind, left: r1(b.repair.left), total: b.repair.total } : null,
      floodTime: r1(b.floodTime),
      marker: b.marker,
      boost: b.boost,
    },
    enemy: { hull: state.subs[enemy].hull },
    torpedoes: state.torpedoes.filter((tp) => tp.team === team).map((tp) => ({ id: tp.id, x: r2(tp.x), y: r2(tp.y), tx: tp.tx, ty: tp.ty, run: r1(tp.run) })),
    decoys: state.decoys.filter((d) => d.team === team).map((d) => ({ id: d.id, x: d.x, y: d.y, life: r1(d.life) })),
    blasts: state.blasts,
    ping: state.pings[team],
    crew,
  };
  if (contacts) view.contacts = state.contacts[team];
  return view;
}

const ACTIONS = {
  setHeading, turn, setSpeed, setMarker, ping, loadTube, fire, guide, launchDecoy, setPower, startRepair, vent, call,
};

module.exports = {
  enemyOf,
  rand,
  initMatch,
  isMatch,
  tick,
  teamView,
  effectivePower,
  effectiveSpeed,
  hearingRange,
  hasFault,
  isAuto,
  emitNoise,
  blast,
  addFaults,
  ACTIONS,
  ...ACTIONS,
};
