// Local test launcher: runs the server against an in-process PGlite database so you can
// play a full match with no external Postgres, Docker, or install.
//   node dev-local.js   (or: npm run dev:local)
// Env you can override: PORT, JWT_SECRET, PGLITE_DIR (persist to disk), FRONTEND_URL.
process.env.USE_PGLITE = process.env.USE_PGLITE || '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'local-dev-secret';
process.env.PORT = process.env.PORT || '5000';
require('./index.js');
