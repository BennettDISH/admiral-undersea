// Which other origin may call the API and open sockets (config/origin.js), and that with
// none set the game's own page still gets its socket.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { Server } = require('socket.io');
const { corsOrigin, DEV_ORIGIN } = require('./origin');

test('FRONTEND_URL is the allowed origin, without a trailing slash', () => {
  assert.strictEqual(corsOrigin({ FRONTEND_URL: 'https://admiral.example' }), 'https://admiral.example');
  assert.strictEqual(corsOrigin({ FRONTEND_URL: ' https://admiral.example/ ', NODE_ENV: 'production' }), 'https://admiral.example');
});

test('in production with no FRONTEND_URL, no other origin is allowed (never localhost)', () => {
  assert.strictEqual(corsOrigin({ NODE_ENV: 'production' }), false);
  assert.strictEqual(corsOrigin({ NODE_ENV: 'production', FRONTEND_URL: '' }), false);
  // Railway without NODE_ENV set is production too.
  assert.strictEqual(corsOrigin({ RAILWAY_ENVIRONMENT_ID: 'abc' }), false);
});

test('in development the Vite dev server is the fallback', () => {
  assert.strictEqual(corsOrigin({}), DEV_ORIGIN);
  assert.strictEqual(corsOrigin({ NODE_ENV: 'development' }), DEV_ORIGIN);
});

/** One socket.io polling handshake with the given Origin header: status, ACAO header, body. */
function handshake(port, origin) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      port,
      path: '/socket.io/?EIO=4&transport=polling',
      headers: origin ? { Origin: origin } : {},
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, allow: res.headers['access-control-allow-origin'], body }));
    });
    req.once('error', reject);
  });
}

test('with no other origin allowed, the page served from this server still gets its socket', async (t) => {
  const httpServer = http.createServer();
  const io = new Server(httpServer, { cors: { origin: corsOrigin({ NODE_ENV: 'production' }), credentials: true } });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => io.close(() => resolve())));
  const { port } = httpServer.address();

  const own = await handshake(port, `http://127.0.0.1:${port}`);
  assert.strictEqual(own.status, 200);
  assert.match(own.body, /"sid"/, 'the handshake opened a session');

  const other = await handshake(port, 'http://localhost:5173');
  assert.strictEqual(other.allow, undefined, 'no CORS header lets another origin read the answer');
});

test('with FRONTEND_URL set, that origin is told it may connect', async (t) => {
  const httpServer = http.createServer();
  const io = new Server(httpServer, { cors: { origin: corsOrigin({ FRONTEND_URL: 'https://admiral.example/' }), credentials: true } });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => io.close(() => resolve())));
  const { port } = httpServer.address();

  const res = await handshake(port, 'https://admiral.example');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.allow, 'https://admiral.example');
});
