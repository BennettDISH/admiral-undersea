const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');

const authRoutes = require('./routes/auth');
const gameRoutes = require('./routes/games');
const setupGameSockets = require('./sockets/game');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true
  }
});

const PORT = process.env.PORT || 5000;

// Middleware
app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true
}));
app.use(morgan('dev'));
app.use(express.json());

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/games', gameRoutes);

// Setup game sockets
setupGameSockets(io);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Temporary SSO migration endpoint
app.post('/api/migrate-sso', async (req, res) => {
  const { secret } = req.body;
  if (secret !== process.env.SSO_CLIENT_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const db = require('./config/database');
    // Ensure central_user_id column exists
    await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS central_user_id INTEGER UNIQUE');
    // Get all users without central_user_id
    const users = await db.query('SELECT id, username, email, password_hash FROM users WHERE central_user_id IS NULL');
    if (users.rows.length === 0) {
      return res.json({ message: 'No users to migrate', migrated: 0 });
    }
    // Send to central auth service for bulk import
    const importPayload = {
      users: users.rows.map(u => ({ username: u.username, email: u.email, password_hash: u.password_hash })),
      client_id: process.env.SSO_CLIENT_ID,
      client_secret: process.env.SSO_CLIENT_SECRET
    };
    const response = await fetch(`${process.env.AUTH_SERVICE_URL}/api/auth/proxy/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(importPayload)
    });
    const result = await response.json();
    // Update local users with central IDs
    let linked = 0;
    const items = result.results || result.imported || [];
    for (const imp of items) {
      const centralId = imp.central_user_id || imp.central_id;
      const uname = imp.local_username || imp.username;
      await db.query('UPDATE users SET central_user_id = $1 WHERE LOWER(username) = LOWER($2)', [centralId, uname]);
      linked++;
    }
    res.json({ message: 'Migration complete', total: users.rows.length, linked, result });
  } catch (error) {
    console.error('Migration error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Serve static files from React build
app.use(express.static(path.join(__dirname, '../client/dist')));

// SPA fallback - serve index.html for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/dist/index.html'));
});

httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
