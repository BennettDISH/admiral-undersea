const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../config/database');
const { SSO_ENABLED, AUTH_SERVICE_URL, SSO_CLIENT_ID, centralRegister, centralLogin, centralGuest, exchangeCode } = require('../config/sso');
const { signToken } = require('../config/jwt');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// __Host- keeps a sibling *.bennettdishman.com page from planting a Domain-wide cookie of the
// same name. The prefix needs Secure, path / and no Domain; browsers accept Secure on localhost.
const STATE_COOKIE = '__Host-au_oauth_state';

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

// Absolute base URL of this app — prefer an explicit env (exact match to the registered
// redirect_uri), else the request origin (correct in prod with trust proxy set).
const baseUrl = (req) => (process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

const stateCookieOpts = () => ({
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
});

// The central auth-service returns identity fields FLAT (central_user_id, username,
// email, ...). Older/proxy responses may nest them under `user`. Accept both shapes.
function normalizeCentral(raw) {
  const u = (raw && raw.user) ? raw.user : (raw || {});
  return {
    central_user_id: u.central_user_id != null ? u.central_user_id : (u.id != null ? u.id : null),
    email: u.email,
    username: u.username
  };
}

async function findOrCreateLocalUser(central) {
  // Check by central_user_id
  if (central.central_user_id != null) {
    const byCentral = await db.query(
      'SELECT id, email, username, role, created_at FROM users WHERE central_user_id = $1',
      [central.central_user_id]
    );
    if (byCentral.rows.length > 0) {
      const local = byCentral.rows[0];
      if (local.email !== central.email || local.username !== central.username) {
        await db.query('UPDATE users SET email = $1, username = $2, updated_at = NOW() WHERE id = $3', [central.email, central.username, local.id]);
        local.email = central.email;
        local.username = central.username;
      }
      // every sign-in is noted: the guest sweep goes by it (services/guestSweep.js)
      await db.query('UPDATE users SET last_seen_at = NOW() WHERE id = $1', [local.id]);
      return local;
    }
  }

  // Adopt a pre-migration local row by email — but ONLY if it is unclaimed.
  //
  // `AND central_user_id IS NULL` is the load-bearing part. Without it, a local row already
  // owned by central account A is silently reassigned to central account B as soon as B's
  // email matches: B inherits A's games and history, and A's next login mints a fresh empty
  // row so their account looks wiped. Emails are deliberately reassignable between central
  // accounts, so this is reachable rather than theoretical. An unclaimed row has no owner to
  // steal from, which is what makes adoption safe.
  //
  // Central accounts may have no email at all — only match when there IS one, or every
  // emailless user links onto the same local row.
  if (central.email) {
    const byEmail = await db.query(
      'SELECT id, email, username, role, created_at FROM users WHERE LOWER(email) = LOWER($1) AND central_user_id IS NULL',
      [central.email]
    );
    //
    // Adoption also retires the row's local password. Whoever set it never proved they own
    // this email, so leaving it would let them keep signing in to the central owner's row.
    if (byEmail.rows.length > 0) {
      await db.query(
        `UPDATE users SET central_user_id = $1, password_hash = 'sso-managed', updated_at = NOW(), last_seen_at = NOW() WHERE id = $2`,
        [central.central_user_id, byEmail.rows[0].id]
      );
      return byEmail.rows[0];
    }
  }

  // Falling through means the email/username may still be held by a row we just refused to
  // adopt. `users.username` is UNIQUE NOT NULL and `users.email` is UNIQUE, so reusing either
  // verbatim raises 23505 and 500s the login. Drop the email (NULL never collides) and
  // suffix the username with the central id, which is itself unique.
  const username = await freeUsername(central.username, central.central_user_id);
  const email = central.email ? await freeEmail(central.email) : null;

  const created = await db.query(
    `INSERT INTO users (email, username, password_hash, role, is_active, central_user_id, created_at)
     VALUES ($1, $2, $3, 'player', true, $4, NOW())
     RETURNING id, email, username, role, created_at`,
    [email, username, 'sso-managed', central.central_user_id]
  );
  return created.rows[0];
}

// Returns `desired` if no other local row holds it, otherwise a central-id-suffixed variant.
async function freeUsername(desired, centralUserId) {
  const taken = await db.query('SELECT 1 FROM users WHERE LOWER(username) = LOWER($1)', [desired]);
  return taken.rows.length === 0 ? desired : `${desired}#${centralUserId}`;
}

// Returns `desired` only if no other local row holds it; NULL otherwise, since a duplicate
// would violate users_email_key. The address stays with whoever already had it.
async function freeEmail(desired) {
  const taken = await db.query('SELECT 1 FROM users WHERE LOWER(email) = LOWER($1)', [desired]);
  return taken.rows.length === 0 ? desired : null;
}

// Register new user
router.post('/register', async (req, res) => {
  const { email, username, password } = req.body;

  if (!email || !username || !password) {
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
    if (SSO_ENABLED) {
      try {
        const centralResult = await centralRegister({ username, email, password });
        centralUserId = normalizeCentral(centralResult).central_user_id;
      } catch (err) {
        console.error('Central register failed:', err.message);
        if (err.status >= 400 && err.status < 500) {
          return res.status(400).json({ error: err.message });
        }
        return res.status(503).json({ error: 'Sign-up is unavailable right now. Please try again shortly.' });
      }
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await db.query(
      `INSERT INTO users (email, username, password_hash, role, is_active, central_user_id, created_at)
       VALUES ($1, $2, $3, 'player', true, $4, NOW())
       RETURNING id, email, username, role, created_at`,
      [email.toLowerCase(), username, passwordHash, centralUserId]
    );

    const user = result.rows[0];
    res.status(201).json({
      success: true,
      token: signToken(user),
      user
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const name = String(username).trim().toLowerCase();
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
    // Try central login first if SSO enabled
    if (SSO_ENABLED) {
      try {
        const centralResult = await centralLogin({ email: username, password });
        const central = normalizeCentral(centralResult);
        // Gate on the central id, not the email — central accounts may have no email.
        if (central.central_user_id != null) {
          const localUser = await findOrCreateLocalUser(central);
          wrongPasswordsByName.clear(name);
          return res.json({ success: true, token: signToken(localUser), user: localUser });
        }
      } catch (err) {
        console.error('Central login failed, trying local:', err.message);
      }
    }

    const result = await db.query(
      'SELECT id, email, username, password_hash, role, created_at FROM users WHERE (LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($1)) AND is_active = true',
      [username]
    );

    if (result.rows.length === 0) {
      return wrongPassword();
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      return wrongPassword();
    }

    wrongPasswordsByName.clear(name);
    delete user.password_hash;

    res.json({
      success: true,
      token: signToken(user),
      user
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Public config so the client can decide whether to show the SSO button without any
// build-time (VITE) vars — SSO is now configured entirely server-side. authUrl is Waypoint's
// address, for the top bar's "Sign out of all games" (its /logout page).
router.get('/config', (req, res) => {
  res.json({ ssoEnabled: SSO_ENABLED, authUrl: SSO_ENABLED ? AUTH_SERVICE_URL : null });
});

// Begin SSO: remember a random state in an httpOnly cookie and bounce to the auth-service
// authorize endpoint with the SERVER-held client_id. The client_id never reaches the browser.
router.get('/sso/login', (req, res) => {
  if (!SSO_ENABLED) return res.status(503).send('SSO is not configured');
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie(STATE_COOKIE, state, { ...stateCookieOpts(), maxAge: 10 * 60 * 1000 });
  const url = new URL(`${AUTH_SERVICE_URL}/oauth/authorize`);
  url.searchParams.set('client_id', SSO_CLIENT_ID);
  url.searchParams.set('redirect_uri', `${baseUrl(req)}/auth/callback`);
  url.searchParams.set('state', state);
  // Switch account: Waypoint asks which account again instead of reusing its session.
  if (req.query.prompt === 'login') url.searchParams.set('prompt', 'login');
  res.redirect(url.toString());
});

// SSO callback: the client posts the code + state it received; we verify the state against
// our cookie and exchange the code server-side (the client_secret never leaves the server).
router.post('/sso-callback', async (req, res) => {
  if (!SSO_ENABLED) {
    return res.status(404).json({ error: 'SSO not configured' });
  }

  const { code, state } = req.body;
  const expected = req.cookies?.[STATE_COOKIE];
  res.clearCookie(STATE_COOKIE, stateCookieOpts());

  if (!code) {
    return res.status(400).json({ error: 'Authorization code required' });
  }
  if (!state || !expected || state !== expected) {
    return res.status(400).json({ error: 'Invalid or missing SSO state' });
  }

  try {
    const data = await exchangeCode(code);
    const central = normalizeCentral(data);
    const localUser = await findOrCreateLocalUser(central);

    res.json({ success: true, token: signToken(localUser), user: localUser });
  } catch (error) {
    console.error('SSO callback error:', error);
    res.status(401).json({ error: 'SSO authentication failed' });
  }
});

// One-click guest: mint a central guest account and sign in as it — no redirect, no form.
router.post('/guest', async (req, res) => {
  if (!SSO_ENABLED) return res.status(503).json({ error: 'Guest sign-in is not available' });
  try {
    const central = normalizeCentral(await centralGuest());
    const localUser = await findOrCreateLocalUser(central);
    res.json({ success: true, token: signToken(localUser), user: localUser });
  } catch (error) {
    console.error('Guest login error:', error);
    res.status(400).json({ error: error.message || 'Could not start a guest session' });
  }
});

// Get current user
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
