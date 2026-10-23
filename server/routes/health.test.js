// GET /api/health, Railway's healthcheck: 200 while the server is up and Postgres answers a
// SELECT 1, 503 when it errors or keeps silent, one statement and nothing else, and no
// database text in the body.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { healthHandler } = require('./health');

async function serve(handler) {
  const app = express().get('/api/health', handler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return {
    get: async () => {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
      return { status: res.status, cache: res.headers.get('cache-control'), body: await res.json() };
    },
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

test('one SELECT 1, and 200 when the database answers', async () => {
  const asked = [];
  const s = await serve(healthHandler({ query: async (sql) => { asked.push(sql); return { rows: [{}] }; } }));
  try {
    assert.deepStrictEqual(await s.get(), { status: 200, cache: 'no-store', body: { status: 'ok', db: 'ok' } });
    assert.deepStrictEqual(asked, ['SELECT 1']);
  } finally { await s.close(); }
});

test('a database that errors, throws, or keeps silent is a 503 with no database text', async () => {
  const cases = {
    rejects: async () => { throw new Error('password authentication failed for user "postgres"'); },
    throws: () => { throw new Error('no pool'); },
    silent: () => new Promise(() => {}),
    late: () => new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 120)),
  };
  for (const [name, query] of Object.entries(cases)) {
    const s = await serve(healthHandler({ query, timeoutMs: 50 }));
    try {
      const r = await s.get();
      assert.strictEqual(r.status, 503, name);
      assert.strictEqual(r.cache, 'no-store', name);
      assert.deepStrictEqual(r.body, { status: 'unavailable', db: 'not answering' }, name);
    } finally { await s.close(); }
  }
  await new Promise((resolve) => setTimeout(resolve, 150)); // the late rejection lands after its 503, unhandled-free
});

test('against the real database layer (PGlite) it answers 200', async () => {
  process.env.USE_PGLITE = '1';
  const s = await serve(healthHandler());
  try {
    assert.deepStrictEqual((await s.get()).body, { status: 'ok', db: 'ok' });
  } finally { await s.close(); }
});
