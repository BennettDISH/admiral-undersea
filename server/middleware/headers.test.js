// What every response carries (CSP, HSTS, frame protection, nosniff, Referrer-Policy), what the
// server logs for a request, and what an unknown API path or a failing route answers. The
// middleware is mounted the way index.js mounts it, on a small app with a route that throws.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { requestLog, scrubPath } = require('./requestLog');
const { securityHeaders, WIDGET_ORIGIN } = require('./securityHeaders');
const { apiNotFound, errorHandler } = require('./errors');

let base;
let server;
const lines = [];
const realLog = console.log;
const realError = console.error;
const logged = [];

test.before(async () => {
  const app = express();
  app.use(requestLog({ skip: (req) => req.path === '/api/health' }));
  app.use(securityHeaders());
  app.use(express.json());
  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
  app.post('/api/auth/sso-callback', (req, res) => res.json({ ok: true }));
  app.get('/api/boom', () => { throw new Error('relation "users" does not exist'); });
  app.use('/api', apiNotFound);
  app.get('*', (req, res) => res.type('html').send('<!doctype html><div id="root"></div>'));
  app.use(errorHandler);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => logged.push(a);
});

test.after(() => {
  console.log = realLog;
  console.error = realError;
  return new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
});

const directive = (csp, name) => (csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) || '').split(/\s+/).slice(1);
const lineFor = async (id) => {
  await new Promise((r) => setTimeout(r, 50)); // the line is written when the response finishes
  return lines.find((l) => l.startsWith(`${id} `));
};

test('pages and API answers carry an enforced CSP that names the widget and Google Fonts only', async () => {
  for (const url of ['/', '/api/health', '/api/nothing']) {
    const res = await fetch(base + url);
    const csp = res.headers.get('content-security-policy') || '';
    assert.ok(csp, `${url} has a Content-Security-Policy`);
    assert.deepStrictEqual(directive(csp, 'default-src'), ["'self'"], url);
    assert.ok(directive(csp, 'script-src').includes(WIDGET_ORIGIN), `${url}: the widget may load`);
    assert.ok(!directive(csp, 'script-src').includes("'unsafe-inline'"), `${url}: no inline script`);
    assert.ok(directive(csp, 'connect-src').includes(WIDGET_ORIGIN), `${url}: the widget may report`);
    assert.ok(directive(csp, 'style-src').includes('https://fonts.googleapis.com'), `${url}: the font stylesheet`);
    assert.ok(directive(csp, 'font-src').includes('https://fonts.gstatic.com'), `${url}: the font files`);
    assert.ok(directive(csp, 'img-src').includes('blob:'), `${url}: the widget's screenshot is a blob:`);
    assert.deepStrictEqual(directive(csp, 'frame-ancestors'), ["'none'"], url);
    assert.ok(!/unsafe-eval/.test(csp), `${url}: no eval`);
  }
});

test('HSTS, nosniff and frame protection are sent, and the Referrer-Policy keeps the origin', async () => {
  const res = await fetch(`${base}/`);
  assert.match(res.headers.get('strict-transport-security') || '', /max-age=\d{8,}/);
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('x-frame-options') || '', /SAMEORIGIN|DENY/);
  assert.strictEqual(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.strictEqual(res.headers.get('x-powered-by'), null);
});

test('a request logs one line: id, method, path, status and time, with no query string', async () => {
  const res = await fetch(`${base}/api/auth/sso-callback?code=abc123&state=def456`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'abc123' }),
  });
  const id = res.headers.get('x-request-id');
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.match(await lineFor(id), /^[0-9a-f-]{36} POST \/api\/auth\/sso-callback 200 \d+ms$/);
  assert.ok(!/abc123|def456|code=|state=/.test(lines.join('\n')), 'nothing from the query or the body is logged');
});

test('a request id the caller sent is kept, a malformed one is replaced, /api/health is not logged', async () => {
  const kept = await fetch(`${base}/api/nothing`, { headers: { 'X-Request-Id': 'caller-id-0001' } });
  assert.strictEqual(kept.headers.get('x-request-id'), 'caller-id-0001');
  assert.ok(await lineFor('caller-id-0001'));
  const bad = await fetch(`${base}/api/nothing`, { headers: { 'X-Request-Id': 'not an id!' } });
  assert.match(bad.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
  const health = await fetch(`${base}/api/health`);
  assert.ok(health.headers.get('x-request-id'));
  assert.strictEqual(await lineFor(health.headers.get('x-request-id')), undefined);
});

test('a token-looking path segment is logged as :token', async () => {
  const res = await fetch(`${base}/api/join/abcdefghijklmnopqrstuvwx1234`);
  assert.match(await lineFor(res.headers.get('x-request-id')), / GET \/api\/join\/:token 404 /);
  assert.ok(!lines.join('\n').includes('abcdefghijklmnopqrstuvwx1234'));
  assert.strictEqual(scrubPath('/api/games/AB12'), '/api/games/AB12');
});

test('an /api path no route answers is a JSON 404, whatever the method', async () => {
  for (const method of ['GET', 'POST', 'DELETE']) {
    const res = await fetch(`${base}/api/nothing-here`, { method });
    assert.strictEqual(res.status, 404, method);
    assert.match(res.headers.get('content-type'), /json/);
    assert.deepStrictEqual(await res.json(), { error: 'No such endpoint' });
  }
});

test('a route that fails answers "Something went wrong" and logs the error behind the request id', async () => {
  logged.length = 0;
  const res = await fetch(`${base}/api/boom?x=1`);
  assert.strictEqual(res.status, 500);
  const body = await res.json();
  assert.deepStrictEqual(body, { error: 'Something went wrong' });
  assert.strictEqual(logged[0][0], res.headers.get('x-request-id'));
  assert.deepStrictEqual(logged[0].slice(1, 3), ['GET', '/api/boom']);
  assert.match(String(logged[0][3]), /relation "users"/);
});

test('a body that is not JSON is a plain 400, not a 500', async () => {
  const res = await fetch(`${base}/api/auth/sso-callback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
  assert.strictEqual(res.status, 400);
  assert.ok(!/SyntaxError|Unexpected token/.test(JSON.stringify(await res.json())));
});

test('index.js mounts the log and the headers first, the 404 after the routes and the error handler last', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const at = (re) => source.search(re);
  assert.ok(at(/app\.use\(requestLog\(/) > 0 && at(/app\.use\(requestLog\(/) < at(/app\.use\(securityHeaders\(\)\)/));
  assert.ok(at(/app\.use\(securityHeaders\(\)\)/) < at(/app\.use\('\/api\/auth'/));
  assert.ok(at(/app\.get\('\/api\/health'/) < at(/app\.use\('\/api', apiNotFound\)/));
  assert.ok(at(/app\.use\('\/api', apiNotFound\)/) < at(/app\.get\('\*'/));
  assert.ok(at(/app\.get\('\*'/) < at(/app\.use\(errorHandler\)/));
  assert.ok(!/morgan/.test(source), 'morgan is gone');
});
