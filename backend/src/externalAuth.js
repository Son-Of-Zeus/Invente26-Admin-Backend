const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const DEFAULT_ISSUER = 'invente-auth';
const DEFAULT_AUDIENCES = ['invente-admin-api', 'invente-review-api'];
const DEFAULT_ALGORITHM = 'RS256';
// Accept UUIDv4, UUIDv7, and other PostgreSQL UUID values used by the
// participant/auth repositories.
const STAFF_SUBJECT_PATTERN = /^staff:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

function configuredPublicKey() {
  const configuredPublic = process.env.JWT_PUBLIC_KEY;
  if (configuredPublic) return configuredPublic.replace(/\\n/g, '\n');

  const configuredPrivate = process.env.JWT_PRIVATE_KEY;
  if (!configuredPrivate) return null;

  try {
    const privateKey = crypto.createPrivateKey(configuredPrivate.replace(/\\n/g, '\n'));
    return crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  } catch (error) {
    const configError = new Error('JWT_PRIVATE_KEY is invalid');
    configError.code = 'AUTH_CONFIG_MISSING';
    throw configError;
  }
}

function configuredAudiences() {
  const configured = process.env.JWT_AUDIENCES || process.env.JWT_AUDIENCE;
  if (!configured) return DEFAULT_AUDIENCES;

  const audiences = configured.split(',').map(value => value.trim()).filter(Boolean);
  return audiences.length > 0 ? audiences : DEFAULT_AUDIENCES;
}

function getBearerToken(req) {
  const authorization = req.headers.authorization;
  if (!authorization || !authorization.startsWith('Bearer ')) return null;
  const token = authorization.slice('Bearer '.length).trim();
  return token || null;
}

function parseStaffId(subject) {
  const match = STAFF_SUBJECT_PATTERN.exec(String(subject || ''));
  return match ? match[1] : null;
}

function verifyStaffToken(token) {
  const publicKey = configuredPublicKey();
  if (!publicKey) {
    const error = new Error('JWT_PUBLIC_KEY is not configured');
    error.code = 'AUTH_CONFIG_MISSING';
    throw error;
  }

  const payload = jwt.verify(token, publicKey, {
    algorithms: [DEFAULT_ALGORITHM],
    issuer: process.env.JWT_ISSUER || DEFAULT_ISSUER,
    audience: configuredAudiences(),
  });

  if (payload.token_type !== 'access') {
    const error = new Error('invalid token type');
    error.code = 'INVALID_TOKEN_TYPE';
    throw error;
  }

  const staffId = parseStaffId(payload.sub);
  if (!staffId) {
    const error = new Error('invalid staff subject');
    error.code = 'INVALID_STAFF_SUBJECT';
    throw error;
  }

  if (!Array.isArray(payload.roles) || payload.roles.length === 0 || payload.roles.some(role => typeof role !== 'string' || !role.trim())) {
    const error = new Error('token has no valid roles');
    error.code = 'INVALID_ROLES';
    throw error;
  }

  if (typeof payload.email !== 'string' || !payload.email.trim()) {
    const error = new Error('token has no email');
    error.code = 'INVALID_EMAIL';
    throw error;
  }

  const roles = payload.roles.map(role => role.trim());

  return {
    ...payload,
    staffId,
    volunteerId: staffId,
    roles,
    primaryRole: typeof payload.primary_role === 'string' ? payload.primary_role : null,
    // Receipt access is intentionally derived from the presence of a staff
    // role. The shared JWT's permissions claim is not trusted for this rule.
    receiptPermissions: ['receipts:read', 'receipts:review'],
  };
}

/**
 * Authentication for the shared staff JWT. Existing attendance authentication
 * remains in auth.js and is intentionally not changed in this phase.
 */
function staffJwtMiddleware(req, res, next) {
  const token = getBearerToken(req);
  if (!token) return res.status(401).json({ error: 'missing bearer token' });

  try {
    req.staff = verifyStaffToken(token);
    next();
  } catch (error) {
    if (error.code === 'AUTH_CONFIG_MISSING') {
      return res.status(503).json({ error: 'staff JWT verification is not configured' });
    }
    return res.status(401).json({ error: 'invalid staff token' });
  }
}

/**
 * All roles in the shared JWT can view and decide receipts. A non-empty roles
 * claim is still required so an unscoped or malformed token is not accepted.
 */
function requireReceiptAccess(req, res, next) {
  if (!req.staff
    || !Array.isArray(req.staff.roles)
    || req.staff.roles.length === 0
    || !req.staff.receiptPermissions?.includes('receipts:read')
    || !req.staff.receiptPermissions?.includes('receipts:review')) {
    return res.status(403).json({ error: 'receipt access requires a staff role' });
  }
  next();
}

module.exports = {
  staffJwtMiddleware,
  requireReceiptAccess,
  parseStaffId,
  verifyStaffToken,
};
