const db = require('../db');

// Keep this query identical anywhere a payment ID is being assigned. The
// transaction-scoped lock is keyed by the exact value being assigned so OCR
// and manual writes serialize before either one locks the ticket row.
const PAYMENT_ID_ADVISORY_LOCK_SQL =
  'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';

async function lockPaymentId(client, paymentId) {
  await client.query(PAYMENT_ID_ADVISORY_LOCK_SQL, [paymentId]);
}

/**
 * Run relational work on one PostgreSQL connection and keep the transaction
 * boundary in one place. Network calls must happen before or after this
 * helper, never from inside the callback.
 */
async function withTransaction(work, database = db) {
  const client = await database.getClient();

  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Transaction rollback failed:', rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  PAYMENT_ID_ADVISORY_LOCK_SQL,
  lockPaymentId,
  withTransaction,
};
