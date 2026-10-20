const db = require('../config/database');

// Site admins are named by their central (Waypoint) account id in ADMIN_CENTRAL_USER_IDS,
// a comma-separated list. Read on every request so a Railway variable change needs no code.
// Unset, empty or unparseable means nobody is an admin: the gate fails closed.
function adminCentralIds() {
  return new Set(
    (process.env.ADMIN_CENTRAL_USER_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s))
  );
}

// The local row's central id decides it. Local-only accounts (no central id) never qualify,
// and neither do guests, whose central ids are minted fresh and never listed.
async function isAdmin(userId) {
  const ids = adminCentralIds();
  if (ids.size === 0) return false;
  const result = await db.query(
    'SELECT central_user_id FROM users WHERE id = $1 AND is_active = true',
    [userId]
  );
  const central = result.rows[0]?.central_user_id;
  return central != null && ids.has(String(central));
}

// Runs after requireAuth. Anyone signed in who is not an admin gets 403.
const requireAdmin = async (req, res, next) => {
  try {
    if (!req.user || !(await isAdmin(req.user.id))) {
      return res.status(403).json({ error: 'Admins only' });
    }
    next();
  } catch (error) {
    console.error('Admin check error:', error);
    res.status(500).json({ error: 'Admin check failed' });
  }
};

module.exports = { requireAdmin, isAdmin, adminCentralIds };
