const express = require('express');
const crypto = require('crypto');

const db = require('../db');
const { withTransaction, lockPaymentId } = require('../utils/transaction');
const { staffJwtMiddleware, requireReceiptAccess } = require('../externalAuth');
const { isPaymentId } = require('../utils/paymentId');

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
    const body = { error: error.message, code: error.code };
    if (error.currentStatus) body.current_status = error.currentStatus;
    if (error.paymentId) body.payment_id = error.paymentId;
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

  if (isPaymentId(search)) {
    params.push(search);
    conditions.push(`tp.payment_id = $${params.length}`);
  } else if (search) {
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

    const countPromise = db.query(
      `SELECT COUNT(*)::int AS total
       FROM public.ticket_payments tp
       JOIN public.users u ON u.user_id = tp.user_id
       ${whereClause}`,
      params,
    );

    const dataParams = [...params, pageSize, offset];
    const limitParameter = `$${dataParams.length - 1}`;
    const offsetParameter = `$${dataParams.length}`;
    const [countResult, dataResult] = await Promise.all([
      countPromise,
      db.query(
        `SELECT tp.ticket_id
         FROM public.ticket_payments tp
         JOIN public.users u ON u.user_id = tp.user_id
         ${whereClause}
         ORDER BY tp.created_at DESC, tp.ticket_id DESC
         LIMIT ${limitParameter} OFFSET ${offsetParameter}`,
        dataParams,
      ),
    ]);

    // Fetch the complete review payload for the page in set-based queries.
    // This keeps the list endpoint ready for review without N per-ticket
    // detail requests from the client.
    const ticketIds = dataResult.rows.map(row => row.ticket_id);
    const summaries = await loadReviewSummaries(db, ticketIds);
    const items = ticketIds.map(ticketId => summaries.get(ticketId)).filter(Boolean);

    const total = countResult.rows[0]?.total || 0;
    return res.json({
      items,
      registered: true,
      volunteer: req.verificationVolunteer,
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

function logManualPaymentIdAttempt(req, ticketId, outcome) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    event: 'manual_payment_id',
    volunteer_id: req.staff.volunteerId,
    ticket_id: ticketId,
    outcome,
  }));
}

async function saveManualPaymentId(client, ticketId, paymentId) {
  // Coordinate the manual path with OCR before locking the ticket row.
  await lockPaymentId(client, paymentId);
  const paymentResult = await client.query(
    `SELECT ticket_id, status, payment_id, s3_url
     FROM public.ticket_payments
     WHERE ticket_id = $1
     FOR UPDATE`,
    [ticketId],
  );

  if (paymentResult.rows.length === 0) {
    throw httpError(404, 'PAYMENT_NOT_FOUND', 'ticket payment not found');
  }

  const current = paymentResult.rows[0];
  if (current.payment_id === null) {
    throw httpError(409, 'PAYMENT_ID_NOT_QUEUED', 'payment ID is not in the queued state');
  }

  if (current.payment_id !== 'queued') {
    throw httpError(409, 'PAYMENT_ID_ALREADY_PRESENT', 'a payment ID is already present for this ticket');
  }

  if (current.status !== 'NotVerified') {
    throw httpError(409, 'INVALID_PAYMENT_STATUS', 'only NotVerified payments can receive a manual payment ID', {
      currentStatus: current.status,
    });
  }

  if (!current.s3_url) {
    throw httpError(409, 'RECEIPT_URL_MISSING', 'a receipt URL is required before entering a payment ID');
  }

  const updateResult = await client.query(
    `UPDATE public.ticket_payments
     SET payment_id = $1
     WHERE ticket_id = $2
       AND status = 'NotVerified'
       AND payment_id = 'queued'
     RETURNING ticket_id, payment_id, updated_at`,
    [paymentId, ticketId],
  );

  if (updateResult.rows.length === 0) {
    throw httpError(409, 'PAYMENT_ID_ALREADY_PRESENT', 'a payment ID is already present for this ticket');
  }

  return updateResult.rows[0];
}

function validatePaymentIdForDecision(status, paymentId) {
  if (status === 'Accepted' && !isPaymentId(paymentId)) {
    throw httpError(409, 'PAYMENT_ID_REQUIRED', 'a valid payment ID is required before accepting this payment');
  }
}

function validateConflictPaymentId(paymentId) {
  if (!isPaymentId(paymentId)) {
    throw httpError(400, 'INVALID_PAYMENT_ID', 'payment_id must match pay_ followed by exactly 14 letters or digits');
  }
}

function buildConflictMetadata(candidates, paymentId) {
  const rows = Array.isArray(candidates) ? candidates : [];
  const accepted = rows.filter(row => row.status === 'Accepted');
  const notVerified = rows.filter(row => row.status === 'NotVerified');
  const rejected = rows.filter(row => row.status === 'Rejected');
  const invalid = rows.filter(row => !['Accepted', 'NotVerified', 'Rejected'].includes(row.status));
  const missingReceipt = rows.filter(row => !row.s3_url);

  // A group is resolved only when exactly one Accepted candidate remains and
  // there are no undecided or unexpected-status rows. All-rejected and other
  // historical anomalies stay unresolved so they remain visible for repair.
  const state = accepted.length === 1 && notVerified.length === 0 && invalid.length === 0
    ? 'resolved'
    : 'unresolved';

  let blockedReason = null;
  if (rows.length < 2) blockedReason = 'NOT_A_CONFLICT';
  else if (invalid.length > 0) blockedReason = 'INVALID_PAYMENT_STATE';
  else if (accepted.length > 1) blockedReason = 'MULTIPLE_ACCEPTED_CANDIDATES';
  else if (accepted.length === 0 && notVerified.length === 0) blockedReason = 'NO_ACCEPTED_WINNER';
  else if (missingReceipt.length > 0) blockedReason = 'RECEIPT_URL_MISSING';
  else if (state === 'resolved') blockedReason = null;

  return {
    payment_id: paymentId || rows[0]?.payment_id || null,
    state,
    candidate_count: rows.length,
    accepted_count: accepted.length,
    not_verified_count: notVerified.length,
    rejected_count: rejected.length,
    invalid_count: invalid.length,
    missing_receipt_count: missingReceipt.length,
    blocked: Boolean(blockedReason),
    blocked_reason: blockedReason,
    winner_ticket_id: accepted.length === 1 ? accepted[0].ticket_id : null,
  };
}

function buildConflictSearch(query, params) {
  const search = typeof query?.search === 'string' ? query.search.trim() : '';
  if (!search) return '';

  params.push(isPaymentId(search) ? search : `%${search}%`);
  const parameter = `$${params.length}`;
  if (isPaymentId(search)) return `AND EXISTS (
    SELECT 1 FROM candidate_rows search_candidate
    WHERE search_candidate.payment_id = grouped.payment_id
      AND search_candidate.payment_id = ${parameter}
  )`;
  return `AND (
    EXISTS (
      SELECT 1 FROM candidate_rows search_candidate
      WHERE search_candidate.payment_id = grouped.payment_id
        AND (
          search_candidate.payment_id ILIKE ${parameter}
          OR search_candidate.ticket_id::text ILIKE ${parameter}
          OR search_candidate.email ILIKE ${parameter}
          OR search_candidate.name ILIKE ${parameter}
          OR EXISTS (
            SELECT 1
            FROM public.hackathon_regs search_hr
            WHERE search_hr.ticket_id = search_candidate.ticket_id
              AND search_hr.team_name ILIKE ${parameter}
          )
        )
    )
  )`;
}

function validateConflictState(value) {
  const state = typeof value === 'string' && value.trim() ? value.trim() : 'unresolved';
  if (!['unresolved', 'resolved'].includes(state)) {
    throw httpError(400, 'INVALID_CONFLICT_STATE', 'state must be unresolved or resolved');
  }
  return state;
}

async function findConflictCandidates(executor, paymentId, forUpdate = false) {
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await executor.query(
    `SELECT
       tp.ticket_id,
       tp.user_id,
       tp.ticket_type,
       tp.amount_paid,
       tp.s3_url,
       tp.payment_id,
       tp.status,
       tp.email_sent,
       tp.created_at,
       tp.updated_at
     FROM public.ticket_payments tp
     WHERE tp.payment_id = $1
     ORDER BY tp.created_at, tp.ticket_id${lockClause}`,
    [paymentId],
  );
  return result.rows;
}

/**
 * Load review-ready summaries for a set of tickets. Every child collection is
 * fetched with one ANY query, so this function is safe for a paginated page
 * and for a multi-candidate conflict detail view.
 */
async function loadReviewSummaries(executor, ticketIds, options = {}) {
  const ids = [...new Set((Array.isArray(ticketIds) ? ticketIds : []).filter(isUuid))];
  if (ids.length === 0) return new Map();

  const [paymentResult, eventsResult, hackathonResult, logsResult] = await Promise.all([
    executor.query(
      `SELECT
         tp.ticket_id,
         tp.user_id,
         tp.ticket_type,
         tp.amount_paid,
         tp.s3_url,
         tp.payment_id,
         tp.status,
         tp.email_sent,
         tp.created_at,
         tp.updated_at,
         u.email AS participant_email,
         u.phone AS participant_phone,
         u.name AS participant_name,
         u.gender AS participant_gender,
         u.college_name AS participant_college_name,
         u.year_of_study AS participant_year_of_study
       FROM public.ticket_payments tp
       JOIN public.users u ON u.user_id = tp.user_id
       WHERE tp.ticket_id = ANY($1::uuid[])`,
      [ids],
    ),
    executor.query(
      `SELECT
         te.ticket_id,
         e.event_id,
         e.date,
         e.name,
         e.dept_name,
         e.event_type
       FROM public.ticket_event te
       JOIN public.events e ON e.event_id = te.event_id
       WHERE te.ticket_id = ANY($1::uuid[])
       ORDER BY te.ticket_id, e.date, e.name`,
      [ids],
    ),
    executor.query(
      `SELECT
         ranked_hr.ticket_id,
         ranked_hr.team_id,
         ranked_hr.team_name,
         ranked_hr.domain,
         ranked_hr.track,
         ranked_hr.ps_description,
         hm.member_id,
         hm.is_lead,
         hm.name,
         hm.email,
         hm.phno,
         hm.year_of_study,
         hm.created_at,
         hm.updated_at
       FROM (
         SELECT
           hr.ticket_id,
           hr.team_id,
           hr.team_name,
           hr.domain,
           hr.track,
           hr.ps_description,
           ROW_NUMBER() OVER (
             PARTITION BY hr.ticket_id
             ORDER BY hr.created_at, hr.team_id
           ) AS registration_rank
         FROM public.hackathon_regs hr
         WHERE hr.ticket_id = ANY($1::uuid[])
       ) ranked_hr
       LEFT JOIN public.hackathon_members hm ON hm.team_id = ranked_hr.team_id
       WHERE ranked_hr.registration_rank = 1
       ORDER BY ranked_hr.ticket_id, hm.is_lead DESC NULLS LAST, hm.created_at, hm.member_id`,
      [ids],
    ),
    executor.query(
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
       WHERE pvl.ticket_id = ANY($1::uuid[])
       ORDER BY pvl.ticket_id, pvl.verif_time DESC, pvl.log_id DESC`,
      [ids],
    ),
  ]);

  const eventsByTicket = new Map();
  for (const event of eventsResult.rows) {
    const events = eventsByTicket.get(event.ticket_id) || [];
    const {
      ticket_id: ignoredTicketId,
      ...eventPayload
    } = event;
    events.push(eventPayload);
    eventsByTicket.set(ignoredTicketId, events);
  }

  const hackathonsByTicket = new Map();
  const membersByTicket = new Map();
  for (const row of hackathonResult.rows) {
    if (!hackathonsByTicket.has(row.ticket_id)) {
      hackathonsByTicket.set(row.ticket_id, {
        team_id: row.team_id,
        team_name: row.team_name,
        domain: row.domain,
        track: row.track,
        ps_description: row.ps_description,
      });
    }
    if (row.member_id !== null && row.member_id !== undefined) {
      const members = membersByTicket.get(row.ticket_id) || [];
      members.push({
        member_id: row.member_id,
        team_id: row.team_id,
        is_lead: row.is_lead,
        name: row.name,
        email: row.email,
        phno: row.phno,
        year_of_study: row.year_of_study,
        created_at: row.created_at,
        updated_at: row.updated_at,
      });
      membersByTicket.set(row.ticket_id, members);
    }
  }
  const logsByTicket = new Map();
  for (const log of logsResult.rows) {
    const logs = logsByTicket.get(log.ticket_id) || [];
    logs.push(log);
    logsByTicket.set(log.ticket_id, logs);
  }

  const payments = paymentResult.rows.map(payment => ({
    ...payment,
    events: eventsByTicket.get(payment.ticket_id) || [],
    hackathon: hackathonsByTicket.has(payment.ticket_id)
      ? {
        ...hackathonsByTicket.get(payment.ticket_id),
        members: membersByTicket.get(payment.ticket_id) || [],
      }
      : null,
    verification_logs: logsByTicket.get(payment.ticket_id) || [],
  }));

  let conflictsByPayment = new Map();
  if (options.includeConflicts !== false) {
    conflictsByPayment = await loadConflictMetadata(executor, payments.map(payment => payment.payment_id));
  }

  return new Map(payments.map(payment => [
    payment.ticket_id,
    { ...payment, conflict: conflictsByPayment.get(payment.payment_id) || null },
  ]));
}

async function loadConflictMetadata(executor, paymentIds) {
  const ids = [...new Set((Array.isArray(paymentIds) ? paymentIds : []).filter(isPaymentId))];
  if (ids.length === 0) return new Map();

  const result = await executor.query(
    `SELECT
       tp.ticket_id,
       tp.payment_id,
       tp.status,
       tp.s3_url
     FROM public.ticket_payments tp
     WHERE tp.payment_id = ANY($1::text[])
     ORDER BY tp.payment_id, tp.created_at, tp.ticket_id`,
    [ids],
  );
  const candidatesByPayment = new Map();
  for (const candidate of result.rows) {
    const candidates = candidatesByPayment.get(candidate.payment_id) || [];
    candidates.push(candidate);
    candidatesByPayment.set(candidate.payment_id, candidates);
  }

  const metadataByPayment = new Map();
  for (const [paymentId, candidates] of candidatesByPayment) {
    if (candidates.length > 1) {
      metadataByPayment.set(paymentId, buildConflictMetadata(candidates, paymentId));
    }
  }
  return metadataByPayment;
}

async function resolvePaymentConflict(client, paymentId, winnerTicketId, volunteerId) {
  validateConflictPaymentId(paymentId);
  if (!isUuid(winnerTicketId)) {
    throw httpError(400, 'INVALID_TICKET_ID', 'winner_ticket_id must be a valid UUID');
  }

  // This lock is transaction-scoped and uses the payment ID as its key. It
  // serializes resolution with both another conflict resolver and a normal
  // single-ticket decision before row locks are acquired.
  await lockPaymentId(client, paymentId);

  const volunteerResult = await client.query(
    `SELECT volunteer_id
     FROM public.verification
     WHERE volunteer_id = $1
     FOR SHARE`,
    [volunteerId],
  );
  if (volunteerResult.rows.length === 0) {
    throw httpError(403, 'VOLUNTEER_SIGNUP_REQUIRED', 'volunteer signup is required before receipt review');
  }

  const candidates = await findConflictCandidates(client, paymentId, true);
  if (candidates.length === 0) {
    throw httpError(404, 'CONFLICT_NOT_FOUND', 'payment conflict not found');
  }
  if (candidates.length < 2) {
    throw httpError(409, 'CONFLICT_NOT_FOUND', 'payment ID does not have multiple candidates');
  }

  const metadata = buildConflictMetadata(candidates, paymentId);
  if (metadata.blocked) {
    throw httpError(409, 'CONFLICT_INVALID_STATE', 'payment conflict cannot be resolved in its current state', {
      currentStatus: metadata.blocked_reason,
    });
  }

  const winner = candidates.find(candidate => candidate.ticket_id === winnerTicketId);
  if (!winner) {
    throw httpError(404, 'WINNER_TICKET_NOT_FOUND', 'winner ticket is not part of this payment conflict');
  }
  if (!winner.s3_url) {
    throw httpError(409, 'RECEIPT_URL_MISSING', 'a receipt URL is required before resolving a payment conflict');
  }

  const accepted = candidates.filter(candidate => candidate.status === 'Accepted');
  const notVerified = candidates.filter(candidate => candidate.status === 'NotVerified');
  if (accepted.length === 1 && accepted[0].ticket_id !== winnerTicketId) {
    throw httpError(409, 'CONFLICT_WINNER_LOCKED', 'the existing Accepted candidate is the locked winner', {
      currentStatus: accepted[0].ticket_id,
    });
  }
  if (accepted.length === 0 && winner.status !== 'NotVerified') {
    throw httpError(409, 'INVALID_CONFLICT_WINNER', 'winner_ticket_id must identify a NotVerified candidate');
  }
  if (accepted.length === 1 && winner.status !== 'Accepted') {
    throw httpError(409, 'CONFLICT_WINNER_LOCKED', 'the existing Accepted candidate is the locked winner');
  }
  if (notVerified.some(candidate => !candidate.s3_url)) {
    throw httpError(409, 'RECEIPT_URL_MISSING', 'all NotVerified candidates must have receipt URLs before resolution');
  }

  const changed = [];
  const logRows = [];
  for (const candidate of candidates) {
    const nextStatus = candidate.ticket_id === winnerTicketId ? 'Accepted'
      : candidate.status === 'NotVerified' ? 'Rejected' : candidate.status;
    if (nextStatus === candidate.status) continue;

    const updateResult = await client.query(
      `UPDATE public.ticket_payments
       SET status = $1, updated_at = NOW()
       WHERE ticket_id = $2
       RETURNING ticket_id, status, updated_at`,
      [nextStatus, candidate.ticket_id],
    );
    if (updateResult.rows.length !== 1) {
      throw httpError(409, 'CONFLICT_UPDATE_FAILED', 'payment conflict changed before resolution');
    }

    const logResult = await client.query(
      `INSERT INTO public.payment_verification_log
         (log_id, ticket_id, volunteer_id, action_taken, verif_time, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW(), NOW())
       RETURNING log_id, ticket_id, volunteer_id, action_taken, verif_time, created_at, updated_at`,
      [crypto.randomUUID(), candidate.ticket_id, volunteerId, nextStatus],
    );
    changed.push(updateResult.rows[0]);
    logRows.push(logResult.rows[0]);
  }

  return {
    payment_id: paymentId,
    winner_ticket_id: winnerTicketId,
    changed: changed.length,
    payments: changed,
    logs: logRows,
  };
}

router.patch('/submissions/:ticketId/payment-id', requireRegisteredVolunteer, async (req, res) => {
  const { ticketId } = req.params;
  const paymentId = req.body?.payment_id;

  if (!isUuid(ticketId)) {
    return res.status(400).json({
      error: 'ticket ID must be a valid UUID',
      code: 'INVALID_TICKET_ID',
    });
  }

  if (!isPaymentId(paymentId)) {
    logManualPaymentIdAttempt(req, ticketId, 'invalid_payment_id');
    return res.status(400).json({
      error: 'payment_id must match pay_ followed by exactly 14 letters or digits',
      code: 'INVALID_PAYMENT_ID',
    });
  }

  try {
    const payment = await withTransaction(client => saveManualPaymentId(client, ticketId, paymentId));

    logManualPaymentIdAttempt(req, ticketId, 'payment_id_saved');
    return res.json({ payment });
  } catch (error) {
    logManualPaymentIdAttempt(req, ticketId, error.code || 'database_error');
    return sendDatabaseError(res, error);
  }
});

/**
 * List duplicate, valid payment IDs. The aggregation happens before LIMIT /
 * OFFSET so pagination is over payment-ID groups rather than tickets.
 */
router.get('/conflicts', requireRegisteredVolunteer, async (req, res) => {
  try {
    const state = validateConflictState(req.query.state);
    const page = getPageValue(req.query.page, 1, 1, Number.MAX_SAFE_INTEGER);
    const pageSize = getPageValue(req.query.page_size, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const params = [];
    const searchClause = buildConflictSearch(req.query, params);
    const stateParameter = params.length + 1;
    params.push(state);
    const limitParameter = params.length + 1;
    const offsetParameter = params.length + 2;
    const offset = (page - 1) * pageSize;
    params.push(pageSize, offset);

    const cte = `
      WITH candidate_rows AS (
        SELECT
          tp.payment_id,
          tp.ticket_id,
          tp.status,
          tp.s3_url,
          tp.created_at,
          tp.updated_at,
          u.email,
          u.name
        FROM public.ticket_payments tp
        JOIN public.users u ON u.user_id = tp.user_id
        WHERE tp.payment_id ~ '^pay_[A-Za-z0-9]{14}$'
      ), grouped AS (
        SELECT
          cr.payment_id,
          COUNT(*)::int AS candidate_count,
          COUNT(*) FILTER (WHERE cr.status = 'Accepted')::int AS accepted_count,
          COUNT(*) FILTER (WHERE cr.status = 'NotVerified')::int AS not_verified_count,
          COUNT(*) FILTER (WHERE cr.status = 'Rejected')::int AS rejected_count,
          COUNT(*) FILTER (
            WHERE cr.status IS NULL OR cr.status NOT IN ('Accepted', 'NotVerified', 'Rejected')
          )::int AS invalid_count,
          COUNT(*) FILTER (WHERE cr.s3_url IS NULL OR cr.s3_url = '')::int AS missing_receipt_count,
          MIN(cr.created_at) AS created_at,
          MAX(cr.updated_at) AS updated_at,
          CASE
            WHEN COUNT(*) FILTER (WHERE cr.status = 'Accepted') = 1
              AND COUNT(*) FILTER (WHERE cr.status = 'NotVerified') = 0
              AND COUNT(*) FILTER (WHERE cr.status IS NULL OR cr.status NOT IN ('Accepted', 'NotVerified', 'Rejected')) = 0
              THEN 'resolved'
            ELSE 'unresolved'
          END AS state
        FROM candidate_rows cr
        GROUP BY cr.payment_id
        HAVING COUNT(*) > 1
      )`;

    const countResult = await db.query(
      `${cte}
       SELECT COUNT(*)::int AS total
       FROM grouped
       WHERE state = $${stateParameter}
       ${searchClause}`,
      params.slice(0, stateParameter),
    );
    const unresolvedResult = await db.query(
      `WITH grouped AS (
         SELECT tp.payment_id,
           COUNT(*) FILTER (WHERE tp.status = 'Accepted')::int AS accepted_count,
           COUNT(*) FILTER (WHERE tp.status = 'NotVerified')::int AS not_verified_count,
           COUNT(*) FILTER (WHERE tp.status IS NULL OR tp.status NOT IN ('Accepted', 'NotVerified', 'Rejected'))::int AS invalid_count,
           COUNT(*) FILTER (WHERE tp.s3_url IS NULL OR tp.s3_url = '')::int AS missing_receipt_count
         FROM public.ticket_payments tp
         WHERE tp.payment_id ~ '^pay_[A-Za-z0-9]{14}$'
         GROUP BY tp.payment_id
         HAVING COUNT(*) > 1
       )
       SELECT COUNT(*)::int AS unresolved_total
       FROM grouped
       WHERE NOT (
         (accepted_count = 1 AND not_verified_count = 0 AND invalid_count = 0)
       )`,
      [],
    );
    const dataResult = await db.query(
      `${cte}
       SELECT payment_id, candidate_count, accepted_count, not_verified_count,
              rejected_count, invalid_count, missing_receipt_count,
              created_at, updated_at, state,
              (
                invalid_count > 0
                OR accepted_count > 1
                OR missing_receipt_count > 0
                OR (accepted_count = 0 AND not_verified_count = 0)
              ) AS blocked
       FROM grouped
       WHERE state = $${stateParameter}
       ${searchClause}
       ORDER BY updated_at DESC NULLS LAST, payment_id
       LIMIT $${limitParameter} OFFSET $${offsetParameter}`,
      params,
    );

    const total = countResult.rows[0]?.total || 0;
    return res.json({
      items: dataResult.rows,
      unresolved_total: unresolvedResult.rows[0]?.unresolved_total || 0,
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

router.get('/conflicts/:paymentId', requireRegisteredVolunteer, async (req, res) => {
  const { paymentId } = req.params;
  try {
    validateConflictPaymentId(paymentId);
    const candidates = await findConflictCandidates(db, paymentId);
    if (candidates.length === 0) {
      return res.status(404).json({ error: 'payment conflict not found', code: 'CONFLICT_NOT_FOUND' });
    }
    if (candidates.length < 2) {
      return res.status(409).json({
        error: 'payment ID does not have multiple candidates',
        code: 'CONFLICT_NOT_FOUND',
        payment_id: paymentId,
      });
    }

    const summariesByTicket = await loadReviewSummaries(
      db,
      candidates.map(candidate => candidate.ticket_id),
      { includeConflicts: false },
    );
    const summaries = candidates.map(candidate => summariesByTicket.get(candidate.ticket_id) || {
      ...candidate,
      hackathon: null,
      verification_logs: [],
    });
    const metadata = buildConflictMetadata(candidates, paymentId);
    return res.json({ ...metadata, candidates: summaries });
  } catch (error) {
    if (error.httpStatus) return sendDatabaseError(res, error);
    return sendDatabaseError(res, error);
  }
});

router.patch('/conflicts/:paymentId/decision', requireRegisteredVolunteer, async (req, res) => {
  const { paymentId } = req.params;
  const winnerTicketId = req.body?.winner_ticket_id;
  try {
    validateConflictPaymentId(paymentId);
    if (!isUuid(winnerTicketId)) {
      return res.status(400).json({
        error: 'winner_ticket_id must be a valid UUID',
        code: 'INVALID_TICKET_ID',
      });
    }

    const result = await withTransaction(client => (
      resolvePaymentConflict(client, paymentId, winnerTicketId, req.staff.volunteerId)
    ));
    return res.json(result);
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
      // Read the payment ID before taking a row lock, then serialize all
      // paths that use a real payment ID before locking the ticket.
      const paymentSnapshotResult = await client.query(
         `SELECT ticket_id, status, payment_id
          FROM public.ticket_payments
         WHERE ticket_id = $1`,
        [ticketId],
      );

      if (paymentSnapshotResult.rows.length === 0) {
        throw httpError(404, 'PAYMENT_NOT_FOUND', 'ticket payment not found');
      }

      const paymentSnapshot = paymentSnapshotResult.rows[0];
      if (isPaymentId(paymentSnapshot.payment_id)) {
        await lockPaymentId(client, paymentSnapshot.payment_id);
      }

      // Keep the FK target locked and verify signup on the same connection
      // used for the payment update and verification log insert. This comes
      // after the payment advisory lock so every payment row lock has the
      // same lock ordering as OCR and conflict resolution.
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
        `SELECT ticket_id, status, payment_id
         FROM public.ticket_payments
         WHERE ticket_id = $1
         FOR UPDATE`,
        [ticketId],
      );
      const current = paymentResult.rows[0];
      const currentStatus = current.status;
      if (currentStatus !== 'NotVerified') {
        throw httpError(409, 'INVALID_PAYMENT_STATUS', 'only NotVerified payments can be decided', {
          currentStatus,
        });
      }

      validatePaymentIdForDecision(status, current.payment_id);

      if (isPaymentId(current.payment_id)) {
        const conflictCandidates = await findConflictCandidates(client, current.payment_id, true);
        if (conflictCandidates.length > 1) {
          // Any duplicate real-ID group needs comparison in the conflict UI;
          // invalid historical states and missing receipts are explained by
          // the detail metadata rather than being silently decided here.
          throw httpError(409, 'CONFLICT_REVIEW_REQUIRED', 'resolve the payment-ID conflict before deciding this ticket', {
            paymentId: current.payment_id,
          });
        }
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
module.exports._test = {
  buildSubmissionFilter,
  saveManualPaymentId,
  validatePaymentIdForDecision,
  validateConflictPaymentId,
  validateConflictState,
  buildConflictSearch,
  buildConflictMetadata,
  findConflictCandidates,
  loadReviewSummaries,
  loadConflictMetadata,
  resolvePaymentConflict,
};
