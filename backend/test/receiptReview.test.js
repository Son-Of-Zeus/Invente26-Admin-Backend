const test = require('node:test');
const assert = require('node:assert/strict');

const receiptReviewRouter = require('../src/routes/receipt-review');

const {
  buildSubmissionFilter,
  saveManualPaymentId,
  validatePaymentIdForDecision,
  validateConflictPaymentId,
  buildConflictSearch,
  buildConflictMetadata,
  loadReviewSummaries,
  loadConflictMetadata,
  resolvePaymentConflict,
} = receiptReviewRouter._test;

const TICKET_ID = '01a08f68-88ac-7abc-8def-533944cbcac7';
const SECOND_TICKET_ID = '01a08f68-88ac-7abc-8def-533944cbcac8';
const PAYMENT_ID = 'pay_1234567890ABCD';
const SECOND_PAYMENT_ID = 'pay_ABCDEFGHIJKLMN';

test('does not expose the legacy submission detail GET while retaining ticket PATCH actions', () => {
  const routes = receiptReviewRouter.stack
    .filter(layer => layer.route)
    .flatMap(layer => Object.keys(layer.route.methods).map(method => ({
      method,
      path: layer.route.path,
    })));

  assert.equal(routes.some(route => (
    route.method === 'get' && route.path === '/submissions/:ticketId'
  )), false);
  assert.equal(routes.some(route => (
    route.method === 'patch' && route.path === '/submissions/:ticketId/payment-id'
  )), true);
  assert.equal(routes.some(route => (
    route.method === 'patch' && route.path === '/submissions/:ticketId/decision'
  )), true);
});

test('uses indexed equality for a complete payment-ID search', () => {
  const filter = buildSubmissionFilter({ search: PAYMENT_ID });
  assert.equal(filter.whereClause, 'WHERE tp.payment_id = $1');
  assert.deepEqual(filter.params, [PAYMENT_ID]);
});

test('keeps the general wildcard search for non-payment-ID terms', () => {
  const filter = buildSubmissionFilter({ search: 'participant' });
  assert.match(filter.whereClause, /u\.email ILIKE \$1/);
  assert.doesNotMatch(filter.whereClause, /tp\.payment_id/);
  assert.deepEqual(filter.params, ['%participant%']);
});

test('manual entry locks queued payment and saves through a guarded update', async () => {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (/pg_advisory_xact_lock/.test(sql)) return { rows: [] };
      if (/FROM public\.ticket_payments[\s\S]*FOR UPDATE/.test(sql)) {
        return {
          rows: [{
            ticket_id: TICKET_ID,
            status: 'NotVerified',
            payment_id: 'queued',
            s3_url: 'https://example.com/receipt.pdf',
          }],
        };
      }
      return { rows: [{ ticket_id: TICKET_ID, payment_id: PAYMENT_ID }] };
    },
  };

  const result = await saveManualPaymentId(client, TICKET_ID, PAYMENT_ID);

  assert.equal(result.payment_id, PAYMENT_ID);
  assert.ok(queries.some(query => /FOR UPDATE/.test(query.sql)));
  assert.ok(queries.some(query => /payment_id = 'queued'/.test(query.sql)));
});

test('manual entry rejects an existing real payment ID', async () => {
  const client = {
    async query() {
      return {
        rows: [{
          ticket_id: TICKET_ID,
          status: 'Accepted',
          payment_id: PAYMENT_ID,
          s3_url: 'https://example.com/receipt.pdf',
        }],
      };
    },
  };

  await assert.rejects(
    saveManualPaymentId(client, TICKET_ID, 'pay_ZYXWVUTSRQPONM'),
    error => error.code === 'PAYMENT_ID_ALREADY_PRESENT' && error.httpStatus === 409,
  );
});

test('manual entry rejects legacy null payment IDs', async () => {
  const client = {
    async query() {
      return {
        rows: [{
          ticket_id: TICKET_ID,
          status: 'NotVerified',
          payment_id: null,
          s3_url: 'https://example.com/receipt.pdf',
        }],
      };
    },
  };

  await assert.rejects(
    saveManualPaymentId(client, TICKET_ID, PAYMENT_ID),
    error => error.code === 'PAYMENT_ID_NOT_QUEUED' && error.httpStatus === 409,
  );
});

test('accepted decisions require a valid real payment ID', () => {
  assert.throws(
    () => validatePaymentIdForDecision('Accepted', 'queued'),
    error => error.code === 'PAYMENT_ID_REQUIRED',
  );
  assert.doesNotThrow(() => validatePaymentIdForDecision('Accepted', PAYMENT_ID));
  assert.doesNotThrow(() => validatePaymentIdForDecision('Rejected', 'queued'));
});

test('conflict payment IDs are exact and conflict metadata distinguishes unresolved groups', () => {
  assert.doesNotThrow(() => validateConflictPaymentId(PAYMENT_ID));
  assert.throws(() => validateConflictPaymentId('PAY_1234567890ABCD'), error => error.code === 'INVALID_PAYMENT_ID');
  assert.throws(() => validateConflictPaymentId('pay_123456789ABCD'), error => error.code === 'INVALID_PAYMENT_ID');

  const metadata = buildConflictMetadata([
    { ticket_id: TICKET_ID, payment_id: PAYMENT_ID, status: 'NotVerified', s3_url: 'receipt.pdf' },
    { ticket_id: '01a08f68-88ac-7abc-8def-533944cbcac8', payment_id: PAYMENT_ID, status: 'Rejected', s3_url: 'receipt.pdf' },
  ], PAYMENT_ID);
  assert.equal(metadata.state, 'unresolved');
  assert.equal(metadata.not_verified_count, 1);
  assert.equal(metadata.blocked, false);

  const priorAccepted = buildConflictMetadata([
    { ticket_id: TICKET_ID, payment_id: PAYMENT_ID, status: 'Accepted', s3_url: 'winner.pdf' },
    { ticket_id: '01a08f68-88ac-7abc-8def-533944cbcac8', payment_id: PAYMENT_ID, status: 'NotVerified', s3_url: 'other.pdf' },
  ], PAYMENT_ID);
  assert.equal(priorAccepted.state, 'unresolved');
  assert.equal(priorAccepted.winner_ticket_id, TICKET_ID);

  const allRejected = buildConflictMetadata([
    { ticket_id: TICKET_ID, payment_id: PAYMENT_ID, status: 'Rejected', s3_url: 'one.pdf' },
    { ticket_id: '01a08f68-88ac-7abc-8def-533944cbcac8', payment_id: PAYMENT_ID, status: 'Rejected', s3_url: 'two.pdf' },
  ], PAYMENT_ID);
  assert.equal(allRejected.state, 'unresolved');
  assert.equal(allRejected.blocked_reason, 'NO_ACCEPTED_WINNER');

  const multipleAccepted = buildConflictMetadata([
    { ticket_id: TICKET_ID, payment_id: PAYMENT_ID, status: 'Accepted', s3_url: 'one.pdf' },
    { ticket_id: '01a08f68-88ac-7abc-8def-533944cbcac8', payment_id: PAYMENT_ID, status: 'Accepted', s3_url: 'two.pdf' },
  ], PAYMENT_ID);
  assert.equal(multipleAccepted.state, 'unresolved');
  assert.equal(multipleAccepted.blocked_reason, 'MULTIPLE_ACCEPTED_CANDIDATES');

  const completedButMissingReceipt = buildConflictMetadata([
    { ticket_id: TICKET_ID, payment_id: PAYMENT_ID, status: 'Accepted', s3_url: null },
    { ticket_id: '01a08f68-88ac-7abc-8def-533944cbcac8', payment_id: PAYMENT_ID, status: 'Rejected', s3_url: 'two.pdf' },
  ], PAYMENT_ID);
  assert.equal(completedButMissingReceipt.state, 'resolved');
  assert.equal(completedButMissingReceipt.blocked_reason, 'RECEIPT_URL_MISSING');
});

test('conflict search filters complete groups and includes team names', () => {
  const params = [];
  const search = buildConflictSearch({ search: 'robotics' }, params);
  assert.match(search, /candidate_rows/);
  assert.match(search, /hackathon_regs/);
  assert.deepEqual(params, ['%robotics%']);
});

test('conflict resolution accepts the selected candidate, rejects other NotVerified rows, and audits both changes', async () => {
  const winner = TICKET_ID;
  const loser = '01a08f68-88ac-7abc-8def-533944cbcac8';
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (/pg_advisory_xact_lock/.test(sql)) return { rows: [] };
      if (/FROM public\.verification/.test(sql)) return { rows: [{ volunteer_id: 'volunteer-1' }] };
      if (/FROM public\.ticket_payments/.test(sql)) {
        return {
          rows: [
            { ticket_id: winner, payment_id: PAYMENT_ID, status: 'NotVerified', s3_url: 'winner.pdf' },
            { ticket_id: loser, payment_id: PAYMENT_ID, status: 'NotVerified', s3_url: 'loser.pdf' },
          ],
        };
      }
      if (/UPDATE public\.ticket_payments/.test(sql)) {
        return { rows: [{ ticket_id: params[1], status: params[0], updated_at: 'now' }] };
      }
      if (/INSERT INTO public\.payment_verification_log/.test(sql)) {
        return { rows: [{ ticket_id: params[1], action_taken: params[3] }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };

  const result = await resolvePaymentConflict(client, PAYMENT_ID, winner, 'volunteer-1');
  assert.equal(result.winner_ticket_id, winner);
  assert.equal(result.changed, 2);
  const updateQueries = queries.filter(query => /UPDATE public\.ticket_payments/.test(query.sql));
  assert.deepEqual(updateQueries.map(query => query.params.slice(0, 2)), [
    ['Accepted', winner],
    ['Rejected', loser],
  ]);
  assert.deepEqual(result.logs.map(log => log.action_taken), ['Accepted', 'Rejected']);
});

test('conflict resolution keeps a prior Accepted winner and only rejects undecided rivals', async () => {
  const acceptedWinner = TICKET_ID;
  const undecidedRival = '01a08f68-88ac-7abc-8def-533944cbcac8';
  const rejectedRival = '01a08f68-88ac-7abc-8def-533944cbcac9';
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (/pg_advisory_xact_lock/.test(sql)) return { rows: [] };
      if (/FROM public\.verification/.test(sql)) return { rows: [{ volunteer_id: 'volunteer-1' }] };
      if (/FROM public\.ticket_payments/.test(sql)) {
        return {
          rows: [
            { ticket_id: acceptedWinner, payment_id: PAYMENT_ID, status: 'Accepted', s3_url: 'winner.pdf' },
            { ticket_id: undecidedRival, payment_id: PAYMENT_ID, status: 'NotVerified', s3_url: 'undecided.pdf' },
            { ticket_id: rejectedRival, payment_id: PAYMENT_ID, status: 'Rejected', s3_url: 'rejected.pdf' },
          ],
        };
      }
      if (/UPDATE public\.ticket_payments/.test(sql)) {
        return { rows: [{ ticket_id: params[1], status: params[0], updated_at: 'now' }] };
      }
      if (/INSERT INTO public\.payment_verification_log/.test(sql)) {
        return { rows: [{ ticket_id: params[1], action_taken: params[3] }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };

  const result = await resolvePaymentConflict(client, PAYMENT_ID, acceptedWinner, 'volunteer-1');

  assert.equal(result.changed, 1);
  assert.deepEqual(result.payments, [{ ticket_id: undecidedRival, status: 'Rejected', updated_at: 'now' }]);
  assert.deepEqual(result.logs.map(log => log.action_taken), ['Rejected']);
  assert.equal(queries.filter(query => /UPDATE public\.ticket_payments/.test(query.sql)).length, 1);
});

test('conflict resolution handles groups larger than two in one decision', async () => {
  const winner = TICKET_ID;
  const rivals = [
    '01a08f68-88ac-7abc-8def-533944cbcac8',
    '01a08f68-88ac-7abc-8def-533944cbcac9',
  ];
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (/pg_advisory_xact_lock/.test(sql)) return { rows: [] };
      if (/FROM public\.verification/.test(sql)) return { rows: [{ volunteer_id: 'volunteer-1' }] };
      if (/FROM public\.ticket_payments/.test(sql)) {
        return {
          rows: [winner, ...rivals].map(ticketId => ({
            ticket_id: ticketId,
            payment_id: PAYMENT_ID,
            status: 'NotVerified',
            s3_url: `${ticketId}.pdf`,
          })),
        };
      }
      if (/UPDATE public\.ticket_payments/.test(sql)) {
        return { rows: [{ ticket_id: params[1], status: params[0], updated_at: 'now' }] };
      }
      if (/INSERT INTO public\.payment_verification_log/.test(sql)) {
        return { rows: [{ ticket_id: params[1], action_taken: params[3] }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };

  const result = await resolvePaymentConflict(client, PAYMENT_ID, winner, 'volunteer-1');

  assert.equal(result.changed, 3);
  assert.deepEqual(result.payments.map(payment => payment.status), ['Accepted', 'Rejected', 'Rejected']);
  assert.deepEqual(result.logs.map(log => log.action_taken), ['Accepted', 'Rejected', 'Rejected']);
});

test('conflict resolution blocks missing receipt URLs before any update', async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (/pg_advisory_xact_lock/.test(sql)) return { rows: [] };
      if (/FROM public\.verification/.test(sql)) return { rows: [{ volunteer_id: 'volunteer-1' }] };
      if (/FROM public\.ticket_payments/.test(sql)) {
        return {
          rows: [
            { ticket_id: TICKET_ID, payment_id: PAYMENT_ID, status: 'NotVerified', s3_url: null },
            { ticket_id: '01a08f68-88ac-7abc-8def-533944cbcac8', payment_id: PAYMENT_ID, status: 'NotVerified', s3_url: 'receipt.pdf' },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };

  await assert.rejects(
    resolvePaymentConflict(client, PAYMENT_ID, TICKET_ID, 'volunteer-1'),
    error => error.code === 'CONFLICT_INVALID_STATE' && error.httpStatus === 409,
  );
  assert.equal(queries.filter(sql => /UPDATE public\.ticket_payments/.test(sql)).length, 0);
});

test('batch review enrichment assembles events, members, logs, and conflict metadata with set queries', async () => {
  const queries = [];
  const payments = [
    {
      ticket_id: TICKET_ID,
      user_id: '01a08f68-88ac-7abc-8def-533944cbcac1',
      ticket_type: 'HACKATHON',
      amount_paid: 100,
      s3_url: 'winner.pdf',
      payment_id: PAYMENT_ID,
      status: 'NotVerified',
      participant_name: 'Winner',
    },
    {
      ticket_id: SECOND_TICKET_ID,
      user_id: '01a08f68-88ac-7abc-8def-533944cbcac2',
      ticket_type: 'TECHPASS',
      amount_paid: 50,
      s3_url: 'other.pdf',
      payment_id: PAYMENT_ID,
      status: 'Rejected',
      participant_name: 'Other',
    },
  ];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (/ticket_event/.test(sql)) {
        return {
          rows: [
            {
              ticket_id: TICKET_ID,
              event_id: 'event-1',
              name: 'Opening Ceremony',
              date: '2026-09-14',
            },
            {
              ticket_id: SECOND_TICKET_ID,
              event_id: 'event-2',
              name: 'Closing Ceremony',
              date: '2026-09-15',
            },
          ],
        };
      }
      if (/hackathon_regs/.test(sql)) {
        return {
          rows: [{
            ticket_id: TICKET_ID,
            member_id: 'member-1',
            team_id: 'team-1',
            team_name: 'Robotics',
            domain: 'AI',
            track: 'Hardware',
            ps_description: 'Build a robot',
            is_lead: true,
            name: 'Lead Member',
          }],
        };
      }
      if (/payment_verification_log/.test(sql)) {
        return {
          rows: [{
            ticket_id: SECOND_TICKET_ID,
            log_id: 'log-1',
            action_taken: 'Rejected',
          }],
        };
      }
      if (/payment_id = ANY\(\$1::text\[\]\)/.test(sql)) {
        return {
          rows: [
            { ticket_id: TICKET_ID, payment_id: PAYMENT_ID, status: 'NotVerified', s3_url: 'winner.pdf' },
            { ticket_id: SECOND_TICKET_ID, payment_id: PAYMENT_ID, status: 'Rejected', s3_url: 'other.pdf' },
          ],
        };
      }
      if (/tp\.ticket_id = ANY\(\$1::uuid\[\]\)/.test(sql)) return { rows: payments };
      throw new Error(`unexpected batch query: ${sql}`);
    },
  };

  const summaries = await loadReviewSummaries(client, [TICKET_ID, SECOND_TICKET_ID, TICKET_ID]);

  assert.equal(queries.length, 5, 'one payment, events, hackathon, logs, and conflict query for the whole page');
  assert.ok(queries.every(query => Array.isArray(query.params?.[0])));
  assert.deepEqual(summaries.get(TICKET_ID).events, [{
    event_id: 'event-1',
    name: 'Opening Ceremony',
    date: '2026-09-14',
  }]);
  assert.deepEqual(summaries.get(SECOND_TICKET_ID).events, [{
    event_id: 'event-2',
    name: 'Closing Ceremony',
    date: '2026-09-15',
  }]);
  assert.deepEqual(summaries.get(TICKET_ID).hackathon, {
    team_id: 'team-1',
    team_name: 'Robotics',
    domain: 'AI',
    track: 'Hardware',
    ps_description: 'Build a robot',
    members: [{
      member_id: 'member-1',
      team_id: 'team-1',
      is_lead: true,
      name: 'Lead Member',
      email: undefined,
      phno: undefined,
      year_of_study: undefined,
      created_at: undefined,
      updated_at: undefined,
    }],
  });
  assert.deepEqual(summaries.get(SECOND_TICKET_ID).verification_logs, [{
    ticket_id: SECOND_TICKET_ID,
    log_id: 'log-1',
    action_taken: 'Rejected',
  }]);
  assert.equal(summaries.get(TICKET_ID).conflict.state, 'unresolved');
  assert.equal(summaries.get(TICKET_ID).conflict.candidate_count, 2);
  assert.equal(summaries.get(SECOND_TICKET_ID).conflict.winner_ticket_id, null);
  assert.equal(summaries.get(TICKET_ID).s3_url, 'winner.pdf');
  assert.equal(Object.hasOwn(summaries.get(TICKET_ID), 'receipt_pdf_url'), false);
});

test('batch review enrichment can omit conflict lookup without changing assembled child collections', async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (/ticket_event/.test(sql) || /hackathon_regs/.test(sql) || /payment_verification_log/.test(sql)) {
        return { rows: [] };
      }
      if (/tp\.ticket_id = ANY\(\$1::uuid\[\]\)/.test(sql)) {
        return {
          rows: [{
            ticket_id: TICKET_ID,
            payment_id: SECOND_PAYMENT_ID,
            hackathon: null,
            events: [],
          }],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };

  const summaries = await loadReviewSummaries(client, [TICKET_ID], { includeConflicts: false });

  assert.equal(queries.length, 4);
  assert.equal(summaries.get(TICKET_ID).conflict, null);
  assert.deepEqual(summaries.get(TICKET_ID).events, []);
  assert.deepEqual(summaries.get(TICKET_ID).verification_logs, []);
});

test('batched conflict metadata groups candidates once and returns no payload for unique IDs', async () => {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      return {
        rows: [
          { ticket_id: TICKET_ID, payment_id: PAYMENT_ID, status: 'Accepted', s3_url: 'winner.pdf' },
          { ticket_id: SECOND_TICKET_ID, payment_id: PAYMENT_ID, status: 'Rejected', s3_url: 'other.pdf' },
          { ticket_id: '01a08f68-88ac-7abc-8def-533944cbcac9', payment_id: SECOND_PAYMENT_ID, status: 'Accepted', s3_url: 'solo.pdf' },
        ],
      };
    },
  };

  const metadata = await loadConflictMetadata(client, [PAYMENT_ID, PAYMENT_ID, SECOND_PAYMENT_ID]);

  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].params, [[PAYMENT_ID, SECOND_PAYMENT_ID]]);
  assert.equal(metadata.size, 1);
  assert.equal(metadata.get(PAYMENT_ID).state, 'resolved');
  assert.equal(metadata.get(PAYMENT_ID).candidate_count, 2);
  assert.equal(metadata.has(SECOND_PAYMENT_ID), false);
  assert.equal(Object.hasOwn(metadata.get(PAYMENT_ID), 'candidates'), false);
});
