// Who a game socket is: the handshake reads the same session cookie as the REST API, and only
// from the game's own pages (a WebSocket upgrade is not covered by CORS, so another site's page
// could otherwise open one that carries the player's cookie). In-process PGlite.
const test = require('node:test');
const assert = require('node:assert');

process.env.USE_PGLITE = '1';
process.env.JWT_SECRET = 'handshake-test-secret';
process.env.NODE_ENV = 'production'; // no localhost allowance
delete process.env.FRONTEND_URL;
delete process.env.APP_BASE_URL;

const db = require('../config/database');
const initDb = require('../config/initDb');
const { wp } = require('../config/auth');
const setupGameSockets = require('./game');

let handshake;
let player;

test.before(async () => {
  await initDb();
  player = (await db.query(`INSERT INTO users (email, username, password_hash) VALUES ('sock@example.com', 'sockeye', 'x') RETURNING *`)).rows[0];
  const io = { use(fn) { handshake = fn; }, on() {}, to: () => ({ emit() {} }) };
  setupGameSockets(io);
});

// Runs the handshake for a socket whose upgrade request carried these headers.
const connect = (headers) => new Promise((resolve) => {
  const socket = { request: { headers: { host: 'admiral.example', ...headers } } };
  handshake(socket, (err) => resolve({ err, socket }));
});
const cookie = (user) => `${wp.session.name}=${wp.session.mint(user)}`;

test('a socket from the game\'s own page with the session cookie is that player', async () => {
  const { err, socket } = await connect({ origin: 'https://admiral.example', cookie: cookie(player) });
  assert.strictEqual(err, undefined);
  assert.strictEqual(socket.userId, player.id);
  assert.strictEqual(socket.username, 'sockeye');
});

test('a socket from another site is refused, cookie or not', async () => {
  const { err } = await connect({ origin: 'https://elsewhere.example', cookie: cookie(player) });
  assert.match(err.message, /own pages/);
  const sibling = await connect({ origin: 'https://other.admiral.example', cookie: cookie(player) });
  assert.ok(sibling.err);
});

test('without a session, or with a signed-out one, it is refused as not signed in', async () => {
  assert.match((await connect({ origin: 'https://admiral.example' })).err.message, /Authentication required/);
  assert.match((await connect({ origin: 'https://admiral.example', cookie: `${wp.session.name}=forged.token.here` })).err.message, /Authentication required/);
  const before = cookie(player);
  await db.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [player.id]);
  assert.match((await connect({ origin: 'https://admiral.example', cookie: before })).err.message, /Authentication required/);
});
