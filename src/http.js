import { createServer } from 'node:http';
import { exactKeys, LIMITS } from './contracts.js';
import { DomainError, asDomainError, fail } from './errors.js';

async function readBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > LIMITS.bodyBytes) fail('invalid_request', 'request body exceeds bound', 413);
    chunks.push(chunk);
  }
  if (chunks.length === 0) fail('invalid_request', 'request body is required');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    fail('invalid_request', 'request body must be valid JSON');
  }
}

function send(response, status, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(encoded),
    'cache-control': 'no-store'
  });
  response.end(encoded);
}

export function createRequestHandler(service) {
  return async (request, response) => {
    try {
      const url = new URL(request.url, 'http://payment.invalid');
      if (request.method === 'GET' && url.pathname === '/health') return send(response, 200, { status: 'ok' });
      if (request.method === 'GET' && url.pathname === '/v1/state') {
        return send(response, 200, await service.getState());
      }
      if (request.method === 'POST' && url.pathname === '/v1/payments') {
        return send(response, 201, await service.createPayment(await readBody(request)));
      }
      let match = url.pathname.match(/^\/v1\/payments\/([^/]+)\/capture-attempts$/);
      if (request.method === 'POST' && match) {
        return send(response, 201, await service.prepareCapture(decodeURIComponent(match[1]), await readBody(request)));
      }
      match = url.pathname.match(/^\/v1\/payments\/([^/]+)\/refunds$/);
      if (request.method === 'POST' && match) {
        return send(response, 201, await service.prepareRefund(decodeURIComponent(match[1]), await readBody(request)));
      }
      match = url.pathname.match(/^\/v1\/attempts\/([^/]+)\/dispatch$/);
      if (request.method === 'POST' && match) {
        return send(response, 200, await service.dispatchAttempt(decodeURIComponent(match[1])));
      }
      match = url.pathname.match(/^\/v1\/attempts\/([^/]+)\/reconcile$/);
      if (request.method === 'POST' && match) {
        const body = await readBody(request);
        exactKeys(body, ['expectedWorkerGeneration']);
        return send(response, 200, await service.reconcileAttempt(decodeURIComponent(match[1]), {
          expectedWorkerGeneration: body.expectedWorkerGeneration
        }));
      }
      match = url.pathname.match(/^\/v1\/deliveries\/([^/]+)\/acknowledge$/);
      if (request.method === 'POST' && match) {
        return send(response, 200, await service.acknowledgeDelivery(
          decodeURIComponent(match[1]), await readBody(request)
        ));
      }
      match = url.pathname.match(/^\/v1\/worker-assignments\/([^/]+)\/advance$/);
      if (request.method === 'POST' && match) {
        const body = await readBody(request);
        exactKeys(body, ['expectedGeneration']);
        return send(response, 200, await service.advanceWorker(decodeURIComponent(match[1]), body.expectedGeneration));
      }
      match = url.pathname.match(/^\/v1\/payments\/([^/]+)\/evidence$/);
      if (request.method === 'GET' && match) {
        return send(response, 200, await service.getPaymentEvidence(decodeURIComponent(match[1])));
      }
      return send(response, 404, { code: 'not_found', message: 'route is not available' });
    } catch (error) {
      const mapped = error instanceof DomainError ? error : asDomainError(error);
      return send(response, mapped.status, { code: mapped.code, message: mapped.message });
    }
  };
}

export async function createPaymentServer(service, { host = '127.0.0.1', port = 0 } = {}) {
  const server = createServer(createRequestHandler(service));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return server;
}
