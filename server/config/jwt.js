const jwt = require('jsonwebtoken');

// A signed session token replaces the old trusted `x-user-id` header. In production a
// real JWT_SECRET is mandatory: falling back to a source-committed constant would let
// anyone mint a token for any user, so we fail closed (refuse to start) instead.
const SECRET = process.env.JWT_SECRET;
const EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

if (!SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('JWT_SECRET must be set in production — refusing to start with an insecure fallback secret.');
}
if (!SECRET) {
  console.warn('WARNING: JWT_SECRET is not set. Using an insecure development fallback — set JWT_SECRET (and NODE_ENV=production) before deploying.');
}
const ACTIVE_SECRET = SECRET || 'dev-insecure-secret-change-me';

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    ACTIVE_SECRET,
    { expiresIn: EXPIRES_IN }
  );
}

function verifyToken(token) {
  return jwt.verify(token, ACTIVE_SECRET);
}

module.exports = { signToken, verifyToken };
