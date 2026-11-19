const express = require('express');

const db = require('../db');
const {
  PDF_MIME_TYPE,
  MAX_RECEIPT_BYTES,
  createUploadTicket,
  validateUploadedReceipt,
  isAllowedUploadOrigin,
} = require('../utils/azureBlobStorage');

const router = express.Router();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECEIPT_UPLOADABLE_STATUSES = ['PendingPayment', 'NotVerified'];

function isAzureConfigured() {
  return Boolean(process.env.AZURE_UPLOAD_TOKEN_SECRET && process.env.AZURE_STORAGE_CONTAINER_NAME);
}

function requireFrontendOrigin(req, res, next) {
  const configuredOrigins = String(process.env.UPLOAD_ALLOWED_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);

  if (configuredOrigins.length === 0 || !isAzureConfigured()) {
    return res.status(503).json({ error: 'receipt upload is not configured' });
  }

  if (!isAllowedUploadOrigin(req.get('origin'))) {
    return res.status(403).json({ error: 'request origin is not allowed' });
  }

  next();
}

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function sendStorageError(res, error) {
  if (error?.code === 'AZURE_CONFIG_MISSING' || error?.code === 'AZURE_CONFIG_INVALID') {
    return res.status(503).json({ error: error.message });
  }

  if (error?.code === 'INVALID_UPLOAD_TOKEN' || error?.code === 'UPLOAD_OBJECT_MISMATCH') {
    return res.status(400).json({ error: error.message });
  }

  if (error?.code === 'INVALID_RECEIPT_CONTENT_TYPE') {
    return res.status(415).json({ error: error.message });
  }

  if (error?.code === 'INVALID_RECEIPT_FORMAT') {
    return res.status(415).json({ error: error.message });
  }

  if (error?.code === 'RECEIPT_INSPECTION_FAILED') {
    return res.status(502).json({ error: error.message });
  }

  if (error?.code === 'INVALID_RECEIPT_SIZE') {
    return res.status(413).json({ error: error.message });
  }

  if (error?.name === 'TokenExpiredError' || error?.name === 'JsonWebTokenError' || error?.name === 'NotBeforeError') {
    return res.status(400).json({ error: 'invalid or expired receipt upload token' });
  }

  if (error?.statusCode === 404 || error?.details?.errorCode === 'BlobNotFound') {
    return res.status(404).json({ error: 'uploaded receipt was not found' });
  }

  console.error('Receipt storage error:', error);
  return res.status(502).json({ error: 'receipt storage request failed' });
}

/**
 * Issue a single-blob Azure SAS URL for a participant receipt.
 *
 * This endpoint intentionally does not write s3_url. The participant
 * frontend uploads to Azure and then patches the participant repository,
 * which owns the payment status transition to NotVerified.
 */
router.post('/receipt-upload-url', requireFrontendOrigin, async (req, res) => {
  const { ticket_id, content_type, file_size } = req.body || {};

  if (!isUuid(ticket_id)) {
    return res.status(400).json({ error: 'ticket_id must be a valid UUID' });
  }

  if (content_type !== PDF_MIME_TYPE) {
    return res.status(415).json({ error: 'only application/pdf receipts are accepted' });
  }

  if (!Number.isInteger(file_size) || file_size <= 0 || file_size > MAX_RECEIPT_BYTES) {
    return res.status(413).json({ error: 'file_size must be between 1 byte and 5 MB' });
  }

  try {
    const payment = await db.query(
      'SELECT ticket_id, status FROM public.ticket_payments WHERE ticket_id = $1',
      [ticket_id],
    );

    if (payment.rows.length === 0) {
      return res.status(404).json({ error: 'ticket payment not found' });
    }

    if (!RECEIPT_UPLOADABLE_STATUSES.includes(payment.rows[0].status)) {
      return res.status(409).json({
        error: 'a receipt upload can only be started for a PendingPayment or NotVerified ticket',
        current_status: payment.rows[0].status,
      });
    }

    const upload = createUploadTicket(ticket_id);
    return res.status(201).json({
      ticket_id: upload.ticketId,
      upload_id: upload.uploadId,
      object_key: upload.objectKey,
      upload_url: upload.uploadUrl,
      public_url: upload.publicUrl,
      upload_token: upload.uploadToken,
      expires_at: upload.expiresAt,
      content_type: PDF_MIME_TYPE,
      max_size_bytes: MAX_RECEIPT_BYTES,
    });
  } catch (error) {
    return sendStorageError(res, error);
  }
});

/**
 * Perform the server-side Azure HEAD check after the browser upload.
 * The frontend must complete this check before calling the participant
 * repository's PATCH endpoint with public_url.
 */
router.post('/receipt-upload/validate', requireFrontendOrigin, async (req, res) => {
  const { upload_token, object_key } = req.body || {};

  if (typeof upload_token !== 'string' || !upload_token.trim()) {
    return res.status(400).json({ error: 'upload_token is required' });
  }

  try {
    const uploaded = await validateUploadedReceipt(upload_token, object_key);
    const payment = await db.query(
      'SELECT ticket_id FROM public.ticket_payments WHERE ticket_id = $1',
      [uploaded.ticketId],
    );

    if (payment.rows.length === 0) {
      return res.status(404).json({ error: 'ticket payment not found' });
    }

    return res.json({
      valid: uploaded.valid,
      ticket_id: uploaded.ticketId,
      object_key: uploaded.objectKey,
      public_url: uploaded.publicUrl,
      content_type: uploaded.contentType,
      file_size: uploaded.contentLength,
    });
  } catch (error) {
    return sendStorageError(res, error);
  }
});

module.exports = router;
