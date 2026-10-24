// One line per request with an id to find it again, and nothing secret: no query strings
// (Waypoint's ?code=&state= land on the callback URL), no bodies, headers or cookies, and
// path segments that look like tokens (invite and share links) logged as :token.
const crypto = require('node:crypto');

const ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
const scrubPath = (p) => p.split('/').map((s) => (/^[A-Za-z0-9_-]{16,}$/.test(s) ? ':token' : s)).join('/');

function requestLog({ skip = (req) => req.path === '/health' || req.path === '/healthz' } = {}) {
  return (req, res, next) => {
    const given = req.get('x-request-id');
    req.id = given && ID_RE.test(given) ? given : crypto.randomUUID();
    res.set('X-Request-Id', req.id);
    if (skip(req)) return next();
    const started = process.hrtime.bigint();
    // originalUrl, cut at the query: inside app.use('/api', …) req.path has lost the /api.
    const logged = scrubPath(req.originalUrl.split('?')[0]);
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      console.log(`${req.id} ${req.method} ${logged} ${res.statusCode} ${Math.round(ms)}ms`);
    });
    next();
  };
}

module.exports = { requestLog, scrubPath };
