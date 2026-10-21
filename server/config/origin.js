// The one browser origin allowed to call the API and open sockets from another origin.
//
// The built client is served by this same server, and same-origin requests need no CORS, so
// in production FRONTEND_URL is only for a client hosted somewhere else. Unset there, no
// other origin is allowed: false turns CORS off in both the cors middleware and socket.io.
// In development the Vite dev server on :5173 opens its socket to :5000 directly (the /api
// proxy does not carry it), so that is the fallback when not in production.
const DEV_ORIGIN = 'http://localhost:5173';

const onRailway = (env) => Boolean(env.RAILWAY_ENVIRONMENT_ID || env.RAILWAY_PROJECT_ID || env.RAILWAY_ENVIRONMENT);

function corsOrigin(env = process.env) {
  // An origin has no trailing slash; one copied from the address bar would never match.
  const url = (env.FRONTEND_URL || '').trim().replace(/\/+$/, '');
  if (url) return url;
  return env.NODE_ENV === 'production' || onRailway(env) ? false : DEV_ORIGIN;
}

module.exports = { corsOrigin, DEV_ORIGIN };
