// How big one socket message may be (sockets/rateLimit.js MAX_SOCKET_MESSAGE_BYTES), on the real
// index.js: Socket.IO reads a whole message before the per-socket event bucket can drop it, and its
// default allows a megabyte, so a page sending big ones slowed every running match's clock. A
// message past the limit closes that connection; the game's own are far under it.
const test = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');
const WebSocket = require('ws');

process.env.USE_PGLITE = '1';
process.env.JWT_SECRET = 'frame-limit-test-secret';
process.env.PORT = '0';
for (const name of ['AUTH_SERVICE_URL', 'SSO_CLIENT_ID', 'SSO_CLIENT_SECRET', 'SESSION_SECRET']) delete process.env[name];

const { MAX_SOCKET_MESSAGE_BYTES } = require('./rateLimit');

let base;
let server;
test.before(async () => {
  console.log = () => {};
  server = require('../index').httpServer;
  if (!server.listening) await once(server, 'listening');
  base = `ws://127.0.0.1:${server.address().port}/socket.io/?EIO=4&transport=websocket`;
});
test.after(() => { server?.closeAllConnections(); server?.close(); });

// An engine.io connection, opened (its "0{...}" handshake read); resolves to the socket.
async function open() {
  const ws = new WebSocket(base, { headers: { origin: 'http://127.0.0.1' } });
  await new Promise((resolve, reject) => {
    ws.once('message', (m) => (String(m).startsWith('0') ? resolve() : reject(new Error(String(m)))));
    ws.once('error', reject);
  });
  return ws;
}
// Whether the server closes this connection within ms.
const closedWithin = (ws, ms) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), ms);
  ws.once('close', () => { clearTimeout(timer); resolve(true); });
});

test('a message past the limit closes its connection', async () => {
  const ws = await open();
  const closed = closedWithin(ws, 5000);
  ws.send(`3${'x'.repeat(MAX_SOCKET_MESSAGE_BYTES + 1024)}`); // a pong, read and dropped by the server unless too big
  assert.strictEqual(await closed, true);
});

test('a message under it is read as usual', async () => {
  const ws = await open();
  const closed = closedWithin(ws, 1500);
  ws.send(`3${'x'.repeat(4 * 1024)}`);
  assert.strictEqual(await closed, false);
  ws.close();
});
