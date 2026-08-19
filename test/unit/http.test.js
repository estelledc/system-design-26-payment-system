import assert from 'node:assert/strict';
import test from 'node:test';
import { DomainError } from '../../src/errors.js';
import { createPaymentServer } from '../../src/http.js';

async function withServer(service, callback) {
  const server = await createPaymentServer(service);
  try {
    return await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('HTTP creates a payment through the service without changing its receipt', async () => {
  let observed;
  const service = {
    async createPayment(body) {
      observed = body;
      return { paymentId: body.paymentId, state: 'created', externalAcceptance: false };
    }
  };
  await withServer(service, async (base) => {
    const response = await fetch(`${base}/v1/payments`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paymentId: 'pay_payment_001' })
    });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), {
      paymentId: 'pay_payment_001', state: 'created', externalAcceptance: false
    });
  });
  assert.deepEqual(observed, { paymentId: 'pay_payment_001' });
});

test('HTTP preserves typed unknown and sanitizes unexpected dependency errors', async () => {
  await withServer({
    async getState() {
      throw new DomainError('external_unknown', 'processor response is absent or ambiguous', 503);
    }
  }, async (base) => {
    const response = await fetch(`${base}/v1/state`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      code: 'external_unknown', message: 'processor response is absent or ambiguous'
    });
  });
  await withServer({
    async getState() {
      throw new Error('postgres credential and payment identity must not escape');
    }
  }, async (base) => {
    const response = await fetch(`${base}/v1/state`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      code: 'dependency_unavailable', message: 'required dependency did not provide a usable result'
    });
  });
});

test('HTTP rejects oversized JSON before service mutation', async () => {
  let called = false;
  await withServer({
    async createPayment() {
      called = true;
      return {};
    }
  }, async (base) => {
    const response = await fetch(`${base}/v1/payments`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(17_000) })
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).code, 'invalid_request');
  });
  assert.equal(called, false);
});
