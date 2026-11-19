const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const db = require('../db');

const router = express.Router();

const JWT_ALGORITHM = 'RS256';
const DEFAULT_ISSUER = 'invente-auth';
const DEFAULT_AUDIENCES = ['invente-admin-api', 'invente-review-api'];
const DEFAULT_ACCESS_TTL_SECONDS = 10 * 24 * 60 * 60;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function httpError(status, code, message) {
  const error = new Error(message);
  error.httpStatus = status;
  error.code = code;
  return error;
}

function configurationError(message) {
  const error = new Error(message);
  error.code = 'AUTH_CONFIG_ERROR';
  return error;
}

function normalizedEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function configuredPrivateKey() {
  const value = process.env.JWT_PRIVATE_KEY;
  if (!value) throw configurationError('JWT_PRIVATE_KEY is not configured');

  const pem = value.replace(/\\n/g, '\n');
  try {
    return crypto.createPrivateKey(pem);
  } catch (error) {
    throw configurationError('JWT_PRIVATE_KEY is invalid');
  }
}

function configuredAudiences() {
  const configured = process.env.JWT_AUDIENCES || process.env.JWT_AUDIENCE;
  if (!configured) return DEFAULT_AUDIENCES;

  const audiences = configured.split(',').map(value => value.trim()).filter(Boolean);
  if (audiences.length === 0) throw configurationError('JWT_AUDIENCES is invalid');
  return audiences;
}

function configuredAccessTtl() {
  const value = process.env.JWT_ACCESS_TTL_SECONDS;
  if (value === undefined) return DEFAULT_ACCESS_TTL_SECONDS;

  const ttl = Number(value);
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > DEFAULT_ACCESS_TTL_SECONDS) {
    throw configurationError(`JWT_ACCESS_TTL_SECONDS must be between 60 and ${DEFAULT_ACCESS_TTL_SECONDS}`);
  }
  return ttl;
}

function configuredApprovedVolunteerEmails() {
  const configured = process.env.APPROVED_VOLUNTEER_EMAILS;
  if (typeof configured !== 'string' || configured.trim() === '') {
    throw configurationError('APPROVED_VOLUNTEER_EMAILS is not configured');
  }

  const values = configured
    .split(/[\n,]/)
    .map(normalizedEmail)
    .filter(Boolean);

  if (values.length === 0 || values.some(email => !EMAIL_PATTERN.test(email) || email.length > 255)) {
    throw configurationError('APPROVED_VOLUNTEER_EMAILS contains an invalid email');
  }

  return new Set(values);
}

function validateEmail(email) {
  if (!email || email.length > 255 || !EMAIL_PATTERN.test(email)) {
    throw httpError(400, 'INVALID_EMAIL', 'a valid email is required');
  }
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw httpError(400, 'INVALID_PASSWORD', 'password is required');
  }
  if (Buffer.byteLength(password, 'utf8') < 8) {
    throw httpError(400, 'PASSWORD_TOO_SHORT', 'password must be at least 8 bytes');
  }
  if (Buffer.byteLength(password, 'utf8') > 72) {
    throw httpError(400, 'PASSWORD_TOO_LONG', 'password must be at most 72 bytes');
  }
}

function validateProfile(body) {
  const email = normalizedEmail(body?.email);
  const password = body?.password;
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const rawDept = body?.dept;

  validateEmail(email);
  validatePassword(password);

  if (!name || name.length > 255) {
    throw httpError(400, 'INVALID_NAME', 'name must be between 1 and 255 characters');
  }

  let dept = null;
  if (rawDept !== undefined && rawDept !== null) {
    if (typeof rawDept !== 'string' || rawDept.trim().length > 100) {
      throw httpError(400, 'INVALID_DEPARTMENT', 'dept must be at most 100 characters');
    }
    dept = rawDept.trim() || null;
  }

  return { email, password, name, dept };
}

function permissionsForRoles(roles) {
  const permissions = new Set();

  // Every issued staff role is allowed to view and decide receipts. The
  // permission list is derived here and is never accepted from the client.
  roles.forEach(role => {
    if (typeof role === 'string' && role.trim()) {
      permissions.add('receipts:read');
      permissions.add('receipts:review');
    }
    if (role === 'volunteer') permissions.add('registrations:onspot:create');
  });

  return [...permissions];
}

function issueStaffToken(volunteer) {
  const privateKey = configuredPrivateKey();
  const audiences = configuredAudiences();
  const expiresIn = configuredAccessTtl();
  const roles = ['volunteer', 'receipt_read_write'];

  const token = jwt.sign(
    {
      token_type: 'access',
      email: volunteer.email,
      primary_role: 'volunteer',
      roles,
      permissions: permissionsForRoles(roles),
      department_ids: [],
      event_ids: [],
    },
    privateKey,
    {
      algorithm: JWT_ALGORITHM,
      issuer: process.env.JWT_ISSUER || DEFAULT_ISSUER,
      audience: audiences,
      subject: `staff:${volunteer.volunteer_id}`,
      jwtid: crypto.randomUUID(),
      notBefore: 0,
      expiresIn,
    },
  );

  const claims = jwt.decode(token);
  return {
    token,
    token_type: 'Bearer',
    expires_in: expiresIn,
    expires_at: claims.exp,
    user: {
      volunteer_id: volunteer.volunteer_id,
      email: volunteer.email,
      name: volunteer.name,
      dept: volunteer.dept,
      primary_role: claims.primary_role,
      roles: claims.roles,
      permissions: claims.permissions,
    },
  };
}

function handleAuthError(res, error) {
  if (error?.httpStatus) {
    return res.status(error.httpStatus).json({ error: error.message, code: error.code });
  }

  if (error?.code === 'AUTH_CONFIG_ERROR') {
    console.error('Staff auth configuration error:', error.message);
    return res.status(503).json({ error: 'staff authentication is not configured' });
  }

  if (error?.code === '23505') {
    return res.status(409).json({ error: 'volunteer email is already registered' });
  }

  console.error('Staff auth error:', error);
  return res.status(500).json({ error: 'server error' });
}

async function signupHandler(req, res) {
  try {
    const values = validateProfile(req.body || {});
    const approvedEmails = configuredApprovedVolunteerEmails();

    if (!approvedEmails.has(values.email)) {
      return res.status(403).json({ error: 'this email is not approved for volunteer signup' });
    }

    // Validate the signing key before inserting the account. This avoids
    // creating an account that cannot receive the token required to use it.
    configuredPrivateKey();

    const passwordHash = await bcrypt.hash(values.password, 12);
    const result = await db.query(
      `INSERT INTO public.verification
         (volunteer_id, email, password_hash, dept, name)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING volunteer_id, email, dept, name, created_at, updated_at`,
      [crypto.randomUUID(), values.email, passwordHash, values.dept, values.name],
    );

    const volunteer = result.rows[0];
    return res.status(201).json({
      ...issueStaffToken(volunteer),
      volunteer,
    });
  } catch (error) {
    return handleAuthError(res, error);
  }
}

async function loginHandler(req, res) {
  try {
    const email = normalizedEmail(req.body?.email);
    const password = req.body?.password;

    validateEmail(email);
    validatePassword(password);
    configuredPrivateKey();

    const result = await db.query(
      `SELECT volunteer_id, email, password_hash, dept, name
       FROM public.verification
       WHERE LOWER(email) = $1
       LIMIT 1`,
      [email],
    );
    const volunteer = result.rows[0];

    if (!volunteer || !(await bcrypt.compare(password, volunteer.password_hash))) {
      return res.status(401).json({ error: 'invalid credentials' });
    }

    return res.json(issueStaffToken(volunteer));
  } catch (error) {
    return handleAuthError(res, error);
  }
}

router.post('/signup', signupHandler);
router.post('/login', loginHandler);

module.exports = { router, loginHandler, signupHandler, permissionsForRoles };
