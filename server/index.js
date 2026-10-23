const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const path = require('path');

const authRoutes = require('./routes/auth');
const gameRoutes = require('./routes/games');
const adminRoutes = require('./routes/admin');
const { healthHandler } = require('./routes/health');
const setupGameSockets = require('./sockets/game');
const initDb = require('./config/initDb');
const { corsOrigin } = require('./config/origin');
const { scheduleGuestSweep } = require('./services/guestSweep');

// FRONTEND_URL, or nobody but this site in production (see config/origin.js).
const allowedOrigin = corsOrigin();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigin,
    credentials: true
  }
});

const PORT = process.env.PORT || 5000;

// Trust Railway's edge, and only it (one hop), so req.protocol reflects the public https
// scheme (used to build the OAuth redirect_uri), secure cookies are honored, and req.ip is
// the address the edge saw: the last X-Forwarded-For entry. `true` would take the first,
// which the client writes itself, and the sign-in limit in routes/auth.js counts req.ip.
app.set('trust proxy', 1);

// Middleware
app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(cors({
  origin: allowedOrigin,
  credentials: true
}));
app.use(morgan('dev'));
app.use(express.json());
app.use(cookieParser());

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/games', gameRoutes);
app.use('/api/admin', adminRoutes);

// Setup game sockets
const { flushMatches, sweepMatches } = setupGameSockets(io);

// Health check (Railway's healthcheck path): 200 only while Postgres answers a SELECT 1
app.get('/api/health', healthHandler());

// Serve static files from React build
app.use(express.static(path.join(__dirname, '../client/dist')));

// SPA fallback - serve index.html for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/dist/index.html'));
});

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
