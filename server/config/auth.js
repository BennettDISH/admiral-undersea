// Signing in and the session. Waypoint sign-in and the session are fleet-kit's (its CommonJS
// build): the authorize URL built on the server, the code exchanged server to server at
// /auth/callback (the address Waypoint has registered for the game), one-click guests, and an
// httpOnly __Host-au_session cookie that the REST API and the game's sockets both read. What is
// the game's own is here: the users row, who counts as a guest, and moving players off the old
// token.
const { createWaypoint, verifyJwt } = require('fleet-kit/server');
const db = require('./database');

// A guest is a user Waypoint minted for "Try it as a guest": made by a Waypoint sign-in
// ('sso-managed', with a central id) and named with Waypoint's generated guest name
// (guest-swift-otter-4821, with "#<central id>" when the name was taken here). The guest sweep
// goes by the same rule (services/guestSweep.js).
const GUEST_SQL = "(password_hash = 'sso-managed' AND central_user_id IS NOT NULL AND username ~ '^guest-[a-z]+-[a-z]+-[0-9]{4}(#[0-9]+)?$')";
const ACCOUNT_COLUMNS = `id, email, username, role, created_at, central_user_id, token_version, ${GUEST_SQL} AS is_guest`;

/** The active account with this id, as the session and the pages see it, or null. */
async function account(id) {
  if (!Number.isInteger(id) || id <= 0) return null;
  const { rows } = await db.query(`SELECT ${ACCOUNT_COLUMNS} FROM users WHERE id = $1 AND is_active = true`, [id]);
  return rows[0] || null;
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

/** The local row for a Waypoint account ({ central_user_id, username, email }), found or made;
 *  every sign-in stamps last_seen_at (the guest sweep goes by it). */
async function findOrCreateLocalUser(central) {
  // Check by central_user_id
  if (central.central_user_id != null) {
    const byCentral = await db.query('SELECT id, email, username FROM users WHERE central_user_id = $1', [central.central_user_id]);
    if (byCentral.rows.length > 0) {
      const local = byCentral.rows[0];
      if (local.email !== central.email || local.username !== central.username) {
        await db.query('UPDATE users SET email = $1, username = $2, updated_at = NOW() WHERE id = $3', [central.email, central.username, local.id]);
      }
      await db.query('UPDATE users SET last_seen_at = NOW() WHERE id = $1', [local.id]);
      return account(local.id);
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
  //
  // Adoption also retires the row's local password. Whoever set it never proved they own
  // this email, so leaving it would let them keep signing in to the central owner's row.
  if (central.email) {
    const byEmail = await db.query(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND central_user_id IS NULL',
      [central.email]
    );
    if (byEmail.rows.length > 0) {
      await db.query(
        `UPDATE users SET central_user_id = $1, password_hash = 'sso-managed', updated_at = NOW(), last_seen_at = NOW() WHERE id = $2`,
        [central.central_user_id, byEmail.rows[0].id]
      );
      return account(byEmail.rows[0].id);
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
     RETURNING id`,
    [email, username, 'sso-managed', central.central_user_id]
  );
  return account(created.rows[0].id);
}

/** What /api/auth/me and the sign-in answers hand the page. */
const publicUser = (u) => ({
  id: u.id,
  email: u.email ?? null,
  username: u.username,
  role: u.role,
  created_at: u.created_at,
  is_guest: Boolean(u.is_guest),
  is_admin: Boolean(u.is_admin),
});

const wp = createWaypoint({
  app: 'au',
  appName: 'Admiral Undersea',
  guests: 'allow',
  // Waypoint has the game's callback registered at the page address it always had
  callbackPath: '/auth/callback',
  signInPage: '/login',
  onSignIn: (u) => findOrCreateLocalUser(u),
  publicUser,
  session: {
    load: (claims) => account(Number(claims.sub)),
    // Sign out ends every session of the account, on every device (token_version).
    onSignOut: async (claims) => {
      await db.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1 AND token_version = $2', [Number(claims.sub), Number(claims.tv ?? 0)]);
    },
    // A session in use renews itself once a day; the guest sweep reads last_seen_at, so a guest
    // still playing is never taken.
    onRenew: async (user) => {
      await db.query('UPDATE users SET last_seen_at = NOW() WHERE id = $1', [user.id]);
    },
    // Until 2026-10 the session was a 7-day token the page kept in localStorage and sent as a
    // bearer header (and in the socket handshake). A page that still holds one sends it once to
    // /api/auth/me, which swaps it for the cookie with the end it had, so nobody is signed out
    // by the move. This reader can go a week after the deploy.
    legacy: [{
      bearer: true,
      read: (token) => {
        const c = verifyJwt(token, process.env.JWT_SECRET);
        return c && Number.isInteger(c.id) ? { sub: String(c.id), tv: 0, exp: c.exp } : null;
      },
    }],
  },
});

module.exports = { wp, account, findOrCreateLocalUser, publicUser, GUEST_SQL };
