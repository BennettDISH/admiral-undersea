// Playtests without a browser: whole matches against the AI's boat, with our boat played by a
// scripted "player" of a given style. The balance test (balance.test.js) and
// `node server/game/playtest.js [matches] [skills]` use it to check the hunt matters: charging in
// loses, a careful hunt wins.
//
// Styles (how our boat, alpha, is played):
//   careful  every station on the steady auto-crew: slow, listens, marks, fires from range
//   charge   the helm goes Full straight at the enemy the whole time; the auto-crew does the rest
//   rush     Full at the enemy, ping as soon as it is charged, fire point-blank at what the ping finds
//   novice   a first-timer at the helm: Half towards the crew's guess, the auto-crew does the rest
const engine = require('./engine');
const ai = require('./ai');
const { getMap, routeTo, dist, sameCell } = require('./map');
const { TORPEDO, TUNING } = require('./constants');

const HUMAN = { careful: [], charge: ['helm'], rush: ['helm', 'listener', 'weapons'], novice: ['helm'] };

function steer(state, team, goal, speed) {
  const b = state.subs[team];
  const map = getMap(state.mapId);
  if (goal && !sameCell(b, goal)) {
    const r = routeTo(map, b, goal);
    if (r && r.heading !== b.heading) engine.setHeading(state, team, r.heading);
  }
  if (b.ordered !== speed) engine.setSpeed(state, team, speed);
}

const freshFix = (state, team, seconds) => {
  const p = state.pings[team];
  if (!p || state.t - p.t > seconds) return null;
  return p.found.find((f) => f.kind === 'boat') || null;
};

function loadAndFire(state, team, target) {
  const b = state.subs[team];
  if (!b.tubes.some((tb) => tb.state === 'loading')) {
    const empty = b.tubes.findIndex((tb) => tb.state === 'empty');
    if (empty >= 0) engine.loadTube(state, team, empty);
  }
  if (!target || state.torpedoes.some((tp) => tp.team === team)) return;
  const ready = b.tubes.findIndex((tb) => tb.state === 'ready');
  const d = dist(b, target);
  if (ready >= 0 && d >= TORPEDO.armAfter && d <= TORPEDO.range && ai.clearShot(getMap(state.mapId), b, target)) engine.fire(state, team, ready, target);
}

const BOTS = {
  careful() {},
  charge(state) {
    steer(state, 'alpha', state.subs.bravo, 3);
  },
  rush(state, memo) {
    const b = state.subs.alpha;
    const fix = freshFix(state, 'alpha', 6);
    if (fix) memo.lastFix = fix;
    const brain = state.ai.alpha;
    const goal = fix || (brain?.best && brain.conf >= 0.15 ? brain.best : null) || memo.lastFix || memo.enemyStart;
    // charge until close, then hold there and shoot
    steer(state, 'alpha', goal, dist(b, goal) > 4 ? 3 : 0);
    if (b.pingCharge >= 1 && state.t > 12) engine.ping(state, 'alpha');
    if (fix) engine.setMarker(state, 'alpha', fix);
    loadAndFire(state, 'alpha', fix);
  },
  // A first-timer at the helm: Half towards wherever the crew thinks the enemy is (or their side
  // of the chart), slowing as it gets close; the auto-crew listens, shoots and runs the engines.
  novice(state, memo) {
    const b = state.subs.alpha;
    const brain = state.ai.alpha;
    const guess = (brain?.best && brain.conf >= 0.2 ? brain.best : null) || memo.enemyStart;
    const d = dist(b, guess);
    steer(state, 'alpha', guess, d > 6 ? 2 : d > 4 ? 1 : 0);
  },
};

/** One match of our `style` against the AI at `skill`. Returns the result and a few numbers. */
function playMatch({ seed, style = 'careful', skill = 'normal', maxSeconds = TUNING.MATCH_SECONDS + 1 }) {
  const crew = { alpha: Object.fromEntries((HUMAN[style] || []).map((s) => [s, 'human'])) };
  const state = engine.initMatch({ seed, crew, vsAi: true, aiSkill: skill });
  const memo = { enemyStart: { x: state.subs.bravo.x, y: state.subs.bravo.y } };
  const bot = BOTS[style] || BOTS.careful;
  const shots = { alpha: 0, bravo: 0 };
  let closest = 99;
  while (!state.over && state.t < maxSeconds) {
    bot(state, memo);
    for (const e of engine.tick(state, 0.1, ai)) {
      if (e.event === 'fx' && e.payload.type === 'fired') shots[e.team] += 1;
    }
    closest = Math.min(closest, dist(state.subs.alpha, state.subs.bravo));
  }
  return {
    winner: state.over?.winner ?? null,
    t: Math.round(state.over?.t ?? state.t),
    hull: { alpha: state.subs.alpha.hull, bravo: state.subs.bravo.hull },
    shots,
    closest: Math.round(closest * 10) / 10,
  };
}

/** Many matches: how often our boat wins. */
function winRate({ style, skill, seeds }) {
  let won = 0;
  let lost = 0;
  let t = 0;
  for (const seed of seeds) {
    const r = playMatch({ seed, style, skill });
    if (r.winner === 'alpha') won += 1;
    else if (r.winner === 'bravo') lost += 1;
    t += r.t;
  }
  return { won, lost, drawn: seeds.length - won - lost, rate: won / seeds.length, avgSeconds: Math.round(t / seeds.length) };
}

const seedsFor = (n, from = 1) => Array.from({ length: n }, (_, i) => (from + i) * 7919);

module.exports = { playMatch, winRate, seedsFor, STYLES: Object.keys(BOTS) };

// `node server/game/playtest.js [matches]`: the table of every style against every skill.
if (require.main === module) {
  const n = Number(process.argv[2]) || 40;
  const skills = (process.argv[3] || 'easy,normal,hard').split(',');
  for (const skill of skills) {
    for (const style of Object.keys(BOTS)) {
      const r = winRate({ style, skill, seeds: seedsFor(n) });
      console.log(`${skill.padEnd(7)} ${style.padEnd(8)} won ${String(r.won).padStart(3)}  lost ${String(r.lost).padStart(3)}  drawn ${String(r.drawn).padStart(3)}  (${Math.round(r.rate * 100)}%)  ~${r.avgSeconds}s`);
    }
  }
}
