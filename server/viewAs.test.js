// View as (fleet-kit 1.0.18): the site admin picks a player on /admin and sees the game the way they
// do, read-only. The kit's own checks run in security.test.js (viewAs); this is the game's side:
// who /admin offers it for, the player's account and lobby as they see them, nothing written, no
// live socket (every play goes over it), and the way back. The real index.js on in-process PGlite.
const test = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

process.env.USE_PGLITE = '1';
process.env.JWT_SECRET = 'view-as-test-secret';
delete process.env.SESSION_SECRET;
process.env.PORT = '0';
process.env.ADMIN_CENTRAL_USER_IDS = '900, 905';
// No Waypoint, so nothing here can reach one.
for (const name of ['AUTH_SERVICE_URL', 'SSO_CLIENT_ID', 'SSO_CLIENT_SECRET']) delete process.env[name];

const { app, httpServer } = require('./index');
const db = require('./config/database');
const { wp } = require('./config/auth');
const setupGameSockets = require('./sockets/game');

let base;
let admin;
let ann;
let annRow;
let adminRow;
let code;
let handshake;

// A browser: its own cookies, kept from each answer, and a page on this site asking.
function browser() {
  const jar = new Map();
  const call = async (method, p, body, { headers = {} } = {}) => {
    const h = { 'sec-fetch-site': 'same-origin', ...headers };
    if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(`${base}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (!value || /max-age=0|expires=thu, 01 jan 1970/i.test(line)) jar.delete(name);
      else jar.set(name, value);
    }
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* a page */ }
    return { status: res.status, data, headers: res.headers, location: res.headers.get('location') };
  };
  call.jar = jar;
  call.cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  return call;
}

const person = async (username, central, { active = true } = {}) => (await db.query(
  `INSERT INTO users (email, username, password_hash, central_user_id, is_active)
   VALUES ($1, $2, 'sso-managed', $3, $4) RETURNING *`,
  [`${username}@example.com`, username, central, active],
)).rows[0];
const signIn = (b, row) => b.jar.set(wp.session.name, wp.session.mint(row));

// The game socket's handshake for a browser's cookies, from the game's own page.
const connect = (cookie) => new Promise((resolve) => {
  const socket = { request: { method: 'GET', headers: { host: 'admiral.example', origin: 'https://admiral.example', cookie } } };
  handshake(socket, (err) => resolve({ err, socket }));
});
const viewing = async (b) => (await b('GET', '/api/auth/view-as')).data.viewing;
const gameCount = async () => (await db.query('SELECT COUNT(*)::int AS n FROM games')).rows[0].n;

test.before(async () => {
  if (!httpServer.listening) await once(httpServer, 'listening');
  base = `http://127.0.0.1:${httpServer.address().port}`;
  console.log = () => {}; // the request log
  setupGameSockets({ use(fn) { handshake = fn; }, on() {}, to: () => ({ emit() {} }) }, { clock: false });

  adminRow = await person('admiral', 900);
  annRow = await person('ann', 901);
  await person('second-admiral', 905);
  await person('laid-up', 906, { active: false });
  admin = browser();
  ann = browser();
  signIn(admin, adminRow);
  signIn(ann, annRow);
  const made = await ann('POST', '/api/games/create', { gameMode: 'crews', sameRoom: false });
  assert.strictEqual(made.status, 201, JSON.stringify(made.data));
  code = made.data.game.code;
});

test.after(() => {
  httpServer.closeAllConnections();
  httpServer.close();
});

test('/admin offers View as for each player, but not the admin\'s own account, another admin or a closed one', async () => {
  const r = await admin('GET', '/api/admin/users');
  assert.strictEqual(r.status, 200);
  const offered = Object.fromEntries(r.data.users.map((u) => [u.username, u.view_as]));
  assert.deepStrictEqual(offered, { admiral: false, ann: true, 'second-admiral': false, 'laid-up': false });
  assert.ok(!JSON.stringify(r.data).includes('central_user_id'), 'the central id only decides it');
});

test('the admin sees Ann\'s game as she does, nothing can be changed, and no socket opens', async () => {
  const started = await admin('POST', '/api/auth/view-as', { id: annRow.id });
  assert.strictEqual(started.status, 200, JSON.stringify(started.data));
  assert.strictEqual(started.data.next, '/');
  assert.strictEqual(started.data.viewing.name, 'ann');
  assert.strictEqual((await viewing(admin)).name, 'ann');

  // her account, her lobby and the deck's admin question, exactly as she gets them
  const hers = await ann('GET', '/api/auth/me');
  const seen = await admin('GET', '/api/auth/me');
  assert.deepStrictEqual(seen.data.user, hers.data.user);
  assert.strictEqual(seen.data.user.is_admin, false);
  for (const p of [`/api/games/${code}`, '/api/admin/me']) {
    const a = await admin('GET', p);
    const s = await ann('GET', p);
    assert.strictEqual(a.status, 200, p);
    assert.deepStrictEqual(a.data, s.data, p);
  }

  // read-only: a new game is refused and none is made
  const before = await gameCount();
  const made = await admin('POST', '/api/games/create', { gameMode: 'crews', sameRoom: false });
  assert.strictEqual(made.status, 403);
  assert.strictEqual(made.data.code, 'viewing_as');
  assert.match(made.data.error, /viewing as ann/);
  assert.strictEqual(await gameCount(), before);

  // play is all on the socket, so none opens while viewing (and the page isn't sent to sign in);
  // Ann's own still does
  const sock = await connect(admin.cookie());
  assert.ok(sock.err, 'the handshake is refused');
  assert.match(sock.err.message, /read-only/);
  assert.doesNotMatch(sock.err.message, /Authentication required|Invalid or expired session/);
  const hersSock = await connect(ann.cookie());
  assert.strictEqual(hersSock.err, undefined);
  assert.strictEqual(hersSock.socket.userId, annRow.id);

  // the admin's own data and page are the admin's, not hers
  assert.strictEqual((await admin('GET', '/api/admin/users')).status, 403);
  const page = await admin('GET', '/admin');
  assert.strictEqual(page.status, 403);
  assert.match(page.data, /viewing Admiral Undersea as ann/);
  const href = /<a href="([^"]+)">Exit<\/a>/.exec(page.data)?.[1];
  assert.strictEqual(href, '/api/auth/view-as/exit');

  // Exit from /admin's link: back to the admin's own game
  const back = await admin('GET', href);
  assert.strictEqual(back.status, 303);
  assert.strictEqual(back.location, '/admin');
  assert.strictEqual(await viewing(admin), null);
  assert.strictEqual((await admin('GET', '/api/admin/users')).status, 200);

  // and the banner's Exit (JSON)
  assert.strictEqual((await admin('POST', '/api/auth/view-as', { id: annRow.id })).status, 200);
  const out = await admin('POST', '/api/auth/view-as/exit', {});
  assert.deepStrictEqual(out.data, { ok: true, next: '/admin' });
  assert.strictEqual(await viewing(admin), null);
  assert.strictEqual((await admin('GET', '/api/auth/me')).data.user.is_admin, true);
  const mine = await connect(admin.cookie());
  assert.strictEqual(mine.err, undefined);
  assert.strictEqual(mine.socket.userId, adminRow.id);
});

test('Ann can\'t view as anyone, and the page loads the banner', async () => {
  const r = await ann('POST', '/api/auth/view-as', { id: adminRow.id + 1 });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(ann.jar.has('__Host-au_view'), false);
  const page = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');
  assert.match(page, /<script src="\/api\/auth\/view-as\.js" defer><\/script>/);
  const js = await browser()('GET', '/api/auth/view-as.js');
  assert.strictEqual(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  // the page's CSP takes a same-origin script
  assert.match((await browser()('GET', '/api/health')).headers.get('content-security-policy'), /script-src[^;]*'self'/);
});
