// What every response carries (CSP, HSTS, frame protection, nosniff, Referrer-Policy), and that
// index.js mounts fleet-kit's log, headers, 404 and error handler where they belong. The headers
// are mounted the way index.js mounts them, on a small app.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { trustOneProxy } = require('fleet-kit/server');
const { securityHeaders, WIDGET_ORIGIN } = require('./securityHeaders');

let base;
let server;

test.before(async () => {
  const app = trustOneProxy(express());
  app.use(securityHeaders());
  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
  app.use((req, res) => res.type('html').send('<!doctype html><div id="root"></div>'));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));

const directive = (csp, name) => (csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) || '').split(/\s+/).slice(1);

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

test('HSTS over https, nosniff and frame protection are sent, and the Referrer-Policy keeps the origin', async () => {
  const res = await fetch(`${base}/`, { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.match(res.headers.get('strict-transport-security') || '', /max-age=\d{8,}/);
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('x-frame-options') || '', /SAMEORIGIN|DENY/);
  assert.strictEqual(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.strictEqual(res.headers.get('x-powered-by'), null);
});

test('index.js mounts the log and the headers first, the 404 after the routes and the error handler last', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const at = (re) => source.search(re);
  assert.ok(at(/app\.use\(requestLog\(/) > 0 && at(/app\.use\(requestLog\(/) < at(/app\.use\(securityHeaders\(\)\)/));
  assert.ok(at(/app\.use\(securityHeaders\(\)\)/) < at(/app\.use\('\/api\/auth'/));
  assert.ok(at(/app\.use\('\/api', sameOriginWrites\(/) < at(/app\.use\('\/api\/auth'/), 'the write guard is before every API route');
  assert.ok(at(/app\.get\('\/api\/health'/) < at(/app\.use\('\/api', apiNotFound\(\)\)/));
  assert.ok(at(/app\.use\('\/api', apiNotFound\(\)\)/) < at(/app\.use\(spaFallback\(/));
  assert.ok(at(/app\.use\(spaFallback\(/) < at(/app\.use\(errorHandler\(/));
  assert.ok(!/morgan|helmet/.test(source), 'morgan and helmet are gone');
});

test('the /admin gate covers every spelling Express routes to the page (any case, a trailing slash)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const m = /adminPage\(\{ pages: \/(.+?)\/([a-z]*) \}\)/.exec(source);
  assert.ok(m, 'index.js gates /admin with a pages pattern');
  const pages = new RegExp(m[1], m[2]);
  for (const url of ['/admin', '/admin/', '/ADMIN', '/Admin/']) assert.ok(pages.test(url), url);
  for (const url of ['/administrator', '/admin/x', '/api/admin']) assert.ok(!pages.test(url), url);
});
