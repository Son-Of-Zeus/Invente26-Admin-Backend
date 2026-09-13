const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STREAM_KEY,
  CONSUMER_GROUP,
  AUTOCLAIM_IDLE_MS,
  fieldsToObject,
  createPaymentOcrWorker,
} = require('../src/workers/paymentOcrWorker');

const TICKET_ID = '01a08f68-88ac-7abc-8def-533944cbcac7';

function streamFields(overrides = {}) {
  const fields = {
    pdfUrl: 'https://s3.amazonaws.com/invente-receipts/payment.pdf',
    action_type: 'ocr',
    ticket_id: TICKET_ID,
    ...overrides,
  };
  return Object.entries(fields).flat();
}

function createHarness({
  payment,
  content = 'Payment pay_1234567890ABCD',
  ack = 1,
  azureError,
  updateRows = [{ ticket_id: TICKET_ID }],
} = {}) {
  const order = [];
  const logs = [];
  const queries = [];
  let azureCalls = 0;

  const redis = {
    async xack(...args) {
      order.push('ack');
      assert.deepEqual(args, [STREAM_KEY, CONSUMER_GROUP, '1-0']);
      return ack;
    },
  };
  const database = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('SELECT ticket_id')) return { rows: payment ? [payment] : [] };
      order.push('database_update');
      return { rows: updateRows };
    },
  };
  const documentIntelligence = {
    async analyzeFromUrl() {
      azureCalls += 1;
      order.push('azure');
      if (azureError) throw azureError;
      return content;
    },
  };
  const worker = createPaymentOcrWorker({
    redis,
    database,
    documentIntelligence,
    consumerName: 'test-consumer',
    logger: line => logs.push(JSON.parse(line)),
  });

  return {
    worker,
    order,
    logs,
    queries,
    getAzureCalls: () => azureCalls,
  };
}

test('converts the ioredis field array into an object', () => {
  assert.deepEqual(fieldsToObject(['ticket_id', TICKET_ID, 'action_type', 'ocr']), {
    ticket_id: TICKET_ID,
    action_type: 'ocr',
  });
  assert.equal(fieldsToObject(['ticket_id']), null);
});

test('saves the first payment ID before acknowledging the entry', async () => {
  const harness = createHarness({
    payment: { ticket_id: TICKET_ID, status: 'NotVerified', payment_id: 'queued' },
  });

  const outcome = await harness.worker.processEntry('1-0', streamFields());

  assert.equal(outcome, 'payment_id_saved');
  assert.deepEqual(harness.order, ['azure', 'database_update', 'ack']);
  assert.equal(harness.queries[1].params[0], 'pay_1234567890ABCD');
  assert.match(harness.queries[1].sql, /payment_id = 'queued'/);
  assert.equal(harness.logs[0].outcome, 'payment_id_saved');
});

test('does not invoke Azure when the payment ID is already present', async () => {
  const harness = createHarness({
    payment: { ticket_id: TICKET_ID, status: 'NotVerified', payment_id: 'pay_1234567890ABCD' },
  });

  const outcome = await harness.worker.processEntry('1-0', streamFields());

  assert.equal(outcome, 'payment_id_already_present');
  assert.equal(harness.getAzureCalls(), 0);
  assert.deepEqual(harness.order, ['ack']);
});

test('acknowledges Azure failures and leaves the queued value unchanged', async () => {
  const harness = createHarness({
    payment: { ticket_id: TICKET_ID, status: 'NotVerified', payment_id: 'queued' },
    azureError: Object.assign(new Error('timed out'), { name: 'AbortError' }),
  });

  const outcome = await harness.worker.processEntry('1-0', streamFields());

  assert.equal(outcome, 'azure_timeout');
  assert.equal(harness.queries.length, 1);
  assert.deepEqual(harness.order, ['azure', 'ack']);
});

test('acknowledges malformed, incomplete, and unsupported entries without external work', async () => {
  const malformed = createHarness();
  const incomplete = createHarness();
  const unsupported = createHarness();

  assert.equal(await malformed.worker.processEntry('1-0', ['ticket_id']), 'malformed_fields');
  assert.equal(
    await incomplete.worker.processEntry('1-0', ['ticket_id', TICKET_ID, 'action_type', 'ocr']),
    'missing_required_field',
  );
  assert.equal(
    await unsupported.worker.processEntry('1-0', streamFields({ action_type: 'email' })),
    'unsupported_action',
  );
  assert.equal(malformed.queries.length, 0);
  assert.equal(incomplete.queries.length, 0);
  assert.equal(unsupported.queries.length, 0);
  assert.equal(malformed.getAzureCalls(), 0);
  assert.equal(incomplete.getAzureCalls(), 0);
  assert.equal(unsupported.getAzureCalls(), 0);
  assert.deepEqual(malformed.order, ['ack']);
  assert.deepEqual(incomplete.order, ['ack']);
  assert.deepEqual(unsupported.order, ['ack']);
});

test('skips legacy null payment IDs without invoking Azure', async () => {
  const harness = createHarness({
    payment: { ticket_id: TICKET_ID, status: 'NotVerified', payment_id: null },
  });

  assert.equal(await harness.worker.processEntry('1-0', streamFields()), 'payment_id_not_queued');
  assert.equal(harness.getAzureCalls(), 0);
  assert.deepEqual(harness.order, ['ack']);
});

test('acknowledges a strict no-match result without updating the database', async () => {
  const harness = createHarness({
    payment: { ticket_id: TICKET_ID, status: 'NotVerified', payment_id: 'queued' },
    content: 'Payment reference pay_1234567 890ABCD',
  });

  assert.equal(await harness.worker.processEntry('1-0', streamFields()), 'payment_id_not_found');
  assert.equal(harness.queries.length, 1);
  assert.deepEqual(harness.order, ['azure', 'ack']);
});

test('acknowledges when a concurrent writer wins the guarded update', async () => {
  const harness = createHarness({
    payment: { ticket_id: TICKET_ID, status: 'NotVerified', payment_id: 'queued' },
    updateRows: [],
  });

  assert.equal(
    await harness.worker.processEntry('1-0', streamFields()),
    'payment_id_write_lost_race',
  );
  assert.deepEqual(harness.order, ['azure', 'database_update', 'ack']);
});

test('rejects when Redis does not acknowledge the processed entry', async () => {
  const harness = createHarness({
    payment: { ticket_id: TICKET_ID, status: 'NotVerified', payment_id: 'queued' },
    ack: 0,
  });

  await assert.rejects(
    harness.worker.processEntry('1-0', streamFields()),
    error => error.code === 'OCR_STREAM_ACK_FAILED',
  );
});

test('uses the configured 30-minute auto-claim threshold', () => {
  assert.equal(AUTOCLAIM_IDLE_MS, 30 * 60 * 1000);
});

test('auto-claim requests only entries idle for the configured threshold', async () => {
  const calls = [];
  const redis = {
    async xautoclaim(...args) {
      calls.push(args);
      return ['0-0', []];
    },
  };
  const worker = createPaymentOcrWorker({
    redis,
    database: { query: async () => ({ rows: [] }) },
    documentIntelligence: { analyzeFromUrl: async () => '' },
    consumerName: 'unique-test-consumer',
    logger: () => {},
  });

  await worker.autoClaimStaleEntries();

  assert.deepEqual(calls, [[
    STREAM_KEY,
    CONSUMER_GROUP,
    'unique-test-consumer',
    30 * 60 * 1000,
    '0-0',
    'COUNT',
    10,
  ]]);
});
