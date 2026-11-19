const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const {
  BlobServiceClient,
  StorageSharedKeyCredential,
  BlobSASPermissions,
  SASProtocol,
  generateBlobSASQueryParameters,
} = require('@azure/storage-blob');

const PDF_MIME_TYPE = 'application/pdf';
const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;
const DEFAULT_SAS_EXPIRY_SECONDS = 15 * 60;
const DEFAULT_RECEIPT_PREFIX = 'receipts';

function getConnectionParts() {
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connectionString) {
    return {
      accountName: process.env.AZURE_STORAGE_ACCOUNT_NAME,
      accountKey: process.env.AZURE_STORAGE_ACCOUNT_KEY,
      blobEndpoint: process.env.AZURE_STORAGE_BLOB_ENDPOINT,
    };
  }

  const values = {};
  connectionString.split(';').forEach(part => {
    const separator = part.indexOf('=');
    if (separator > 0) {
      values[part.slice(0, separator)] = part.slice(separator + 1);
    }
  });

  return {
    accountName: values.AccountName || process.env.AZURE_STORAGE_ACCOUNT_NAME,
    accountKey: values.AccountKey || process.env.AZURE_STORAGE_ACCOUNT_KEY,
    blobEndpoint: values.BlobEndpoint || process.env.AZURE_STORAGE_BLOB_ENDPOINT,
  };
}

function getConfig() {
  const connection = getConnectionParts();
  const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME;
  const uploadTokenSecret = process.env.AZURE_UPLOAD_TOKEN_SECRET;
  const accountName = connection.accountName;
  const accountKey = connection.accountKey;
  const blobEndpoint = connection.blobEndpoint || (accountName ? `https://${accountName}.blob.core.windows.net` : null);
  const expirySeconds = Number(process.env.AZURE_SAS_EXPIRY_SECONDS || DEFAULT_SAS_EXPIRY_SECONDS);
  const prefix = (process.env.AZURE_RECEIPT_PREFIX || DEFAULT_RECEIPT_PREFIX).replace(/^\/+|\/+$/g, '');

  if (!accountName || !accountKey || !containerName || !uploadTokenSecret || !blobEndpoint) {
    const error = new Error('Azure Blob Storage configuration is incomplete');
    error.code = 'AZURE_CONFIG_MISSING';
    throw error;
  }

  if (!Number.isInteger(expirySeconds) || expirySeconds < 60 || expirySeconds > 7 * 24 * 60 * 60) {
    const error = new Error('AZURE_SAS_EXPIRY_SECONDS must be between 60 and 604800');
    error.code = 'AZURE_CONFIG_INVALID';
    throw error;
  }

  return {
    accountName,
    accountKey,
    containerName,
    uploadTokenSecret,
    blobEndpoint: blobEndpoint.replace(/\/+$/, ''),
    publicBaseUrl: (process.env.AZURE_PUBLIC_BASE_URL || `${blobEndpoint}/${containerName}`).replace(/\/+$/, ''),
    expirySeconds,
    prefix,
  };
}

function getStorageContext() {
  const config = getConfig();
  const credential = new StorageSharedKeyCredential(config.accountName, config.accountKey);
  const serviceClient = new BlobServiceClient(config.blobEndpoint, credential);
  const containerClient = serviceClient.getContainerClient(config.containerName);
  return { config, credential, containerClient };
}

function encodeObjectKey(objectKey) {
  return objectKey.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

function publicUrlFor(config, objectKey) {
  return `${config.publicBaseUrl}/${encodeObjectKey(objectKey)}`;
}

function makeUploadToken(config, details) {
  return jwt.sign(
    {
      token_type: 'receipt_upload',
      ticket_id: details.ticketId,
      object_key: details.objectKey,
      public_url: details.publicUrl,
    },
    config.uploadTokenSecret,
    {
      algorithm: 'HS256',
      expiresIn: config.expirySeconds,
      jwtid: details.uploadId,
    },
  );
}

function verifyUploadToken(uploadToken) {
  const config = getConfig();
  const payload = jwt.verify(uploadToken, config.uploadTokenSecret, { algorithms: ['HS256'] });
  if (payload.token_type !== 'receipt_upload' || typeof payload.ticket_id !== 'string' || typeof payload.object_key !== 'string' || typeof payload.public_url !== 'string') {
    const error = new Error('invalid receipt upload token');
    error.code = 'INVALID_UPLOAD_TOKEN';
    throw error;
  }
  return { config, payload };
}

function createUploadTicket(ticketId) {
  const { config, credential, containerClient } = getStorageContext();
  const uploadId = crypto.randomUUID();
  const objectKey = `${config.prefix}/${uploadId}.pdf`;
  const blockBlobClient = containerClient.getBlockBlobClient(objectKey);
  const startsOn = new Date(Date.now() - 30 * 1000);
  const expiresOn = new Date(Date.now() + config.expirySeconds * 1000);

  const sas = generateBlobSASQueryParameters(
    {
      containerName: config.containerName,
      blobName: objectKey,
      permissions: BlobSASPermissions.parse('cw'),
      startsOn,
      expiresOn,
      protocol: SASProtocol.Https,
    },
    credential,
  ).toString();

  const publicUrl = publicUrlFor(config, objectKey);
  const uploadToken = makeUploadToken(config, { ticketId, objectKey, publicUrl, uploadId });

  return {
    uploadId,
    ticketId,
    objectKey,
    uploadUrl: `${blockBlobClient.url}?${sas}`,
    publicUrl,
    uploadToken,
    expiresAt: expiresOn.toISOString(),
  };
}

async function validateUploadedReceipt(uploadToken, objectKey) {
  const { config, payload } = verifyUploadToken(uploadToken);
  if (objectKey && objectKey !== payload.object_key) {
    const error = new Error('object key does not match upload token');
    error.code = 'UPLOAD_OBJECT_MISMATCH';
    throw error;
  }

  const { containerClient } = getStorageContext();
  const blockBlobClient = containerClient.getBlockBlobClient(payload.object_key);
  const properties = await blockBlobClient.getProperties();
  const contentLength = Number(properties.contentLength || 0);
  const contentType = String(properties.contentType || '').toLowerCase();

  if (contentType !== PDF_MIME_TYPE) {
    const error = new Error('uploaded object must have Content-Type application/pdf');
    error.code = 'INVALID_RECEIPT_CONTENT_TYPE';
    throw error;
  }
  if (!Number.isInteger(contentLength) || contentLength <= 0 || contentLength > MAX_RECEIPT_BYTES) {
    const error = new Error('uploaded PDF must be between 1 byte and 5 MB');
    error.code = 'INVALID_RECEIPT_SIZE';
    throw error;
  }

  // Metadata alone can be forged by a caller holding the SAS. Read only the
  // first five bytes after the HEAD check so a non-PDF cannot pass as a PDF
  // merely by setting Content-Type to application/pdf.
  const prefixResponse = await blockBlobClient.download(0, 5);
  if (!prefixResponse.readableStreamBody) {
    const error = new Error('could not inspect uploaded receipt');
    error.code = 'RECEIPT_INSPECTION_FAILED';
    throw error;
  }

  const prefixChunks = [];
  for await (const chunk of prefixResponse.readableStreamBody) {
    prefixChunks.push(chunk);
  }
  const prefix = Buffer.concat(prefixChunks);
  if (prefix.length < 5 || prefix.subarray(0, 5).toString('ascii') !== '%PDF-') {
    const error = new Error('uploaded object is not a PDF');
    error.code = 'INVALID_RECEIPT_FORMAT';
    throw error;
  }

  return {
    valid: true,
    ticketId: payload.ticket_id,
    objectKey: payload.object_key,
    publicUrl: payload.public_url || publicUrlFor(config, payload.object_key),
    contentType,
    contentLength,
  };
}

function isAllowedUploadOrigin(origin) {
  const configured = String(process.env.UPLOAD_ALLOWED_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  return Boolean(origin && configured.includes(origin));
}

module.exports = {
  PDF_MIME_TYPE,
  MAX_RECEIPT_BYTES,
  createUploadTicket,
  validateUploadedReceipt,
  isAllowedUploadOrigin,
};
