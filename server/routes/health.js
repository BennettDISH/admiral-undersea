// GET /api/health, for Railway's healthcheck: the process is up and serving, and one
// SELECT 1 comes back from Postgres within TIMEOUT_MS. Nothing else is read, so it stays cheap
// however often it is asked. 200 { status: 'ok', db: 'ok' }, or 503 when the database does not
// answer, with no database error text in the body.

const TIMEOUT_MS = 3000;

function healthHandler({ query, timeoutMs = TIMEOUT_MS } = {}) {
  // Loaded on first use so a test that injects its own query never opens the pool.
  const ask = query || ((sql) => require('../config/database').query(sql));
  return async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    let timer;
    const asked = Promise.resolve().then(() => ask('SELECT 1'));
    asked.catch(() => {}); // a late failure after the timeout must not become an unhandled rejection
    const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); });
    try {
      await Promise.race([asked, late]);
      res.json({ status: 'ok', db: 'ok' });
    } catch {
      res.status(503).json({ status: 'unavailable', db: 'not answering' });
    } finally {
      clearTimeout(timer);
    }
  };
}

module.exports = { healthHandler, TIMEOUT_MS };
