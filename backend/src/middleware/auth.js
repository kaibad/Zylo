const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'zylo-super-secret-key-2026';

/**
 * Middleware: Requires a valid JWT. Returns 401 if missing or invalid.
 */
function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer <token>

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // { id, username }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Middleware: Optionally reads a JWT. Does NOT block if missing.
 * Attaches req.user if valid token is present.
 */
function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
    } catch {
      // Invalid token — treat as unauthenticated
      req.user = null;
    }
  } else {
    req.user = null;
  }
  next();
}

module.exports = { authenticate, optionalAuth, JWT_SECRET };
