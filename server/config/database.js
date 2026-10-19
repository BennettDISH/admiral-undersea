// Database access. Production/normal dev uses a real Postgres via `pg`.
//
// Local TEST PATH: set USE_PGLITE=1 to run against an in-process PGlite database
// (real Postgres semantics compiled to WASM — no server, no Docker, no install beyond
// the dev dependency). Data is in-memory by default (set PGLITE_DIR to persist).
// Exposes the same `.query(text, params) -> { rows }` surface the app already uses.
if (process.env.USE_PGLITE) {
  // PGlite ships as ESM; dynamic import() works from CommonJS. The first query awaits it.
  const ready = (async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const dir = process.env.PGLITE_DIR || undefined; // undefined => in-memory
    const pg = new PGlite(dir);
    await pg.waitReady;
    console.log(`PGlite ready (${dir ? dir : 'in-memory'})`);
    return pg;
  })();

  module.exports = {
    async query(text, params) {
      const pg = await ready;
      // Parameterised queries are always single-statement -> use query().
      if (params && params.length) return pg.query(text, params);
      // No params may be the multi-statement schema -> exec() runs them all.
      const res = await pg.exec(text);
      const last = Array.isArray(res) ? res[res.length - 1] : res;
      return { rows: (last && last.rows) || [] };
    },
    _pglite: ready,
  };
} else {
  const { Pool } = require('pg');
  const pool = process.env.DATABASE_URL
    ? new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
      })
    : new Pool({
        user: process.env.DB_USER || 'postgres',
        host: process.env.DB_HOST || 'localhost',
        database: process.env.DB_NAME || 'admiral_undersea',
        password: process.env.DB_PASSWORD || 'postgres',
        port: process.env.DB_PORT || 5432,
      });
  // An idle client can error (database restart, dropped connection). Without a listener
  // that 'error' event is unhandled and takes the whole server down; the pool drops the
  // broken client and makes a new one on the next query.
  pool.on('error', (err) => {
    console.error('Postgres idle client error:', err.message);
  });
  // A client checked out with pool.connect() loses the pool's listener while it is out, so
  // the same drop between two queries would still crash. Each client gets its own listener
  // for life; its next query fails and the caller's error handling answers.
  pool.on('connect', (client) => {
    client.on('error', (err) => console.error('Postgres client error:', err.message));
  });
  module.exports = pool;
}
