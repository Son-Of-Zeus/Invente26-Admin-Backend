require('dotenv').config();

process.env.TZ = process.env.TZ || 'Asia/Kolkata';

const Redis = require('ioredis');

const db = require('../db');
const { createDocumentIntelligenceService } = require('../utils/documentIntelligence');
const { createPaymentOcrWorker } = require('./paymentOcrWorker');

const REQUIRED_ENVIRONMENT = [
  'DATABASE_URL',
  'REDIS_HOST',
  'REDIS_PORT',
  'REDIS_PASSWORD',
  'OCR_CONSUMER_NAME',
  'DOCUMENT_INTELLIGENCE_ENDPOINT',
  'DOCUMENT_INTELLIGENCE_API_KEY',
];

function validateConfiguration() {
  const missing = REQUIRED_ENVIRONMENT.filter(name => !String(process.env[name] || '').trim());
  if (missing.length > 0) {
    throw new Error(`Missing required OCR worker configuration: ${missing.join(', ')}`);
  }

  const redisPort = Number(process.env.REDIS_PORT);
  if (!Number.isInteger(redisPort) || redisPort <= 0 || redisPort > 65535) {
    throw new Error('REDIS_PORT must be an integer between 1 and 65535');
  }

  try {
    new URL(process.env.DOCUMENT_INTELLIGENCE_ENDPOINT);
  } catch (error) {
    throw new Error('DOCUMENT_INTELLIGENCE_ENDPOINT must be a valid URL');
  }

  return { redisPort };
}

async function main() {
  const { redisPort } = validateConfiguration();
  const redis = new Redis({
    host: process.env.REDIS_HOST,
    port: redisPort,
    password: process.env.REDIS_PASSWORD,
    lazyConnect: true,
    connectTimeout: 10000,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  const documentIntelligence = createDocumentIntelligenceService({
    endpoint: process.env.DOCUMENT_INTELLIGENCE_ENDPOINT,
    apiKey: process.env.DOCUMENT_INTELLIGENCE_API_KEY,
  });
  const worker = createPaymentOcrWorker({
    redis,
    database: db,
    documentIntelligence,
    consumerName: process.env.OCR_CONSUMER_NAME,
  });

  let shuttingDown = false;
  const requestShutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    worker.stop();
  };

  process.on('SIGINT', requestShutdown);
  process.on('SIGTERM', requestShutdown);

  try {
    await redis.connect();
    await redis.ping();
    await db.query('SELECT 1');
    await documentIntelligence.checkConnection();
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      event: 'payment_ocr_worker_started',
      consumer: process.env.OCR_CONSUMER_NAME,
    }));
    await worker.start();
  } finally {
    if (redis.status !== 'end') await redis.quit().catch(() => redis.disconnect());
    await db.end();
  }
}

main().catch(error => {
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    event: 'payment_ocr_worker_fatal',
    error_code: error?.code || error?.name || 'ERROR',
    message: 'OCR worker stopped due to a fatal error',
  }));
  process.exitCode = 1;
});
