import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fixture, refundFixture, createRuntime, spawnOracle, waitForMarker } from '../helpers/runtime.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required; crash tests never skip PostgreSQL');

let directory;
let oracle;
let runtime;
let crashCount = 0;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'payment-crash-'));
  oracle = await spawnOracle({ logPath: join(directory, 'processor.jsonl') });
  runtime = await createRuntime(databaseUrl, oracle.baseUrl, { reset: true });
});

after(async () => {
  await runtime?.close();
  await oracle?.stop();
  await rm(directory, { recursive: true, force: true });
});

async function killAt(operation, payload) {
  crashCount += 1;
  const marker = join(directory, `marker-${crashCount}`);
  const child = spawn(process.execPath, ['scripts/crash-worker.mjs', operation], {
    cwd: new URL('../..', import.meta.url),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PROCESSOR_URL: oracle.baseUrl,
      FAILPOINT_MARKER_PATH: marker,
      CRASH_PAYLOAD: JSON.stringify(payload)
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  let rejectEarly;
  const prematureExit = new Promise((_, reject) => { rejectEarly = reject; });
  const onEarlyExit = (code, signal) => {
    rejectEarly(new Error(`crash worker exited before marker (${code}/${signal}): ${stderr}`));
  };
  child.once('exit', onEarlyExit);
  await Promise.race([waitForMarker(marker), prematureExit]);
  child.removeListener('exit', onEarlyExit);
  child.kill('SIGKILL');
  const [code, signal] = await once(child, 'exit');
  assert.equal(code, null);
  assert.equal(signal, 'SIGKILL');
}

test('eight true SIGKILL windows replay durable local and external evidence exactly once', async () => {
  const createdData = fixture('cr01');
  await killAt('create-payment-after-commit', { payment: createdData.payment });
  const created = await runtime.service.createPayment(createdData.payment);
  assert.equal(created.state, 'created');

  await killAt('prepare-capture-after-commit', {
    paymentId: createdData.payment.paymentId,
    capture: createdData.capture
  });
  const prepared = await runtime.service.prepareCapture(createdData.payment.paymentId, createdData.capture);
  assert.equal(prepared.state, 'prepared');

  await killAt('capture-after-external', { attemptId: createdData.capture.attemptId });
  assert.equal((await runtime.repository.getAttempt(createdData.capture.attemptId)).state, 'prepared');
  const reconciledCapture = await runtime.service.reconcileAttempt(createdData.capture.attemptId, {
    expectedWorkerGeneration: 1
  });
  assert.equal(reconciledCapture.externalAccepted, true);

  const committedData = fixture('cr02');
  await runtime.service.createPayment(committedData.payment);
  await runtime.service.prepareCapture(committedData.payment.paymentId, committedData.capture);
  await killAt('capture-after-commit', { attemptId: committedData.capture.attemptId });
  const captureReplay = await runtime.service.dispatchAttempt(committedData.capture.attemptId);
  assert.equal(captureReplay.externalAccepted, true);

  const refundExternal = refundFixture('cr02a', '250');
  await runtime.service.prepareRefund(committedData.payment.paymentId, refundExternal);
  await killAt('refund-after-external', { attemptId: refundExternal.attemptId });
  assert.equal((await runtime.repository.getAttempt(refundExternal.attemptId)).state, 'prepared');
  const reconciledRefund = await runtime.service.reconcileAttempt(refundExternal.attemptId, {
    expectedWorkerGeneration: 1
  });
  assert.equal(reconciledRefund.journalPosted, true);

  const refundCommitted = refundFixture('cr02b', '250');
  await runtime.service.prepareRefund(committedData.payment.paymentId, refundCommitted);
  await killAt('refund-after-commit', { attemptId: refundCommitted.attemptId });
  const refundReplay = await runtime.service.dispatchAttempt(refundCommitted.attemptId);
  assert.equal(refundReplay.journalPosted, true);

  const evidence = await runtime.service.getPaymentEvidence(committedData.payment.paymentId);
  const event = evidence.outboxEvents[0];
  const delivery = {
    requestKey: 'req_delivery_cr02', eventId: event.event_id, payloadDigest: event.payload_digest,
    destinationClass: 'synthetic_merchant', expectedWorkerGeneration: 1
  };
  await killAt('delivery-after-commit', { deliveryId: 'delivery_event_cr02', delivery });
  const deliveryReplay = await runtime.service.acknowledgeDelivery('delivery_event_cr02', delivery);
  assert.equal(deliveryReplay.notificationAcknowledged, true);
  assert.equal(deliveryReplay.fulfilled, false);

  const reconciliationData = fixture('cr03');
  await runtime.service.createPayment(reconciliationData.payment);
  await runtime.service.prepareCapture(reconciliationData.payment.paymentId, reconciliationData.capture);
  const attempt = await runtime.repository.getAttempt(reconciliationData.capture.attemptId);
  await oracle.client.dispatch({
    processorKey: attempt.processor_key,
    requestDigest: attempt.request_digest,
    kind: attempt.kind,
    aggregateId: attempt.payment_id,
    paymentId: attempt.payment_id,
    amountMinor: attempt.amount_minor,
    currency: attempt.currency,
    decision: attempt.synthetic_decision
  });
  await runtime.repository.markAttemptUnknown(attempt.attempt_id);
  await killAt('reconcile-after-commit', { attemptId: attempt.attempt_id, expectedWorkerGeneration: 1 });
  const reconciliationReplay = await runtime.service.reconcileAttempt(attempt.attempt_id, {
    expectedWorkerGeneration: 1
  });
  assert.equal(reconciliationReplay.externalAccepted, true);

  const finalEvidence = await runtime.service.getPaymentEvidence(committedData.payment.paymentId);
  assert.equal(finalEvidence.journalTransactions.length, 3);
  assert.equal(finalEvidence.journalLines.length, 6);
  assert.equal(finalEvidence.acceptedRefundMinor, '500');
  const state = await runtime.service.getState();
  assert.equal(state.unbalanced_transactions, 0);
  assert.equal(state.over_refunded_payments, 0);
  assert.equal(state.externalAcceptance, false);
  assert.equal(crashCount, 8);
});
