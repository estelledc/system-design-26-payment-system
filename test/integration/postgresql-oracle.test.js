import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { digest } from '../../src/contracts.js';
import { createPaymentServer } from '../../src/http.js';
import { fixture, refundFixture, createRuntime, spawnOracle, waitForMarker } from '../helpers/runtime.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required; infrastructure tests never skip PostgreSQL');

let directory;
let oracle;
let runtime;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'payment-integration-'));
  oracle = await spawnOracle({ logPath: join(directory, 'processor.jsonl') });
  runtime = await createRuntime(databaseUrl, oracle.baseUrl, { reset: true });
});

after(async () => {
  await runtime?.close();
  await oracle?.stop();
  await rm(directory, { recursive: true, force: true });
});

test('payment and capture identities replay exactly and reject changed economics', async () => {
  const data = fixture('int01');
  const created = await runtime.service.createPayment(data.payment);
  assert.deepEqual(await runtime.service.createPayment(data.payment), created);
  await assert.rejects(runtime.service.createPayment({ ...data.payment, amountMinor: '1001' }), {
    code: 'intent_conflict'
  });

  const prepared = await runtime.service.prepareCapture(data.payment.paymentId, data.capture);
  assert.equal(prepared.state, 'prepared');
  assert.equal(await oracle.client.query(data.capture.processorKey), null);
  assert.deepEqual(await runtime.service.prepareCapture(data.payment.paymentId, data.capture), prepared);
  await assert.rejects(runtime.service.prepareCapture(data.payment.paymentId, {
    ...data.capture, syntheticDecision: 'declined'
  }), { code: 'intent_conflict' });
});

test('concurrent identical payment requests converge while changed request reuse rolls back its extra entity', async () => {
  const data = fixture('int01race');
  const identical = await Promise.all(Array.from({ length: 6 }, () => runtime.service.createPayment(data.payment)));
  assert.equal(new Set(identical.map((result) => `${result.paymentId}:${result.version}`)).size, 1);
  const changed = { ...fixture('int01other').payment, requestKey: data.payment.requestKey };
  await assert.rejects(runtime.service.createPayment(changed), { code: 'intent_conflict' });
  await assert.rejects(runtime.service.getPaymentEvidence(changed.paymentId), { code: 'not_found' });
});

test('accepted capture atomically posts one balanced journal and one outbox event', async () => {
  const data = fixture('int02', '1250');
  await runtime.service.createPayment(data.payment);
  await runtime.service.prepareCapture(data.payment.paymentId, data.capture);
  const first = await runtime.service.dispatchAttempt(data.capture.attemptId);
  const replay = await runtime.service.dispatchAttempt(data.capture.attemptId);
  assert.deepEqual(replay, first);
  assert.equal(first.externalAccepted, true);
  assert.equal(first.journalPosted, true);
  assert.equal(first.externalAcceptance, false);

  const evidence = await runtime.service.getPaymentEvidence(data.payment.paymentId);
  assert.equal(evidence.journalTransactions.length, 1);
  assert.equal(evidence.journalLines.length, 2);
  assert.equal(evidence.outboxEvents.length, 1);
  assert.equal(evidence.payment.state, 'captured');
  assert.equal(evidence.customerOutcome, false);
});

test('declined capture records terminal evidence without a journal or success outbox', async () => {
  const data = fixture('int03');
  data.capture.syntheticDecision = 'declined';
  await runtime.service.createPayment(data.payment);
  await runtime.service.prepareCapture(data.payment.paymentId, data.capture);
  const result = await runtime.service.dispatchAttempt(data.capture.attemptId);
  assert.equal(result.state, 'declined');
  assert.equal(result.externalAccepted, false);
  assert.equal(result.journalPosted, false);
  const evidence = await runtime.service.getPaymentEvidence(data.payment.paymentId);
  assert.equal(evidence.journalTransactions.length, 0);
  assert.equal(evidence.outboxEvents.length, 0);
  assert.equal(evidence.payment.state, 'declined');
});

test('PostgreSQL deferred constraint rejects an incomplete journal transaction at commit', async () => {
  const data = fixture('int03balance');
  data.capture.syntheticDecision = 'declined';
  await runtime.service.createPayment(data.payment);
  await runtime.service.prepareCapture(data.payment.paymentId, data.capture);
  await runtime.service.dispatchAttempt(data.capture.attemptId);
  const attempt = await runtime.repository.getAttempt(data.capture.attemptId);
  await assert.rejects(runtime.repository.tx(async (client) => {
    await client.query(
      `INSERT INTO journal_transactions(
         journal_tx_id, kind, payment_id, attempt_id, currency, external_receipt_digest
       ) VALUES ($1, 'capture', $2, $3, 'LAB', $4)`,
      ['jtx_unbalanced_int03balance', data.payment.paymentId, data.capture.attemptId, attempt.external_receipt_digest]
    );
    await client.query(
      `INSERT INTO journal_lines(journal_tx_id, line_no, account_code, side, amount_minor)
       VALUES ($1, 1, 'processor_receivable', 'debit', 1000)`,
      ['jtx_unbalanced_int03balance']
    );
  }), { code: '23514' });
  const evidence = await runtime.service.getPaymentEvidence(data.payment.paymentId);
  assert.equal(evidence.journalTransactions.length, 0);
});

test('oracle acceptance followed by response loss stays unknown until same-key reconciliation', async () => {
  const isolated = await mkdtemp(join(tmpdir(), 'payment-response-loss-'));
  const marker = join(isolated, 'accepted.marker');
  const logPath = join(isolated, 'processor.jsonl');
  const failingOracle = await spawnOracle({ logPath, failpoint: 'after_fsync_once', markerPath: marker });
  const failingRuntime = await createRuntime(databaseUrl, failingOracle.baseUrl, { timeoutMs: 10_000 });
  const data = fixture('int04');
  try {
    await failingRuntime.service.createPayment(data.payment);
    await failingRuntime.service.prepareCapture(data.payment.paymentId, data.capture);
    const dispatch = failingRuntime.service.dispatchAttempt(data.capture.attemptId);
    await waitForMarker(marker);
    await failingOracle.stop('SIGKILL');
    const unknown = await dispatch;
    assert.equal(unknown.state, 'unknown');
    assert.equal(unknown.externalAccepted, false);

    const restartedOracle = await spawnOracle({ logPath });
    const recovery = await createRuntime(databaseUrl, restartedOracle.baseUrl);
    try {
      const applied = await recovery.service.reconcileAttempt(data.capture.attemptId, { expectedWorkerGeneration: 1 });
      assert.equal(applied.reconciliation, 'applied');
      assert.equal(applied.externalAccepted, true);
      assert.deepEqual(
        await recovery.service.reconcileAttempt(data.capture.attemptId, { expectedWorkerGeneration: 1 }),
        applied
      );
    } finally {
      await recovery.close();
      await restartedOracle.stop();
    }
  } finally {
    await failingRuntime.close();
    await failingOracle.stop().catch(() => undefined);
    await rm(isolated, { recursive: true, force: true });
  }
});

test('concurrent capture finalizers converge on one external receipt and one journal effect', async () => {
  const data = fixture('int05');
  await runtime.service.createPayment(data.payment);
  await runtime.service.prepareCapture(data.payment.paymentId, data.capture);
  const results = await Promise.all(Array.from({ length: 6 }, () => runtime.service.dispatchAttempt(data.capture.attemptId)));
  assert.equal(new Set(results.map((result) => result.journalTxId)).size, 1);
  const evidence = await runtime.service.getPaymentEvidence(data.payment.paymentId);
  assert.equal(evidence.journalTransactions.length, 1);
  assert.equal(evidence.outboxEvents.length, 1);
});

test('row-locked refund reservations prevent concurrent over-refund and accepted refunds reverse once', async () => {
  const data = fixture('int06', '1000');
  await runtime.service.createPayment(data.payment);
  await runtime.service.prepareCapture(data.payment.paymentId, data.capture);
  await runtime.service.dispatchAttempt(data.capture.attemptId);

  const first = refundFixture('int06a', '600');
  await runtime.service.prepareRefund(data.payment.paymentId, first);
  const candidates = [refundFixture('int06b', '400'), refundFixture('int06c', '400')];
  const raced = await Promise.allSettled(candidates.map((item) => runtime.service.prepareRefund(data.payment.paymentId, item)));
  assert.equal(raced.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(raced.filter((item) => item.status === 'rejected' && item.reason.code === 'insufficient_captured_value').length, 1);

  const acceptedSecond = candidates[raced.findIndex((item) => item.status === 'fulfilled')];
  await runtime.service.dispatchAttempt(first.attemptId);
  await runtime.service.dispatchAttempt(acceptedSecond.attemptId);
  const evidence = await runtime.service.getPaymentEvidence(data.payment.paymentId);
  assert.equal(evidence.acceptedRefundMinor, '1000');
  assert.equal(evidence.payment.state, 'refunded');
  assert.equal(evidence.journalTransactions.length, 3);
  assert.equal(evidence.journalLines.length, 6);
});

test('stale capture worker cannot apply accepted evidence but reconciliation can', async () => {
  const data = fixture('int07');
  await runtime.service.createPayment(data.payment);
  await runtime.service.prepareCapture(data.payment.paymentId, data.capture);
  await assert.rejects(runtime.service.dispatchAttempt(data.capture.attemptId, {
    afterExternalResult: async () => runtime.service.advanceWorker('capture', 1)
  }), { code: 'worker_fenced' });
  const attempt = await runtime.repository.getAttempt(data.capture.attemptId);
  assert.equal(attempt.state, 'prepared');
  const recovered = await runtime.service.reconcileAttempt(data.capture.attemptId, { expectedWorkerGeneration: 1 });
  assert.equal(recovered.externalAccepted, true);
});

test('delivery acknowledgement replays one payload and state reports no invariant breach', async () => {
  const data = fixture('int08');
  data.capture.expectedWorkerGeneration = await runtime.repository.getWorkerGeneration('capture');
  await runtime.service.createPayment(data.payment);
  await runtime.service.prepareCapture(data.payment.paymentId, data.capture);
  await runtime.service.dispatchAttempt(data.capture.attemptId);
  const evidence = await runtime.service.getPaymentEvidence(data.payment.paymentId);
  const event = evidence.outboxEvents[0];
  const input = {
    requestKey: 'req_delivery_int08', eventId: event.event_id, payloadDigest: event.payload_digest,
    destinationClass: 'synthetic_merchant', expectedWorkerGeneration: 1
  };
  const acknowledged = await runtime.service.acknowledgeDelivery('delivery_event_int08', input);
  assert.deepEqual(await runtime.service.acknowledgeDelivery('delivery_event_int08', input), acknowledged);
  await assert.rejects(runtime.service.acknowledgeDelivery('delivery_event_int08', {
    ...input, payloadDigest: digest({ changed: true })
  }), { code: 'intent_conflict' });
  const state = await runtime.service.getState();
  assert.equal(state.unbalanced_transactions, 0);
  assert.equal(state.over_refunded_payments, 0);
  assert.equal(state.realMoneyMoved, false);
  assert.equal(state.externalAcceptance, false);
});

test('real HTTP routes execute the PostgreSQL and processor-oracle vertical slice', async () => {
  const data = fixture('int09');
  data.capture.expectedWorkerGeneration = await runtime.repository.getWorkerGeneration('capture');
  const server = await createPaymentServer(runtime.service);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let response = await fetch(`${base}/v1/payments`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data.payment)
    });
    assert.equal(response.status, 201);
    response = await fetch(`${base}/v1/payments/${data.payment.paymentId}/capture-attempts`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data.capture)
    });
    assert.equal(response.status, 201);
    response = await fetch(`${base}/v1/attempts/${data.capture.attemptId}/dispatch`, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).journalPosted, true);
    response = await fetch(`${base}/v1/payments/${data.payment.paymentId}/evidence`);
    assert.equal(response.status, 200);
    const evidence = await response.json();
    assert.equal(evidence.journalTransactions.length, 1);
    assert.equal(evidence.externalAcceptance, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
