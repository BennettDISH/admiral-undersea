// The fleet's security checks on this game's own routes (fleet-kit/test/security), against the real
// index.js on an in-process PGlite database. A new route has to be public, an admin's, or reach a
// game through a param named below, or this fails.
//
// Most of the game is on sockets, and this walk doesn't touch them. Those are in sockets/:
// handshake.test.js (the session cookie and the Origin), game.integration.test.js (seats, teams, who
// may act in which game), rateLimit.test.js (events per socket).
const test = require('node:test');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

process.env.USE_PGLITE = '1';
process.env.JWT_SECRET = 'security-test-secret';
delete process.env.SESSION_SECRET;
process.env.PORT = '0';
process.env.ADMIN_CENTRAL_USER_IDS = '900';
// No Waypoint, so nothing here can reach one.
for (const name of ['AUTH_SERVICE_URL', 'SSO_CLIENT_ID', 'SSO_CLIENT_SECRET']) delete process.env[name];

const DIST = path.join(__dirname, '..', 'client', 'dist', 'index.html');
const SHELL = '<!doctype html><html><head><title>x</title></head><body><div id="root"></div></body></html>';
const ADMIN_DATA = ['GET /api/admin/switches', 'GET /api/admin/users', 'GET /api/admin/games'];

test('security', async (t) => {
  const { securityChecks } = await import('fleet-kit/test/security');
  const madeDist = !fs.existsSync(DIST);
  if (madeDist) {
    fs.mkdirSync(path.dirname(DIST), { recursive: true });
    fs.writeFileSync(DIST, SHELL);
  }
  const { app, httpServer } = require('./index');
  const db = require('./config/database');
  const { wp } = require('./config/auth');
  if (!httpServer.listening) await once(httpServer, 'listening');
  console.log = () => {}; // a walk is many requests
  t.after(() => {
    httpServer.closeAllConnections();
    httpServer.close();
    if (madeDist) fs.rmSync(path.dirname(DIST), { recursive: true, force: true });
  });

  const person = async (username, central) => {
    const { rows: [row] } = await db.query(
      `INSERT INTO users (email, username, password_hash, central_user_id) VALUES ($1, $2, 'sso-managed', $3) RETURNING *`,
      [`${username}@example.com`, username, central],
    );
    return { row, headers: { cookie: `${wp.session.name}=${wp.session.mint(row)}` } };
  };
  const admin = await person('admiral', 900);
  const ann = await person('ann', 901);
  const bob = await person('bob', 902);
  const guest = await person('guest-swift-otter-4821', 903);

  const { rows: [game] } = await db.query(`INSERT INTO games (code, created_by) VALUES ('ANNSGM', $1) RETURNING id, code`, [ann.row.id]);
  await db.query(`INSERT INTO game_players (game_id, user_id, team, roles) VALUES ($1, $2, 'alpha', 'captain')`, [game.id, ann.row.id]);

  const checks = securityChecks({
    app,
    base: `http://127.0.0.1:${httpServer.address().port}`,
    as: { user: () => ann.headers, other: () => bob.headers, guest: () => guest.headers, admin: () => admin.headers },
    // The password forms, Waypoint sign-in and the guest button are how a stranger gets an account,
    // and Waypoint comes back to /auth/callback.
    public: ['GET /api/health', '* /api/auth/*', 'GET /auth/callback'],
    // Not /api/admin/me: any signed-in player may ask, and the answer is only whether they are the admin.
    admin: ADMIN_DATA,
    adminPages: ['/admin'],
    crossSite: {},
    noStore: {},
    owned: {
      params: { code: () => game.code },
      // A game's code is the way in: a friend opens the link and joins the lobby, so anyone signed
      // in who has it sees the roster. The match itself goes out on the sockets, by team.
      except: ['GET /api/games/:code'],
    },
    guests: { refused: ADMIN_DATA },
    headers: { path: '/' },
  });
  for (const check of checks) await t.test(check.name, check.run);
});
