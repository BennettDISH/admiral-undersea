const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const {
  trustOneProxy, requestLog, sameOriginWrites, health, apiNotFound, assetNotFound, spaFallback, errorHandler,
} = require('fleet-kit/server');

// The session cookie is signed with this. In production a real secret is mandatory: the game
// refuses to start rather than run with sign-in broken.
if (!process.env.SESSION_SECRET && !process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('JWT_SECRET (or SESSION_SECRET) must be set in production — refusing to start without it.');
}

const db = require('./config/database');
const { wp } = require('./config/auth');
const authRoutes = require('./routes/auth');
const gameRoutes = require('./routes/games');
const adminRoutes = require('./routes/admin');
const setupGameSockets = require('./sockets/game');
const initDb = require('./config/initDb');
const { corsOrigin } = require('./config/origin');
const { securityHeaders } = require('./middleware/securityHeaders');
const { scheduleGuestSweep } = require('./services/guestSweep');

// FRONTEND_URL, or nobody but this site in production (see config/origin.js).
const allowedOrigin = corsOrigin();

// Trust Railway's edge, and only it (one hop), so req.protocol reflects the public https
// scheme (used to build the OAuth redirect_uri) and req.ip is the address the edge saw: the
// last X-Forwarded-For entry. `true` would take the first, which the client writes itself, and
// the sign-in limits count req.ip.
const app = trustOneProxy(express());
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigin,
    credentials: true
  }
});

const PORT = process.env.PORT || 5000;

// Middleware (fleet-kit's). Railway's healthcheck is /api/health, so that is the path left out
// of the log.
app.use(requestLog({ skip: (req) => req.path === '/api/health' }));
// CSP, HSTS, frame protection and the referrer policy: middleware/securityHeaders.js
app.use(securityHeaders());
app.use(cors({
  origin: allowedOrigin,
  credentials: true
}));
// The session is a cookie, so a write sent by another site's page would carry it: every write
// under /api has to come from the game's own pages.
app.use('/api', sameOriginWrites({ message: 'This request has to come from the game itself.' }));
app.use(express.json());

// API Routes. Sign-in (and its per-address limits) is fleet-kit's, with the game's own
// password forms in front (routes/auth.js).
app.use('/api/auth', authRoutes);
app.use('/api/games', gameRoutes);
app.use('/api/admin', adminRoutes);

// Waypoint sends the browser back here (the address registered for the game); the server takes
// the code and sets the session, then goes on to the page that needed an account.
app.get('/auth/callback', wp.callback);

// Setup game sockets
const { flushMatches, sweepMatches } = setupGameSockets(io);

// Health check (Railway's healthcheck path): 200 only while Postgres answers a SELECT 1 in 3 s
app.get('/api/health', health({ db, timeoutMs: 3000 }));

// An /api path no route answered is a JSON 404, not the app's page.
app.use('/api', apiNotFound());

// The site admin's page, decided before the page goes out: signed out → sign in and back,
// anyone else → a plain 403 with nothing of the admin area in it. Its data asks again
// (/api/admin).
app.use(wp.adminPage({ pages: /^\/admin\/?$/ }));

// Vite names every built asset after its content, so a browser can keep them for good instead
// of re-checking the whole bundle on each visit. A missing one is a 404: index.html in its
// place is a page the browser refuses to run as a script.
app.use('/assets', express.static(path.join(__dirname, '../client/dist/assets'), { immutable: true, maxAge: '1y' }));
app.use('/assets', assetNotFound());

// Serve static files from React build
app.use(express.static(path.join(__dirname, '../client/dist')));

// SPA fallback: index.html for every other page, never kept by the browser.
app.use(spaFallback(path.join(__dirname, '../client/dist/index.html')));

// Last: any error a route forwards is logged with the request id and answered in JSON, never
// with the error itself.
app.use(errorHandler({ messages: { tooLarge: 'That request is too large.' } }));

async function start() {
  try {
    await initDb();
  } catch (err) {
    console.error('Database init failed (server will start, but DB features will error until this is fixed):', err.message);
  }

  httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
  scheduleGuestSweep(); // idle guests go a minute after boot, then daily
  scheduleMatchSweep(); // old matches go a minute after boot, then hourly
}

// Matches are written to the database a moment after they change (sockets/game.js), so a
// shutdown (every deploy) writes what is waiting before it exits, but never waits long.
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  const giveUp = new Promise((resolve) => setTimeout(resolve, 4000));
  Promise.race([flushMatches(), giveUp]).finally(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// A finished game's match is dropped a day after it ends, any other after a week unchanged.
function scheduleMatchSweep() {
  const run = async () => {
    try {
      const dropped = await sweepMatches();
      if (dropped) console.log(`Match sweep: ${dropped} old match(es) let go from memory`);
    } catch (err) { console.error('Match sweep failed (it runs again in an hour):', err.message); }
  };
  setTimeout(run, 60 * 1000).unref();
  setInterval(run, 60 * 60 * 1000).unref();
}

start();
