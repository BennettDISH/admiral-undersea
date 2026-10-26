const express = require('express');
const bcrypt = require('bcryptjs');
const { rateLimit, waypointUser } = require('fleet-kit/server');
const db = require('../config/database');
const { wp, account, findOrCreateLocalUser, publicUser } = require('../config/auth');

// The game's own email/username and password forms (the ?local page and Register). Waypoint
// sign-in, one-click guests, /config, /me, /logout and /logout-all are fleet-kit's router,
// mounted below these. Every answer that signs someone in sets the same session cookie.
const router = express.Router();

// Every sign-in route that reaches Waypoint, which only sees this server's one address and caps
// per address: without a limit here, one visitor could use up everyone's sign-ins or mint
// accounts without end. Per browser address (req.ip, one trusted proxy hop: index.js), in memory.
// (The kit limits its own routes: the Waypoint callback and the guest button.)
const signupLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: 'Too many new accounts from here. Try again later.' });

// Attempts counted per key (a name or an address) over a sliding window, in memory and per
// process. Once `allowed` are recent, the key waits until the oldest leaves the window.
function attemptLimit(allowed, windowMs) {
  const times = new Map(); // key -> times of recent attempts
  const recent = (key, now = Date.now()) => {
    const kept = (times.get(key) || []).filter((t) => now - t < windowMs);
    if (kept.length) times.set(key, kept);
    else times.delete(key);
    return kept;
  };
  return {
    // Seconds before the key may try again; 0 means now.
    waitSeconds(key) {
      const kept = recent(key);
      if (kept.length < allowed) return 0;
      return Math.max(1, Math.ceil((kept[kept.length - allowed] + windowMs - Date.now()) / 1000));
    },
    note(key) {
      if (times.size > 1000) for (const k of [...times.keys()]) recent(k);
      times.set(key, [...recent(key), Date.now()]);
    },
    clear(key) {
      times.delete(key);
    },
  };
}

// The old local sign-in (the ?local form) checks passwords here, and with SSO on at Waypoint,
// which only ever sees this server's address. 10 wrong passwords for one name (username or
// email) in 15 minutes make that name wait, and 30 from one address make the address wait.
// The address is req.ip, which with `trust proxy` 1 (index.js) is the one Railway's edge saw,
// not one the client wrote into X-Forwarded-For.
const WRONG_PASSWORD_WINDOW_MS = 15 * 60 * 1000;
const wrongPasswordsByName = attemptLimit(10, WRONG_PASSWORD_WINDOW_MS);
const wrongPasswordsByAddress = attemptLimit(30, WRONG_PASSWORD_WINDOW_MS);

// The session for an account, and the account for the page.
const signedIn = (res, user, status = 200) => {
  wp.session.set(res, user);
  return res.status(status).json({ success: true, user: publicUser({ ...user, is_admin: wp.isAdmin(user) }) });
};

// Register new user
router.post('/register', signupLimit, async (req, res) => {
  const { email, username, password } = req.body ?? {};

  if (!email || !username || !password || typeof email !== 'string' || typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email, username, and password are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    // Check if email or username already exists locally
    const existing = await db.query(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1) OR LOWER(username) = LOWER($2)',
      [email, username]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Email or username already exists' });
    }

    // With SSO on, the account must be made centrally first. A local-only row would carry an
    // email nobody verified, and the real owner's first SSO login would adopt it.
    let centralUserId = null;
    if (wp.client.configured()) {
      let r;
      try {
        r = await wp.client.register({ username, email, password });
      } catch (err) {
        console.error('Central register failed:', err.message);
        return res.status(503).json({ error: 'Sign-up is unavailable right now. Please try again shortly.' });
      }
      if ((r.status !== 200 && r.status !== 201) || !r.json?.central_user_id) {
        console.error('Central register refused:', r.status);
        if (r.status >= 400 && r.status < 500) return res.status(400).json({ error: r.json?.error || 'Central registration failed' });
        return res.status(503).json({ error: 'Sign-up is unavailable right now. Please try again shortly.' });
      }
      centralUserId = waypointUser(r.json).central_user_id;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await db.query(
      `INSERT INTO users (email, username, password_hash, role, is_active, central_user_id, created_at)
       VALUES ($1, $2, $3, 'player', true, $4, NOW())
       RETURNING id`,
      [email.toLowerCase(), username, passwordHash, centralUserId]
    );
    return signedIn(res, await account(result.rows[0].id), 201);
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
router.post('/login', async (req, res) => {
  const { username, password } = req.body ?? {};

  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const name = username.trim().toLowerCase();
  const wait = Math.max(wrongPasswordsByName.waitSeconds(name), wrongPasswordsByAddress.waitSeconds(req.ip));
  if (wait) {
    res.set('Retry-After', String(wait));
    return res.status(429).json({ error: 'Too many wrong passwords. Try again in a few minutes.' });
  }
  const wrongPassword = () => {
    wrongPasswordsByName.note(name);
    wrongPasswordsByAddress.note(req.ip);
    return res.status(401).json({ error: 'Invalid credentials' });
  };

  try {
    // Try central login first if SSO is on; a refusal or an outage falls back to a local row.
    if (wp.client.configured()) {
      try {
        const r = await wp.client.login(username, password);
        // Gate on the central id, not the email — central accounts may have no email.
        if (r.status === 200 && r.json?.central_user_id != null) {
          const localUser = await findOrCreateLocalUser(waypointUser(r.json));
          if (localUser) {
            wrongPasswordsByName.clear(name);
            return signedIn(res, localUser);
          }
        }
      } catch (err) {
        console.error('Central login failed, trying local:', err.message);
      }
    }

    const result = await db.query(
      'SELECT id, password_hash FROM users WHERE (LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($1)) AND is_active = true',
      [username]
    );
    if (result.rows.length === 0) return wrongPassword();

    const validPassword = await bcrypt.compare(password, result.rows[0].password_hash);
    if (!validPassword) return wrongPassword();

    wrongPasswordsByName.clear(name);
    return signedIn(res, await account(result.rows[0].id));
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// The rest of sign-in: /config, /sso/login (?prompt=login is Switch account), /me, /logout,
// /logout-all and /guest. Waypoint comes back to /auth/callback (index.js).
router.use(wp.router);

module.exports = router;
