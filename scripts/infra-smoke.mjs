import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, fixture, refundFixture, spawnOracle } from '../test/helpers/runtime.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required; smoke never substitutes a fake database');

const directory = await mkdtemp(join(tmpdir(), 'payment-smoke-'));
const oracle = await spawnOracle({ logPath: join(directory, 'processor.jsonl') });
const runtime = await createRuntime(process.env.DATABASE_URL, oracle.baseUrl, { reset: true });

try {
  const data = fixture('smoke01', '1000');
  await runtime.service.createPayment(data.payment);
  await runtime.service.prepareCapture(data.payment.paymentId, data.capture);
  const capture = await runtime.service.dispatchAttempt(data.capture.attemptId);

  const refunds = [refundFixture('smoke01a', '250'), refundFixture('smoke01b', '150')];
  for (const refund of refunds) {
    await runtime.service.prepareRefund(data.payment.paymentId, refund);
    await runtime.service.dispatchAttempt(refund.attemptId);
  }

  const beforeDelivery = await runtime.service.getPaymentEvidence(data.payment.paymentId);
  const event = beforeDelivery.outboxEvents[0];
  const delivery = await runtime.service.acknowledgeDelivery('delivery_smoke01', {
    requestKey: 'req_delivery_smoke01',
    eventId: event.event_id,
    payloadDigest: event.payload_digest,
    destinationClass: 'synthetic_merchant',
    expectedWorkerGeneration: 1
  });
  const evidence = await runtime.service.getPaymentEvidence(data.payment.paymentId);
  const state = await runtime.service.getState();

  assert.equal(capture.externalAccepted, true);
  assert.equal(evidence.payment.state, 'partially_refunded');
  assert.equal(evidence.acceptedRefundMinor, '400');
  assert.equal(evidence.reservedRefundMinor, '0');
  assert.equal(evidence.journalTransactions.length, 3);
  assert.equal(evidence.journalLines.length, 6);
  assert.equal(evidence.outboxEvents.length, 3);
  assert.equal(evidence.deliveries.length, 1);
  assert.equal(delivery.notificationAcknowledged, true);
  assert.equal(delivery.fulfilled, false);
  assert.equal(state.unbalanced_transactions, 0);
  assert.equal(state.over_refunded_payments, 0);
  assert.equal(state.externalAcceptance, false);

  process.stdout.write(`${JSON.stringify({
    paymentState: evidence.payment.state,
    acceptedRefundMinor: evidence.acceptedRefundMinor,
    journalTransactions: evidence.journalTransactions.length,
    journalLines: evidence.journalLines.length,
    outboxEvents: evidence.outboxEvents.length,
    localDeliveryAcknowledgements: evidence.deliveries.length,
    unbalancedTransactions: state.unbalanced_transactions,
    overRefundedPayments: state.over_refunded_payments,
    realMoneyMoved: state.realMoneyMoved,
    merchantNotified: state.merchantNotified,
    fulfilled: state.fulfilled,
    externalAcceptance: state.externalAcceptance
  })}\n`);
} finally {
  await runtime.close();
  await oracle.stop();
  await rm(directory, { recursive: true, force: true });
}
