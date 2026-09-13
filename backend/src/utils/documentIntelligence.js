const DocumentIntelligence = require('@azure-rest/ai-document-intelligence').default;
const {
  getLongRunningPoller,
  isUnexpected,
} = require('@azure-rest/ai-document-intelligence');

const DEFAULT_ANALYSIS_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 10 * 1000;

function getServiceError(response, fallbackMessage) {
  const error = new Error(response?.body?.error?.message || fallbackMessage);
  error.code = response?.body?.error?.code || 'DOCUMENT_INTELLIGENCE_ERROR';
  error.status = response?.status;
  return error;
}

function createDocumentIntelligenceService({
  endpoint,
  apiKey,
  timeoutMs = DEFAULT_ANALYSIS_TIMEOUT_MS,
  connectionTimeoutMs = DEFAULT_CONNECTION_TIMEOUT_MS,
  allowInsecureConnection = false,
}) {
  const client = DocumentIntelligence(endpoint, { key: apiKey }, {
    retryOptions: { maxRetries: 0 },
    allowInsecureConnection,
  });

  async function checkConnection() {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), connectionTimeoutMs);

    try {
      const response = await client.path('/info').get({
        abortSignal: abortController.signal,
      });
      if (isUnexpected(response)) {
        throw getServiceError(response, 'Azure Document Intelligence health check failed');
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  async function analyzeFromUrl(pdfUrl) {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);

    try {
      const initialResponse = await client
        .path('/documentModels/{modelId}:analyze', 'prebuilt-read')
        .post({
          contentType: 'application/json',
          body: { urlSource: pdfUrl },
          abortSignal: abortController.signal,
        });

      if (isUnexpected(initialResponse)) {
        throw getServiceError(initialResponse, 'Azure Document Intelligence analysis failed');
      }

      const poller = getLongRunningPoller(client, initialResponse);
      const response = await poller.pollUntilDone({ abortSignal: abortController.signal });
      return response?.body?.analyzeResult?.content || '';
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    checkConnection,
    analyzeFromUrl,
  };
}

module.exports = {
  DEFAULT_ANALYSIS_TIMEOUT_MS,
  DEFAULT_CONNECTION_TIMEOUT_MS,
  createDocumentIntelligenceService,
};
