const { extractPaymentId } = require('../utils/paymentId');
const {
  lockPaymentId: defaultLockPaymentId,
  withTransaction: defaultWithTransaction,
} = require('../utils/transaction');

const STREAM_KEY = 'invente:payments:node_ocr_stream';
const CONSUMER_GROUP = 'node-service-group';
const EXPECTED_ACTION = 'ocr';
const READ_COUNT = 10;
const BLOCK_MS = 2000;
const AUTOCLAIM_IDLE_MS = 30 * 60 * 1000;
const AUTOCLAIM_INTERVAL_MS = 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUIRED_FIELDS = ['ticket_id', 'pdfUrl', 'action_type'];

function fieldsToObject(fields) {
  if (!Array.isArray(fields) || fields.length % 2 !== 0) return null;

  const result = {};
  for (let index = 0; index < fields.length; index += 2) {
    result[String(fields[index])] = String(fields[index + 1]);
  }
  return result;
}

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function errorOutcome(error) {
  const name = String(error?.name || '');
  const code = String(error?.code || '');
  if (name === 'AbortError' || code === 'ABORT_ERR' || code === 'UND_ERR_ABORTED') {
    return 'azure_timeout';
  }
  return 'azure_error';
}

function logOutcome(logger, details) {
  logger(JSON.stringify({
    timestamp: new Date().toISOString(),
    event: 'payment_ocr',
    ...details,
  }));
}

function createPaymentOcrWorker({
  redis,
  database,
  documentIntelligence,
  consumerName,
  withTransaction = defaultWithTransaction,
  lockPaymentId = defaultLockPaymentId,
  logger = console.log,
}) {
  let running = false;
  let lastAutoClaimAt = 0;

  async function ensureConsumerGroup() {
    try {
      await redis.xgroup('CREATE', STREAM_KEY, CONSUMER_GROUP, '0-0', 'MKSTREAM');
    } catch (error) {
      if (!String(error?.message || '').includes('BUSYGROUP')) throw error;
    }
  }

  async function processEntry(messageId, rawFields) {
    const startedAt = Date.now();
    const fields = fieldsToObject(rawFields);
    const ticketId = fields?.ticket_id;
    const action = fields?.action_type;
    let outcome = 'unknown_error';

    try {
      if (!fields) {
        outcome = 'malformed_fields';
      } else if (REQUIRED_FIELDS.some(field => !Object.hasOwn(fields, field))) {
        outcome = 'missing_required_field';
      } else if (action !== EXPECTED_ACTION) {
        outcome = 'unsupported_action';
      } else if (!isUuid(ticketId)) {
        outcome = 'invalid_ticket_id';
      } else if (typeof fields.pdfUrl !== 'string' || fields.pdfUrl.length === 0) {
        outcome = 'missing_pdf_url';
      } else {
        let payment;
        try {
          const paymentResult = await database.query(
            `SELECT ticket_id, status, payment_id
             FROM public.ticket_payments
             WHERE ticket_id = $1`,
            [ticketId],
          );
          payment = paymentResult.rows[0];
        } catch (error) {
          outcome = 'database_read_error';
        }

        if (outcome === 'unknown_error') {
          if (!payment) {
            outcome = 'ticket_not_found';
          } else if (payment.status !== 'NotVerified') {
            outcome = 'ineligible_status';
          } else if (payment.payment_id !== 'queued') {
            outcome = payment.payment_id === null
              ? 'payment_id_not_queued'
              : 'payment_id_already_present';
          } else {
            let content;
            try {
              content = await documentIntelligence.analyzeFromUrl(fields.pdfUrl);
            } catch (error) {
              outcome = errorOutcome(error);
            }

            if (outcome === 'unknown_error') {
              const paymentId = extractPaymentId(content);
              if (!content) {
                outcome = 'no_text_detected';
              } else if (!paymentId) {
                outcome = 'payment_id_not_found';
              } else {
                try {
                  // Azure runs outside the transaction. Only the final
                  // queued -> real-ID transition is transactional, and the
                  // advisory lock must precede the row lock to coordinate
                  // with manual saves using the same payment ID.
                  const runTransaction = work => withTransaction === defaultWithTransaction
                    ? withTransaction(work, database)
                    : withTransaction(work);
                  outcome = await runTransaction(async client => {
                    await lockPaymentId(client, paymentId);

                    const currentResult = await client.query(
                      `SELECT ticket_id, status, payment_id
                       FROM public.ticket_payments
                       WHERE ticket_id = $1
                       FOR UPDATE`,
                      [ticketId],
                    );
                    const current = currentResult.rows[0];
                    if (
                      !current
                      || current.status !== 'NotVerified'
                      || current.payment_id !== 'queued'
                    ) {
                      return 'payment_id_write_lost_race';
                    }

                    const updateResult = await client.query(
                      `UPDATE public.ticket_payments
                       SET payment_id = $1
                       WHERE ticket_id = $2
                         AND status = 'NotVerified'
                         AND payment_id = 'queued'
                       RETURNING ticket_id`,
                      [paymentId, ticketId],
                    );
                    return updateResult.rows.length > 0
                      ? 'payment_id_saved'
                      : 'payment_id_write_lost_race';
                  });
                } catch (error) {
                  outcome = 'database_write_error';
                }
              }
            }
          }
        }
      }
    } catch (error) {
      outcome = 'unexpected_processing_error';
    }

    logOutcome(logger, {
      message_id: messageId,
      ticket_id: isUuid(ticketId) ? ticketId : null,
      action: action || null,
      outcome,
      elapsed_ms: Date.now() - startedAt,
    });

    const acknowledged = await redis.xack(STREAM_KEY, CONSUMER_GROUP, messageId);
    if (acknowledged !== 1) {
      const error = new Error(`Redis did not acknowledge stream entry ${messageId}`);
      error.code = 'OCR_STREAM_ACK_FAILED';
      throw error;
    }

    return outcome;
  }

  async function processMessages(messages) {
    for (const [messageId, fields] of messages || []) {
      await processEntry(messageId, fields);
      if (!running) break;
    }
  }

  async function autoClaimStaleEntries() {
    let cursor = '0-0';
    do {
      const response = await redis.xautoclaim(
        STREAM_KEY,
        CONSUMER_GROUP,
        consumerName,
        AUTOCLAIM_IDLE_MS,
        cursor,
        'COUNT',
        READ_COUNT,
      );
      cursor = response?.[0] || '0-0';
      const messages = Array.isArray(response?.[1]) ? response[1] : [];
      await processMessages(messages);
    } while (running && cursor !== '0-0');

    lastAutoClaimAt = Date.now();
  }

  async function readNewEntries() {
    const results = await redis.xreadgroup(
      'GROUP',
      CONSUMER_GROUP,
      consumerName,
      'COUNT',
      READ_COUNT,
      'BLOCK',
      BLOCK_MS,
      'STREAMS',
      STREAM_KEY,
      '>',
    );

    if (!results) return;
    for (const [, messages] of results) {
      await processMessages(messages);
      if (!running) break;
    }
  }

  async function start() {
    running = true;
    await ensureConsumerGroup();
    await autoClaimStaleEntries();

    while (running) {
      if (Date.now() - lastAutoClaimAt >= AUTOCLAIM_INTERVAL_MS) {
        await autoClaimStaleEntries();
      }
      if (running) await readNewEntries();
    }
  }

  function stop() {
    running = false;
  }

  return {
    start,
    stop,
    processEntry,
    ensureConsumerGroup,
    autoClaimStaleEntries,
    readNewEntries,
  };
}

module.exports = {
  STREAM_KEY,
  CONSUMER_GROUP,
  EXPECTED_ACTION,
  READ_COUNT,
  BLOCK_MS,
  AUTOCLAIM_IDLE_MS,
  fieldsToObject,
  createPaymentOcrWorker,
};
