const db = require('../config/database');
const { verifyToken } = require('../config/jwt');

// Verify a signed session token (Authorization: Bearer <token>) and load the fresh
// user row. This replaces the old, forgeable `x-user-id` header.
const requireAuth = async (req, res, next) => {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  let payload;
  try {
    payload = verifyToken(token);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  try {
    const result = await db.query(
      'SELECT id, email, username, role, created_at FROM users WHERE id = $1 AND is_active = true',
      [payload.id]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid user' });
    }

    req.user = result.rows[0];
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
};

module.exports = { requireAuth };
