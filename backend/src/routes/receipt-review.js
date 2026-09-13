const express = require('express');
const crypto = require('crypto');

const db = require('../db');
const { withTransaction } = require('../utils/transaction');
const { staffJwtMiddleware, requireReceiptAccess } = require('../externalAuth');

const router = express.Router();

const PAYMENT_STATUSES = ['PendingPayment', 'NotVerified', 'Accepted', 'Rejected'];
const DECISION_STATUSES = ['Accepted', 'Rejected'];
const TICKET_TYPES = ['HACKATHON', 'TECHPASS', 'NONTECHPASS', 'RACING', 'WORKSHOP'];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

router.use(staffJwtMiddleware, requireReceiptAccess);

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function httpError(status, code, message, extra = {}) {
  const error = new Error(message);
  error.httpStatus = status;
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function sendDatabaseError(res, error) {
  if (error?.httpStatus) {
    const body = { error: error.message };
    if (error.currentStatus) body.current_status = error.currentStatus;
    return res.status(error.httpStatus).json(body);
  }

  if (error?.code === '23505') {
    return res.status(409).json({ error: 'volunteer email or ID is already registered' });
  }

  if (error?.code === '23503') {
    return res.status(409).json({ error: 'the referenced payment or volunteer record is not available' });
  }

  if (error?.code === '22P02') {
    return res.status(400).json({ error: 'invalid database identifier' });
  }

  console.error('Receipt review database error:', error);
  return res.status(500).json({ error: 'server error' });
}

function getPageValue(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) return fallback;
  return Math.min(parsed, maximum);
}

function validateStatusFilter(value) {
  const status = typeof value === 'string' && value.trim() ? value.trim() : 'all';
  if (status !== 'all' && !PAYMENT_STATUSES.includes(status)) {
    throw httpError(400, 'INVALID_STATUS', `status must be one of: all, ${PAYMENT_STATUSES.join(', ')}`);
  }
  return status;
}

function validateTicketTypeFilter(value) {
  const type = typeof value === 'string' && value.trim() ? value.trim() : 'all';
  if (type !== 'all' && !TICKET_TYPES.includes(type)) {
    throw httpError(400, 'INVALID_TICKET_TYPE', `ticket_type must be one of: all, ${TICKET_TYPES.join(', ')}`);
  }
  return type;
}

function buildSubmissionFilter(query) {
  const conditions = [];
  const params = [];
  const status = validateStatusFilter(query.status);
  const ticketType = validateTicketTypeFilter(query.ticket_type);
  const search = typeof query.search === 'string' ? query.search.trim() : '';

  if (status !== 'all') {
    params.push(status);
    conditions.push(`tp.status = $${params.length}`);
  }

  if (ticketType !== 'all') {
    params.push(ticketType);
    conditions.push(`tp.ticket_type = $${params.length}`);
  }

  if (search) {
    params.push(`%${search}%`);
    const searchParameter = `$${params.length}`;
    conditions.push(`(
      tp.ticket_id::text ILIKE ${searchParameter}
      OR u.email ILIKE ${searchParameter}
      OR u.name ILIKE ${searchParameter}
      OR EXISTS (
        SELECT 1
        FROM public.hackathon_regs search_hr
        WHERE search_hr.ticket_id = tp.ticket_id
          AND search_hr.team_name ILIKE ${searchParameter}
      )
    )`);
  }

  return {
    status,
    params,
    whereClause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
  };
}

async function findVolunteerRegistration(volunteerId, executor = db) {
  const result = await executor.query(
    `SELECT volunteer_id, email, dept, name, created_at, updated_at
     FROM public.verification
     WHERE volunteer_id = $1`,
    [volunteerId],
  );
  return result.rows[0] || null;
}

async function requireRegisteredVolunteer(req, res, next) {
  try {
    const volunteer = await findVolunteerRegistration(req.staff.volunteerId);
    if (!volunteer) {
      return res.status(403).json({ error: 'volunteer signup is required before receipt review' });
    }
    req.verificationVolunteer = volunteer;
    return next();
  } catch (error) {
    return sendDatabaseError(res, error);
  }
}

router.get('/volunteers/me', async (req, res) => {
  try {
    const volunteer = await findVolunteerRegistration(req.staff.volunteerId);
    return res.json({
      volunteer_id: req.staff.volunteerId,
      jwt_email: req.staff.email,
      registered: Boolean(volunteer),
      volunteer,
    });
  } catch (error) {
    return sendDatabaseError(res, error);
  }
});

router.get('/submissions', requireRegisteredVolunteer, async (req, res) => {
  try {
    const { params, whereClause } = buildSubmissionFilter(req.query);
    const page = getPageValue(req.query.page, 1, 1, Number.MAX_SAFE_INTEGER);
    const pageSize = getPageValue(req.query.page_size, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const offset = (page - 1) * pageSize;

    const countResult = await db.query(
      `SELECT COUNT(*)::int AS total
       FROM public.ticket_payments tp
       JOIN public.users u ON u.user_id = tp.user_id
       ${whereClause}`,
      params,
    );

    const dataParams = [...params, pageSize, offset];
    const limitParameter = `$${dataParams.length - 1}`;
    const offsetParameter = `$${dataParams.length}`;
    const dataResult = await db.query(
      `SELECT
         tp.ticket_id,
         tp.user_id,
         tp.ticket_type,
         tp.amount_paid,
         tp.s3_url,
         tp.status,
         tp.email_sent,
         tp.created_at,
         tp.updated_at,
         u.email AS participant_email,
         u.phone AS participant_phone,
         u.name AS participant_name,
         u.gender AS participant_gender,
         u.college_name AS participant_college_name,
         u.year_of_study AS participant_year_of_study,
         (
           SELECT jsonb_build_object(
             'team_id', hr.team_id,
             'team_name', hr.team_name,
             'domain', hr.domain,
             'track', hr.track,
             'ps_description', hr.ps_description
           )
           FROM public.hackathon_regs hr
           WHERE hr.ticket_id = tp.ticket_id
           ORDER BY hr.created_at, hr.team_id
           LIMIT 1
         ) AS hackathon,
         COALESCE((
           SELECT jsonb_agg(
             jsonb_build_object(
               'event_id', e.event_id,
               'date', e.date,
               'name', e.name,
               'dept_name', e.dept_name,
               'event_type', e.event_type
             ) ORDER BY e.date, e.name
           )
           FROM public.ticket_event te
           JOIN public.events e ON e.event_id = te.event_id
           WHERE te.ticket_id = tp.ticket_id
         ), '[]'::jsonb) AS events
       FROM public.ticket_payments tp
       JOIN public.users u ON u.user_id = tp.user_id
       ${whereClause}
       ORDER BY tp.created_at DESC, tp.ticket_id DESC
       LIMIT ${limitParameter} OFFSET ${offsetParameter}`,
      dataParams,
    );

    const total = countResult.rows[0]?.total || 0;
    return res.json({
      items: dataResult.rows,
      pagination: {
        page,
        page_size: pageSize,
        total,
        total_pages: total === 0 ? 0 : Math.ceil(total / pageSize),
      },
    });
  } catch (error) {
    return sendDatabaseError(res, error);
  }
});

router.get('/submissions/:ticketId', requireRegisteredVolunteer, async (req, res) => {
  const { ticketId } = req.params;
  if (!isUuid(ticketId)) {
    return res.status(400).json({ error: 'ticket ID must be a valid UUID' });
  }

  try {
    const paymentResult = await db.query(
      `SELECT
         tp.ticket_id,
         tp.user_id,
         tp.ticket_type,
         tp.amount_paid,
         tp.s3_url,
         tp.status,
         tp.email_sent,
         tp.created_at,
         tp.updated_at,
         u.email AS participant_email,
         u.phone AS participant_phone,
         u.name AS participant_name,
         u.gender AS participant_gender,
         u.college_name AS participant_college_name,
         u.year_of_study AS participant_year_of_study,
         (
           SELECT jsonb_build_object(
             'team_id', hr.team_id,
             'team_name', hr.team_name,
             'domain', hr.domain,
             'track', hr.track,
             'ps_description', hr.ps_description
           )
           FROM public.hackathon_regs hr
           WHERE hr.ticket_id = tp.ticket_id
           ORDER BY hr.created_at, hr.team_id
           LIMIT 1
         ) AS hackathon,
         COALESCE((
           SELECT jsonb_agg(
             jsonb_build_object(
               'event_id', e.event_id,
               'date', e.date,
               'name', e.name,
               'dept_name', e.dept_name,
               'event_type', e.event_type,
               'attendance', te.attendance,
               'attendance_timestamp', te.attendance_timestamp
             ) ORDER BY e.date, e.name
           )
           FROM public.ticket_event te
           JOIN public.events e ON e.event_id = te.event_id
           WHERE te.ticket_id = tp.ticket_id
         ), '[]'::jsonb) AS events
       FROM public.ticket_payments tp
       JOIN public.users u ON u.user_id = tp.user_id
       WHERE tp.ticket_id = $1`,
      [ticketId],
    );

    if (paymentResult.rows.length === 0) {
      return res.status(404).json({ error: 'ticket payment not found' });
    }

    const [membersResult, logsResult] = await Promise.all([
      db.query(
        `SELECT
           hm.member_id,
           hm.team_id,
           hm.is_lead,
           hm.name,
           hm.email,
           hm.phno,
           hm.year_of_study,
           hm.created_at,
           hm.updated_at
         FROM public.hackathon_members hm
         JOIN public.hackathon_regs hr ON hr.team_id = hm.team_id
         WHERE hr.ticket_id = $1
         ORDER BY hm.is_lead DESC, hm.created_at, hm.member_id`,
        [ticketId],
      ),
      db.query(
        `SELECT
           pvl.log_id,
           pvl.ticket_id,
           pvl.volunteer_id,
           pvl.action_taken,
           pvl.verif_time,
           pvl.created_at,
           pvl.updated_at,
           v.email AS volunteer_email,
           v.name AS volunteer_name,
           v.dept AS volunteer_dept
         FROM public.payment_verification_log pvl
         JOIN public.verification v ON v.volunteer_id = pvl.volunteer_id
         WHERE pvl.ticket_id = $1
         ORDER BY pvl.verif_time DESC, pvl.log_id DESC`,
        [ticketId],
      ),
    ]);

    const payment = paymentResult.rows[0];
    return res.json({
      submission: {
        ...payment,
        hackathon: payment.hackathon
          ? { ...payment.hackathon, members: membersResult.rows }
          : null,
        verification_logs: logsResult.rows,
      },
    });
  } catch (error) {
    return sendDatabaseError(res, error);
  }
});

router.patch('/submissions/:ticketId/decision', requireRegisteredVolunteer, async (req, res) => {
  const { ticketId } = req.params;
  const { status } = req.body || {};

  if (!isUuid(ticketId)) {
    return res.status(400).json({ error: 'ticket ID must be a valid UUID' });
  }

  if (!DECISION_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'status must be Accepted or Rejected' });
  }

  try {
    const result = await withTransaction(async client => {
      // Keep the FK target locked and verify signup on the same connection
      // used for the payment update and verification log insert.
      const volunteerResult = await client.query(
        `SELECT volunteer_id
         FROM public.verification
         WHERE volunteer_id = $1
         FOR SHARE`,
        [req.staff.volunteerId],
      );

      if (volunteerResult.rows.length === 0) {
        throw httpError(403, 'VOLUNTEER_SIGNUP_REQUIRED', 'volunteer signup is required before receipt review');
      }

      const paymentResult = await client.query(
        `SELECT ticket_id, status
         FROM public.ticket_payments
         WHERE ticket_id = $1
         FOR UPDATE`,
        [ticketId],
      );

      if (paymentResult.rows.length === 0) {
        throw httpError(404, 'PAYMENT_NOT_FOUND', 'ticket payment not found');
      }

      const currentStatus = paymentResult.rows[0].status;
      if (currentStatus !== 'NotVerified') {
        throw httpError(409, 'INVALID_PAYMENT_STATUS', 'only NotVerified payments can be decided', {
          currentStatus,
        });
      }

      const updatedPayment = await client.query(
        `UPDATE public.ticket_payments
         SET status = $1, updated_at = NOW()
         WHERE ticket_id = $2
         RETURNING ticket_id, status, updated_at`,
        [status, ticketId],
      );

      const log = await client.query(
        `INSERT INTO public.payment_verification_log
           (log_id, ticket_id, volunteer_id, action_taken, verif_time, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW(), NOW())
         RETURNING log_id, ticket_id, volunteer_id, action_taken, verif_time, created_at, updated_at`,
        [crypto.randomUUID(), ticketId, req.staff.volunteerId, status],
      );

      return { payment: updatedPayment.rows[0], log: log.rows[0] };
    });

    return res.json(result);
  } catch (error) {
    return sendDatabaseError(res, error);
  }
});

module.exports = router;
