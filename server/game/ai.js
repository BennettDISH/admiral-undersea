// The auto-crew: runs every station nobody holds (and the whole enemy boat when playing the AI).
// It knows only what its own team knows: the contacts its hydrophones heard, its pings, the public
// blasts and the enemy's hull. From those it keeps a belief map of where the enemy could be (a grid
// of chances, spread a little every second as the enemy could have moved, and sharpened by every
// bearing), and each station acts on it about twice a second, like a steady crewman would.
const engine = require('./engine');
const {
  HULL_MAX, PING, TORPEDO, TUNING: T,
} = require('./constants');
const {
  getMap, stepFrom, bearing, angleDiff, dist, chebyshev, sameCell, headingFor, routeTo, waterCells, cellsAlong,
} = require('./map');

const FAULT_ORDER = ['flood', 'fire', 'sonar', 'rudder'];

// How sharp a crew is. A boat's own auto stations (covering for its people) are a steady crew;
// against the AI, the enemy boat's crew is Easy, Normal or Hard, picked on the deck.
//   think        seconds between looks at the plot: how fast it reacts
//   attention    the share of what its hydrophones hear that it takes in, and blur, how much wider
//                than it is it reads each bearing: how well it listens
//   aimJitter    the chance a shot goes a cell off the mark: how well it aims
//   fireConf     how sure of the mark it wants to be before it shoots
//   snap         whether it shoots straight back at a loud contact (a boat at Full, a ping, a
//                launch) while it is only snapConf sure: the reason charging in loses
//   shotSpacing  seconds between its shots; pingAfter, fireAfter: seconds before it pings or shoots
//   evade        'quiet' (slow across a torpedo's path, half if it knows where we are) or 'run'
//                (Full: loud, and a torpedo's seeker hears it), and decoy, the chance it throws one
//   patrol, approach  its speed searching and closing on a mark; listenStops: it stops to listen
const SKILLS = {
  steady: {
    think: 0.5, attention: 1, blur: 1, aimJitter: 0.3, fireConf: 0.3, snap: true, snapConf: 0.12, shotSpacing: 6,
    pingAfter: 0, fireAfter: 0, evade: 'quiet', decoy: 1, patrol: 1, approach: 2, listenStops: false,
  },
  easy: {
    think: 1.1, attention: 0.55, blur: 1.6, aimJitter: 0.6, fireConf: 0.5, snap: false, snapConf: 1, shotSpacing: 18,
    pingAfter: 75, fireAfter: 60, evade: 'run', decoy: 0, patrol: 2, approach: 2, listenStops: false,
  },
  normal: {
    think: 0.7, attention: 0.9, blur: 1.1, aimJitter: 0.35, fireConf: 0.35, snap: true, snapConf: 0.15, shotSpacing: 9,
    pingAfter: 25, fireAfter: 10, evade: 'quiet', decoy: 0.6, patrol: 1, approach: 1, listenStops: true,
  },
  hard: {
    think: 0.45, attention: 1, blur: 0.85, aimJitter: 0.15, fireConf: 0.3, snap: true, snapConf: 0.1, shotSpacing: 7,
    pingAfter: 10, fireAfter: 0, evade: 'quiet', decoy: 1, patrol: 1, approach: 1, listenStops: true,
  },
};

function skillOf(state, team) {
  if (state.vsAi && team === 'bravo') return SKILLS[engine.skillName(state.aiSkill)];
  return SKILLS.steady;
}

function newBrain(state, team) {
  const map = getMap(state.mapId);
  const own = state.subs[team];
  const belief = new Array(map.width * map.height).fill(0);
  for (const c of waterCells(map)) belief[c.y * map.width + c.x] = dist(own, c) > 5 ? 1 : 0.15;
  normalise(belief);
  return {
    belief,
    best: null,
    conf: 0,
    lastContact: 0,
    lastPingT: -1,
    lastBlastT: -1,
    enemyHull: HULL_MAX,
    nextDiffuse: state.t + 1,
    nextThink: state.t,
    threatAt: -99,
    threatBearing: 0,
    decoyThisTime: false,
    loudAt: -99,           // when we last heard the enemy loud: Full, a ping, a launch, a scrape
    exposedUntil: 0,       // they know where we are (we fired or pinged, or they pinged us)
    stopUntil: 0,
    nextStop: state.t + 15,
    evadeUntil: 0,
    evadeHeading: null,
    evadeSet: -99,
    quietUntil: 0,
    holdUntil: 0,
    pingAsked: false,
    lastShot: -99,
    lastPing: -99,
    lastMark: -99,
    waypoint: null,
    waypointUntil: 0,
  };
}

function normalise(b) {
  let sum = 0;
  for (const v of b) sum += v;
  if (sum <= 0) return false;
  for (let i = 0; i < b.length; i++) b[i] /= sum;
  return true;
}

function resetUniform(belief, map) {
  belief.fill(0);
  for (const c of waterCells(map)) belief[c.y * map.width + c.x] = 1;
  normalise(belief);
}

// ---- what we learn -------------------------------------------------------------------------
function forEachWater(map, fn) {
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) if (map.isWater(x, y)) fn(x, y, y * map.width + x);
  }
}

function sharpen(brain, map, likelihood) {
  const b = brain.belief;
  forEachWater(map, (x, y, i) => { b[i] *= likelihood(x, y); });
  if (!normalise(b)) resetUniform(b, map);
}

function learnBearing(brain, map, c, maxRange) {
  const from = { x: c.ox, y: c.oy };
  sharpen(brain, map, (x, y) => {
    const d = dist(from, { x, y });
    let l;
    if (d < 0.5) l = 0.5;
    else {
      const gap = Math.abs(angleDiff(bearing(from, { x, y }), c.bearing));
      l = gap <= c.width ? 1 : Math.max(0.02, Math.exp(-(gap - c.width) / 10));
    }
    if (d > maxRange + 1) l *= 0.15;
    if (c.near && d > T.NEAR_CELLS + 1) l *= 0.1;
    return l;
  });
}

function learnExact(brain, map, cell) {
  sharpen(brain, map, (x, y) => {
    const gap = chebyshev(cell, { x, y });
    return gap === 0 ? 1 : gap === 1 ? 0.12 : 0.0005;
  });
}

function diffuse(brain, map) {
  const b = brain.belief;
  const next = new Array(b.length).fill(0);
  let water = 0;
  forEachWater(map, (x, y, i) => {
    water += 1;
    let sum = b[i];
    let n = 1;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if ((dx || dy) && map.isWater(x + dx, y + dy)) { sum += b[(y + dy) * map.width + x + dx]; n += 1; }
      }
    }
    next[i] = 0.55 * b[i] + 0.45 * (sum / n);
  });
  forEachWater(map, (x, y, i) => { b[i] = 0.995 * next[i] + 0.005 / water; });
  normalise(b);
}

function estimate(brain, map) {
  const b = brain.belief;
  let best = null;
  let mass = -1;
  forEachWater(map, (x, y) => {
    let m = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) if (map.isWater(x + dx, y + dy)) m += b[(y + dy) * map.width + x + dx];
    }
    if (m > mass) { mass = m; best = { x, y }; }
  });
  // the most likely single cell inside the best 3x3
  if (best) {
    let top = -1;
    let cell = best;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = best.x + dx;
        const y = best.y + dy;
        if (map.isWater(x, y) && b[y * map.width + x] > top) { top = b[y * map.width + x]; cell = { x, y }; }
      }
    }
    best = cell;
  }
  brain.best = best;
  brain.conf = mass;
}

function massWithin(brain, map, at, radius) {
  let m = 0;
  forEachWater(map, (x, y, i) => { if (dist(at, { x, y }) <= radius) m += brain.belief[i]; });
  return m;
}

/** Take in everything new this team has heard and seen since the last look. */
function observe(state, team, brain) {
  const map = getMap(state.mapId);
  const own = state.subs[team];
  const enemy = engine.enemyOf(team);

  if (state.t >= brain.nextDiffuse) {
    const steps = Math.min(5, Math.floor(state.t - brain.nextDiffuse) + 1);
    for (let i = 0; i < steps; i++) diffuse(brain, map);
    brain.nextDiffuse = state.t + 1;
  }

  const skill = skillOf(state, team);
  for (const c of state.contacts[team]) {
    if (c.id <= brain.lastContact) continue;
    brain.lastContact = c.id;
    if (c.kind === 'bio') continue; // a whale; the crew knows the song
    // An inattentive crew misses some of what comes in (never a torpedo, a launch or a ping).
    const urgent = c.kind === 'torpedo' || c.kind === 'launch' || c.kind === 'ping';
    if (!urgent && skill.attention < 1 && engine.rand(state) > skill.attention) continue;
    if (c.kind === 'torpedo' || c.kind === 'launch') {
      if (state.t - brain.threatAt > 5) brain.decoyThisTime = skill.decoy >= 1 || (skill.decoy > 0 && engine.rand(state) < skill.decoy);
      brain.threatAt = state.t;
      brain.threatBearing = c.bearing ?? bearing(own, c);
    }
    if (c.kind === 'ping') {
      // They know exactly where we are: break away across their line before a torpedo comes.
      brain.evadeUntil = state.t + 4;
      brain.exposedUntil = state.t + 10;
      brain.threatBearing = bearing(own, c);
      brain.evadeHeading = null;
    }
    if (c.kind === 'torpedo') continue; // where a torpedo is, not the boat
    if (c.exact || c.kind === 'launch' || c.kind === 'scrape' || (c.kind === 'hull' && (c.level ?? 0) >= 3)) brain.loudAt = state.t;
    if (c.exact) learnExact(brain, map, { x: c.x, y: c.y });
    else learnBearing(brain, map, skill.blur === 1 ? c : { ...c, width: c.width * skill.blur }, engine.hearingRange(own, c.level || 2));
  }

  const p = state.pings[team];
  if (p && p.t > brain.lastPingT) {
    brain.lastPingT = p.t;
    const boat = p.found.find((f) => f.kind === 'boat');
    if (boat) learnExact(brain, map, boat);
    else sharpen(brain, map, (x, y) => (dist(p, { x, y }) <= p.radius ? 0.03 : 1));
  }

  const hull = state.subs[enemy].hull;
  const hit = hull < brain.enemyHull;
  brain.enemyHull = hull;
  const fresh = state.blasts.filter((x) => x.t > brain.lastBlastT);
  if (fresh.length) {
    brain.lastBlastT = Math.max(...fresh.map((x) => x.t));
    for (const blast of fresh) {
      if (hit) sharpen(brain, map, (x, y) => (chebyshev(blast, { x, y }) <= 1 ? 6 : 0.2));
      else sharpen(brain, map, (x, y) => (chebyshev(blast, { x, y }) <= 1 ? 0.05 : 1));
    }
  }
  estimate(brain, map);
}

// ---- what we do ----------------------------------------------------------------------------
function clearShot(map, from, to) {
  return cellsAlong(from, to).every((c) => map.isWater(c.x, c.y));
}

function okHeading(map, at, heading) {
  return stepFrom(map, at, heading).ok;
}

function firstOkHeading(map, at, prefs) {
  for (const h of prefs) if (okHeading(map, at, ((h % 8) + 8) % 8)) return ((h % 8) + 8) % 8;
  for (let h = 0; h < 8; h++) if (okHeading(map, at, h)) return h;
  return null;
}

function planPower(state, team, brain, evading) {
  const b = state.subs[team];
  const loading = b.tubes.some((tb) => tb.state === 'loading');
  const p = evading
    ? { engines: 4, sonar: 1, tubes: 1 }
    : { engines: Math.max(1, b.ordered), sonar: 2, tubes: loading ? 3 : 1 };
  if (b.ordered > p.engines) p.engines = Math.min(4, b.ordered);
  if (b.boost && p[b.boost.system] !== undefined) p[b.boost.system] = 4;
  const budget = b.heat >= 70 ? 6 : b.heat >= 50 ? 6 : 7;
  const order = ['tubes', 'sonar', 'engines'];
  let guard = 12;
  while (p.engines + p.sonar + p.tubes > budget && guard-- > 0) {
    for (const k of order) {
      if (p.engines + p.sonar + p.tubes <= budget) break;
      const floor = k === 'engines' ? Math.min(b.ordered, 3) : k === 'sonar' ? (evading ? 0 : 1) : 0;
      if (b.boost?.system === k) continue;
      if (p[k] > floor) p[k] -= 1;
    }
  }
  return p;
}

function act(state, team, auto, A, out) {
  const brain = state.ai[team];
  const b = state.subs[team];
  const map = getMap(state.mapId);
  const want = (fn) => {
    const r = fn();
    if (r.ok) out.push(...r.events);
    return r.ok;
  };
  const skill = skillOf(state, team);
  const threat = state.t - brain.threatAt < 5;
  const evading = threat || brain.evadeUntil > state.t;
  // A loud contact a moment ago (a boat at Full, a ping, a launch): worth a quick shot down it.
  const loud = state.t - (brain.loudAt ?? -99) <= 3;
  const snapping = skill.snap && loud;
  const autoListener = engine.isAuto(state, team, 'listener');

  // Listening: mark the best guess, ping when lost and the enemy is likely close.
  if (auto.includes('listener')) {
    const sure = brain.conf >= 0.2 || (snapping && brain.conf >= skill.snapConf);
    if (brain.best && sure && (!b.marker || !sameCell(b.marker, brain.best) || state.t - brain.lastMark > 5)) {
      want(() => A.setMarker(state, team, brain.best));
      brain.lastMark = state.t;
    }
    const canPing = b.pingCharge >= 1 && engine.effectivePower(b).sonar >= 2 && !engine.hasFault(b, 'sonar') && state.t >= skill.pingAfter;
    const lost = brain.conf < 0.3 && !threat && state.t - brain.lastPing > 25;
    if (canPing && (brain.pingAsked || (lost && (massWithin(brain, map, b, PING.radius) > 0.4 || state.t - brain.lastPing > 45)))) {
      if (want(() => A.ping(state, team))) { brain.lastPing = state.t; brain.pingAsked = false; brain.exposedUntil = state.t + 10; }
    }
  }

  // The mark the boat fights by: whoever set it. A person's mark is trusted while it is fresh.
  const marker = b.marker && state.t - b.marker.t <= 20 ? b.marker : null;
  const trust = autoListener ? brain.conf : 0.4;

  // Torpedo room: keep a tube loading, shoot at a good mark, steer the fish onto it, and throw a
  // decoy at a torpedo coming (its seeker goes for the decoy first).
  if (auto.includes('weapons')) {
    if (!b.tubes.some((tb) => tb.state === 'loading')) {
      const empty = b.tubes.findIndex((tb) => tb.state === 'empty');
      if (empty >= 0) want(() => A.loadTube(state, team, empty));
    }
    if (threat && brain.decoyThisTime && b.decoyCooldown <= 0) want(() => A.launchDecoy(state, team, headingFor(brain.threatBearing)));
    const ready = b.tubes.findIndex((tb) => tb.state === 'ready');
    const running = state.torpedoes.some((tp) => tp.team === team);
    const fireConf = autoListener ? skill.fireConf : 0.3;
    const sure = trust >= fireConf || (autoListener && snapping && trust >= skill.snapConf);
    if (ready >= 0 && marker && sure && !running && state.t >= skill.fireAfter
      && state.t - brain.lastShot >= skill.shotSpacing && !(brain.holdUntil > state.t)) {
      const d = dist(b, marker);
      if (d >= T.FIRE_MIN_DISTANCE && d <= TORPEDO.range - 1 && clearShot(map, b, marker)) {
        let aim = { x: marker.x, y: marker.y };
        if (engine.rand(state) < skill.aimJitter) {
          const h = Math.floor(engine.rand(state) * 8);
          const s = stepFrom(map, aim, h);
          if (s.ok && dist(s.to, b) >= T.FIRE_MIN_DISTANCE) aim = s.to;
        }
        if (want(() => A.fire(state, team, ready, aim))) { brain.lastShot = state.t; brain.exposedUntil = state.t + 8; }
      }
    }
    if (marker) {
      for (const tp of state.torpedoes) {
        if (tp.team !== team || tp.seeking || (tp.tx === marker.x && tp.ty === marker.y)) continue;
        if (dist(b, marker) >= T.FIRE_MIN_DISTANCE) want(() => A.guide(state, team, tp.id, marker));
      }
    }
  }

  // Helm: slip a torpedo across its path, close to firing range on a good mark, else patrol
  // quietly, stopping now and then to listen.
  if (auto.includes('helm') && !engine.hasFault(b, 'rudder')) {
    let heading = b.heading;
    let speed = b.ordered;
    if (evading) {
      if (brain.evadeHeading === null || state.t - brain.evadeSet > 4) {
        const side = headingFor(brain.threatBearing + 90);
        const other = headingFor(brain.threatBearing - 90);
        const away = headingFor(brain.threatBearing + 180);
        brain.evadeHeading = firstOkHeading(map, b, engine.rand(state) < 0.5 ? [side, other, away] : [other, side, away]);
        brain.evadeSet = state.t;
      }
      if (brain.evadeHeading !== null) heading = brain.evadeHeading;
      // Quiet: a seeker does not hear a slow boat. Half when they know where we are, to clear the blast.
      speed = skill.evade === 'run' ? 3 : (brain.exposedUntil ?? 0) > state.t ? 2 : 1;
      brain.stopUntil = 0;
    } else {
      brain.evadeHeading = null;
      let goal = null;
      if (marker && trust >= 0.25) {
        const d = dist(b, marker);
        if (d > 7) { goal = marker; speed = brain.quietUntil > state.t ? 1 : skill.approach; }
        else if (d >= 4) {
          // in range: creep across the line of fire, quietly
          heading = firstOkHeading(map, b, [headingFor(bearing(b, marker) + 90), headingFor(bearing(b, marker) - 90), b.heading]) ?? b.heading;
          speed = 1;
        } else {
          // too close to shoot (a torpedo arms only after a few cells): open the range
          heading = firstOkHeading(map, b, [headingFor(bearing(marker, b)), headingFor(bearing(marker, b) + 45), headingFor(bearing(marker, b) - 45)]) ?? b.heading;
          speed = 2;
        }
        brain.stopUntil = 0;
      } else {
        if (!brain.waypoint || sameCell(b, brain.waypoint) || state.t > brain.waypointUntil) {
          const far = waterCells(map).filter((c) => dist(b, c) >= 4);
          brain.waypoint = far[Math.floor(engine.rand(state) * far.length)] || null;
          brain.waypointUntil = state.t + 45;
        }
        goal = brain.waypoint;
        speed = brain.quietUntil > state.t ? 1 : skill.patrol;
        if (skill.listenStops) {
          if (state.t >= (brain.nextStop ?? Infinity) && !(brain.stopUntil > state.t)) {
            brain.stopUntil = state.t + 6;
            brain.nextStop = state.t + 18 + engine.rand(state) * 12;
          }
          if (brain.stopUntil > state.t) { speed = 0; goal = null; }
        }
      }
      if (goal) {
        const r = routeTo(map, b, goal);
        if (r) heading = r.heading;
        else brain.waypoint = null;
      }
    }
    if (!okHeading(map, b, heading)) heading = firstOkHeading(map, b, [heading + 1, heading - 1, heading + 2, heading - 2]) ?? heading;
    if (heading !== b.heading) want(() => A.setHeading(state, team, heading));
    if (speed !== b.ordered) want(() => A.setSpeed(state, team, speed));
  }

  // Engine room: repairs first, vent before a scram, power where the boat needs it.
  if (auto.includes('chief')) {
    if (!b.repair && b.faults.length) {
      const f = FAULT_ORDER.map((k) => b.faults.find((x) => x.kind === k)).find(Boolean);
      if (f) want(() => A.startRepair(state, team, f.id, { auto: true }));
    }
    if (b.heat > 80 && b.ventCooldown <= 0) want(() => A.vent(state, team));
    const p = planPower(state, team, brain, evading);
    if (p.engines !== b.power.engines || p.sonar !== b.power.sonar || p.tubes !== b.power.tubes) want(() => A.setPower(state, team, p));
  }
}

/** Called by the engine each tick for a team, with the stations nobody is manning right now. */
function run(state, team, auto, events, A) {
  if (!state.ai[team]) state.ai[team] = newBrain(state, team);
  const brain = state.ai[team];
  // The belief is kept for every team (an auto listener may take over at any time).
  if (state.t < brain.nextThink) return;
  brain.nextThink = state.t + skillOf(state, team).think;
  observe(state, team, brain);
  if (!auto.length) return;
  const out = [];
  act(state, team, auto, A, out);
  events.push(...out);
}

module.exports = { run, newBrain, observe, planPower, clearShot };
