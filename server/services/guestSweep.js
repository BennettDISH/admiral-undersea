// Guests nobody has seen for a month go, with what only guests ever touched.
//
// A guest is a user Waypoint minted for "Try it as a guest": made by a Waypoint sign-in
// ('sso-managed', with a central id) and named with Waypoint's generated guest name
// (guest-swift-otter-4821, with "#<central id>" when the name was taken here; Waypoint keeps
// "guest-" for guests, so no account can pick one). A guest who keeps the account takes a
// new name, which the next sign-in copies, and is never touched.
// "Seen" is last_seen_at: every Waypoint sign-in stamps it (routes/auth.js), and a row from
// before the column counts as seen when it arrived. A session is a token good for
// JWT_EXPIRES_IN (7 days) from sign-in, never renewed, and the sockets check the same token.
// Past the window (GUEST_RETENTION_DAYS, 30 by default: the same setting and window as
// Waypoint, which forgets an idle guest on its side too) no token of that guest still works,
// so it cannot come back while the sweep is taking it.
//
// What goes is only what nobody else has a part in:
//   - a game a stale guest made, if deleting it deletes or changes no row that names anyone
//     but stale guests (its players);
//   - then a stale guest that no row anywhere still names.
// What stays: a game anyone else joined; and any guest that any row in any table still names
// (a guest who played in someone else's game stays on that game's roster).
//
// This is Spellforge's sweep (services/guests.js there), with the same three holds:
//   1. The question is put to the catalogue. Every foreign key is read from pg_constraint: a
//      guest is asked about through every key to users, and a game through every chain of
//      cascading keys that ends at it, and every key that would empty itself on a row that
//      stays (ON DELETE SET NULL), so a table added later is asked too.
//   2. Each piece runs on one snapshot (REPEATABLE READ). The question, the delete and the
//      counts see the same moment; a row added or changed under a piece stops it.
//   3. The piece is measured. The rows that name an account in use are counted, through every
//      key to users, before the delete and after it, and the piece is undone if any count
//      moved. Whatever the question missed is kept, and logged.
// A piece the database will not let go (a key that refuses, a row changed under it, a
// deadlock) is tried again one at a time; the one that cannot go is left for the next run and
// said in the log, and the rest go.
//
// It runs a minute after boot and then daily (index.js), against Postgres (not the local
// PGlite mode); GUEST_CLEANUP_ENABLED=false turns it off. A failure is logged and never
// thrown: a background chore never takes the server down.
const db = require('../config/database');

/** The pool; the local PGlite mode is one session, so it is its own one connection. */
const pool = db.connect ? db : { connect: async () => ({ query: (text, params) => db.query(text, params), release() {} }) };

/** How long a session lasts, from JWT_EXPIRES_IN ('7d', '12h', or seconds); a value this
 *  cannot read counts as a year, so the sweep waits rather than guesses short. */
function sessionDays(value) {
  const m = /^(\d+)\s*(d|h|m|s)?$/.exec(String(value).trim());
  if (!m) return 365;
  const seconds = Number(m[1]) * { d: 86400, h: 3600, m: 60, s: 1 }[m[2] || 's'];
  return Math.max(1, Math.ceil(seconds / 86400));
}

/** The accounts: the table, its own id, what makes one a guest and when it was last seen. */
const USERS = 'users';
const USER_ID = 'id';
const isGuest = (u) => `(${u}.username ~ '^guest-[a-z]+-[a-z]+-[0-9]{4}(#[0-9]+)?$' AND ${u}.central_user_id IS NOT NULL AND ${u}.password_hash = 'sso-managed')`;
const lastSeen = (u) => `GREATEST(${u}.last_seen_at, ${u}.created_at)`;
/** The sweep never takes a guest sooner than a session lasts, whatever the setting. */
const SESSION_DAYS = sessionDays(process.env.JWT_EXPIRES_IN || '7d');
/** What a guest makes on its own: the table, the key that names its maker, its own id. */
const ROOTS = [
  { table: 'games', owner: 'created_by', id: 'id' },
];
const MADE = 'game(s)';
const OWN = []; // rows of a guest's own that go with it, by the key that names it
const OFF = process.env.USE_PGLITE ? 'local PGlite' : null;
const LOCK = 4734110; // one sweeper at a time, even while an old and a new deploy overlap

const AT_ONCE = 100;
const GUESTS_AT_ONCE = 250;
const DEPTH = 6; // keys in a chain from a row down to the last row that goes with it
const DAY_MS = 24 * 60 * 60 * 1000;

/** `u` names an account row; $1 is the window in days. */
const stale = (u) => `(${isGuest(u)} AND ${lastSeen(u)} < NOW() - ($1 || ' days')::interval)`;
/** What the database says of the rows themselves: a key that refuses or a value that may not
 *  be emptied (class 23), a row changed under the piece or a deadlock (class 40), a trigger
 *  that raises (class P0). The piece cannot go; the sweep can go on. Anything else ends the run. */
const cannotGo = (err) => /^(23|40|P0)/.test(err.code ?? '');

/** Every foreign key, from the catalogue: the table that holds it, its own column(s), the
 *  column(s) of the table it names, and what a delete there does to the row ('c' cascade,
 *  'n' set null, 'd' set default). */
const KEYS = `
  SELECT c.conrelid::text AS child, c.confrelid::text AS parent, c.confdeltype::text AS rule,
         format('%I.%I', n.nspname, t.relname) AS tbl,
         (SELECT array_agg(quote_ident(a.attname) ORDER BY k.ord)
            FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS cols,
         (SELECT array_agg(quote_ident(a.attname) ORDER BY k.ord)
            FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS refs
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE c.contype = 'f'`;
const NAMES = [...new Set([USERS, ...[...ROOTS, ...OWN].flatMap((r) => [r.table, r.via].filter(Boolean))])];
const TABLES = `SELECT ${NAMES.map((t, i) => `'${t}'::regclass::oid::text AS t${i}`).join(', ')}`;

/** a is a row of the key's table, b the row it names. */
const on = (k, a, b) => k.cols.map((c, i) => `${a}.${c} = ${b}.${k.refs[i]}`).join(' AND ');
const any = (list) => (list.length ? `(${list.join(' OR ')})` : 'FALSE');
const pieces = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));

/** The sweep's questions, written from the keys the database has today. */
function plan(keys, row) {
  const oid = (name) => row[`t${NAMES.indexOf(name)}`];
  const users = oid(USERS);
  const toUsers = keys.filter((k) => k.parent === users);
  const keyOf = (table, col, to) => {
    const k = keys.find((x) => x.child === oid(table) && x.parent === oid(to) && x.cols.length === 1 && x.cols[0] === col);
    if (!k) throw new Error(`${table}.${col} is not a key to ${to}`);
    return k;
  };

  /** Every chain of cascading keys hanging off `table`: a row at the end of one goes with the
   *  row at its start. */
  const chainsFrom = (table) => {
    const out = [];
    const walk = (parent, chain) => {
      for (const k of keys) {
        if (k.parent !== parent || k.rule !== 'c' || chain.includes(k)) continue;
        const next = [...chain, k];
        out.push(next);
        if (next.length < DEPTH) walk(k.child, next);
      }
    };
    walk(table, []);
    return out;
  };
  /** The rows a chain reaches from row `a`, as aliases `${p}0`, `${p}1`, ...; `last` is the row
   *  at its end (`a` itself for the empty chain). */
  const reach = (chain, a, p) => (chain.length
    ? {
      from: chain.map((k, i) => (i ? `JOIN ${k.tbl} ${p}${i} ON ${on(k, `${p}${i}`, `${p}${i - 1}`)}` : `${k.tbl} ${p}0`)).join(' '),
      where: on(chain[0], `${p}0`, a),
      last: `${p}${chain.length - 1}`,
    }
    : { from: `(SELECT 1) ${p}`, where: 'TRUE', last: a });

  /** True when deleting row `a` of `table` would take or change something of someone else's:
   *  a row that goes with it names an account in use (or is one), or a row that stays loses
   *  its key to a row that goes (ON DELETE SET NULL / SET DEFAULT). */
  const touchesOthers = (table, a) => {
    const all = [[], ...chainsFrom(table)];
    const end = (c) => (c.length ? c.at(-1).child : table);
    const goes = (t, y) => any(all.filter((c) => end(c) === t).map((c) => {
      const r = reach(c, a, 'z');
      return `EXISTS (SELECT 1 FROM ${r.from} WHERE ${r.where} AND ${r.last}.ctid = ${y}.ctid)`;
    }));
    const found = [];
    for (const c of all) {
      const r = reach(c, a, 'x');
      for (const u of toUsers.filter((k) => k.child === end(c))) {
        found.push(`EXISTS (SELECT 1 FROM ${r.from} JOIN ${USERS} o ON ${on(u, r.last, 'o')} WHERE ${r.where} AND NOT ${stale('o')})`);
      }
      if (c.length && end(c) === users) found.push(`EXISTS (SELECT 1 FROM ${r.from} WHERE ${r.where} AND NOT ${stale(r.last)})`);
      for (const k of keys.filter((x) => x.parent === end(c) && (x.rule === 'n' || x.rule === 'd'))) {
        found.push(`EXISTS (SELECT 1 FROM ${r.from} JOIN ${k.tbl} y ON ${on(k, 'y', r.last)} WHERE ${r.where} AND NOT ${goes(k.child, 'y')})`);
      }
    }
    return any(found);
  };

  const roots = ROOTS.map((root) => {
    // the maker is named on the row itself, or on a row of `via` that belongs to it
    const join = root.via
      ? `${root.table} r JOIN ${root.via} m ON ${on(keyOf(root.via, root.key, root.table), 'm', 'r')} JOIN ${USERS} u ON ${on(keyOf(root.via, root.owner, USERS), 'm', 'u')}`
      : `${root.table} r JOIN ${USERS} u ON ${on(keyOf(root.table, root.owner, USERS), 'r', 'u')}`;
    const also = root.also ? ` AND ${root.also('r')}` : '';
    return { ...root, join, dead: `${stale('u')}${also} AND NOT ${touchesOthers(oid(root.table), 'r')}` };
  });

  // A guest's own rows go with it, so their keys do not keep it, as long as nothing that
  // would go with them belongs to anyone else.
  const own = OWN.map((o) => ({ ...o, k: keyOf(o.table, o.owner, USERS) }));
  const named = toUsers.filter((k) => !own.some((o) => o.k === k)).map((k) => `EXISTS (SELECT 1 FROM ${k.tbl} x WHERE ${on(k, 'x', 'u')})`);
  const shared = own.map((o) => `EXISTS (SELECT 1 FROM ${o.k.tbl} e WHERE ${on(o.k, 'e', 'u')} AND ${touchesOthers(o.k.child, 'e')})`);

  return {
    roots,
    /** a guest's own rows, for the guests in $1 */
    dropOwn: own.map((o) => `DELETE FROM ${o.k.tbl} e USING ${USERS} u WHERE ${on(o.k, 'e', 'u')} AND u.${USER_ID} = ANY($1)`),
    /** over `${USERS} u` */
    unnamedGuest: `${stale('u')} AND NOT ${any(named)} AND NOT ${any(shared)}`,
    /** the accounts in use, and the rows that name one through each key to them */
    census: `SELECT k, n::text AS n FROM (
      SELECT -1 AS k, count(*) AS n FROM ${USERS} u WHERE NOT ${stale('u')}
      ${toUsers.map((k, i) => `UNION ALL SELECT ${i}, count(*) FROM ${k.tbl} x JOIN ${USERS} u ON ${on(k, 'x', 'u')} WHERE NOT ${stale('u')}`).join('\n      ')}
    ) c ORDER BY k`,
    counted: (k) => (k < 0 ? USERS : `${toUsers[k].tbl}(${toUsers[k].cols.join(', ')})`),
  };
}

/** One piece of the sweep, all of it or none: `ask` says which of the piece may go, on this
 *  transaction's snapshot; `take` deletes them. Answers { went } — or { moved } with the counts
 *  that changed, or { refused } with the database's own words (cannotGo). */
async function piece(client, p, window, ask, take) {
  const count = async () => (await client.query(p.census, [window])).rows;
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try {
    const going = await ask();
    if (!going.length) { await client.query('ROLLBACK'); return { went: [] }; }
    const before = await count();
    await take(going);
    const after = await count();
    const moved = before.map((b, i) => (b.n === after[i].n ? null : `${p.counted(b.k)} ${b.n} → ${after[i].n}`)).filter(Boolean);
    if (moved.length) { await client.query('ROLLBACK'); return { moved }; }
    await client.query('COMMIT');
    return { went: going };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (!cannotGo(err)) throw err;
    return { refused: `${err.code} ${String(err.message).split('\n')[0]}` };
  }
}

/** A piece that will not go as a whole is tried one at a time, each on a snapshot of its own:
 *  the one the sweep may not take is left, said in the log, and does not hold the others back. */
async function each(what, ids, take) {
  const whole = await take(ids);
  if (whole.went) return whole.went.length;
  let done = 0;
  for (const id of ids) {
    const one = await take([id]);
    if (one.went) { done += one.went.length; continue; }
    console.error(one.moved
      ? `Guest sweep: ${what} ${id} left in place — taking it would change the rows that name accounts in use: ${one.moved.join(', ')}`
      : `Guest sweep: ${what} ${id} left for the next run — the database would not let it go: ${one.refused}`);
  }
  return done;
}

async function sweepGuests({ db = pool, days: asked = Number(process.env.GUEST_RETENTION_DAYS || 30), dryRun = false } = {}) {
  if (!Number.isFinite(asked) || asked < 1) throw new Error(`GUEST_RETENTION_DAYS must be a positive number, got ${asked}`);
  // never sooner than a session lasts: a guest whose token still works is still in use
  const window = String(Math.max(asked, SESSION_DAYS));
  const client = await db.connect();
  try {
    if (!(await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK])).rows[0].ok) return { skipped: 'another sweep is running' };
    try {
      const { rows: idle } = await client.query(`SELECT u.${USER_ID} AS id FROM ${USERS} u WHERE ${stale('u')} ORDER BY ${lastSeen('u')}`, [window]);
      if (!idle.length) return { stale: 0, made: 0, removed: 0, kept: 0 };
      const p = plan((await client.query(KEYS)).rows, (await client.query(TABLES)).rows[0]);

      let made = 0;
      for (const root of p.roots) {
        const deadAmong = async (ids) => (await client.query(
          `SELECT DISTINCT r.${root.id} AS id FROM ${root.join} WHERE ${root.dead}${ids ? ` AND r.${root.id} = ANY($2)` : ''}`,
          ids ? [window, ids] : [window])).rows.map((r) => r.id);
        const dead = await deadAmong();
        if (dryRun) { made += dead.length; continue; }
        const take = (ids) => piece(client, p, window, () => deadAmong(ids),
          (going) => client.query(`DELETE FROM ${root.table} WHERE ${root.id} = ANY($1)`, [going]));
        for (const ids of pieces(dead, AT_ONCE)) made += await each(root.table, ids, take);
      }
      if (dryRun) return { stale: idle.length, made, removed: 0, kept: 0 };

      // Who is still named, now that what only guests made is gone
      let removed = 0;
      const take = (ids) => piece(client, p, window,
        async () => (await client.query(`SELECT u.${USER_ID} AS id FROM ${USERS} u WHERE u.${USER_ID} = ANY($2) AND ${p.unnamedGuest}`, [window, ids])).rows.map((u) => u.id),
        async (going) => {
          for (const sql of p.dropOwn) await client.query(sql, [going]);
          await client.query(`DELETE FROM ${USERS} WHERE ${USER_ID} = ANY($1)`, [going]);
        });
      for (const ids of pieces(idle.map((u) => u.id), GUESTS_AT_ONCE)) removed += await each('guest', ids, take);
      return { stale: idle.length, made, removed, kept: idle.length - removed };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK]).catch(() => {});
    }
  } finally {
    client.release();
  }
}

/** One run, as the timer makes it: what happened is logged, and a failure too, never thrown. */
async function runGuestSweep(options) {
  try {
    const r = await sweepGuests(options);
    if (r.removed || r.made || r.kept) {
      const made = ROOTS.length ? `, with ${r.made} ${MADE} only guests had a part in` : '';
      console.log(`Guest sweep: ${r.removed} idle guest(s) removed${made}; ${r.kept} left in place (something someone else uses still names them)`);
    }
    return r;
  } catch (err) {
    console.error('Guest sweep failed (it runs again tomorrow):', err.message);
    return { failed: err.message };
  }
}

function scheduleGuestSweep() {
  const off = process.env.GUEST_CLEANUP_ENABLED === 'false' ? 'GUEST_CLEANUP_ENABLED=false' : OFF;
  if (off) { console.log(`Guest sweep off (${off})`); return; }
  setTimeout(runGuestSweep, 60 * 1000).unref();
  setInterval(runGuestSweep, DAY_MS).unref();
}

module.exports = { sweepGuests, runGuestSweep, scheduleGuestSweep };
