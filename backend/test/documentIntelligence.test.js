const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const { createDocumentIntelligenceService } = require('../src/utils/documentIntelligence');

test('checks Azure connectivity and completes a prebuilt-read URL analysis', async (t) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    requests.push({ method: req.method, url: req.url, body });

    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && req.url.startsWith('/documentintelligence/info')) {
      res.end(JSON.stringify({
        customDocumentModels: { count: 0, limit: 5000 },
        neuralDocumentModelBuilds: { quota: 20, used: 0, quotaResetsOn: '2026-09-14T00:00:00Z' },
      }));
      return;
    }

    if (req.method === 'POST' && req.url.startsWith('/documentintelligence/documentModels/prebuilt-read:analyze')) {
      res.statusCode = 202;
      res.setHeader(
        'operation-location',
        `http://127.0.0.1:${server.address().port}/documentModels/prebuilt-read/analyzeResults/test-result`,
      );
      res.end('{}');
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/documentModels/prebuilt-read/analyzeResults/test-result')) {
      res.end(JSON.stringify({
        status: 'succeeded',
        analyzeResult: { content: 'Receipt pay_1234567890ABCD' },
      }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: { code: 'NotFound', message: 'not found' } }));
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());

  const service = createDocumentIntelligenceService({
    endpoint: `http://127.0.0.1:${server.address().port}`,
    apiKey: 'fake-key',
    timeoutMs: 5000,
    connectionTimeoutMs: 5000,
    allowInsecureConnection: true,
  });

  await service.checkConnection();
  const content = await service.analyzeFromUrl('https://example.com/receipt.pdf');

  assert.equal(content, 'Receipt pay_1234567890ABCD');
  assert.equal(requests[0].method, 'GET');
  assert.match(requests[0].url, /^\/documentintelligence\/info\?api-version=/);
  assert.equal(requests[1].method, 'POST');
  assert.match(requests[1].url, /^\/documentintelligence\/documentModels\/prebuilt-read:analyze\?api-version=/);
  assert.deepEqual(requests[1].body, { urlSource: 'https://example.com/receipt.pdf' });
  assert.equal(requests[2].method, 'GET');
});
