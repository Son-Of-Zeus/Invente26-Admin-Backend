const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSubmissionFilter,
  saveManualPaymentId,
  validatePaymentIdForDecision,
} = require('../src/routes/receipt-review')._test;

const TICKET_ID = '01a08f68-88ac-7abc-8def-533944cbcac7';
const PAYMENT_ID = 'pay_1234567890ABCD';

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
      if (queries.length === 1) {
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
  assert.match(queries[0].sql, /FOR UPDATE/);
  assert.match(queries[1].sql, /payment_id = 'queued'/);
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
