import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalJson,
  digest,
  parseCaptureInput,
  parseDeliveryInput,
  parsePaymentInput,
  parseRefundInput
} from '../../src/contracts.js';

test('canonical digest is stable across object insertion order and changes with economics', () => {
  assert.equal(canonicalJson({ b: 2, a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"b":2}');
  assert.equal(digest({ b: 2, a: 1 }), digest({ a: 1, b: 2 }));
  assert.notEqual(digest({ amountMinor: '10' }), digest({ amountMinor: '11' }));
});

test('payment intent accepts only exact synthetic fields and integer LAB amount', () => {
  const valid = parsePaymentInput({
    requestKey: 'req_payment_001',
    paymentId: 'pay_payment_001',
    merchantId: 'merchant_lab_001',
    orderId: 'order_lab_001',
    amountMinor: '1250',
    currency: 'LAB'
  });
  assert.equal(valid.amountMinor, '1250');
  assert.throws(() => parsePaymentInput({ ...valid, amountMinor: '12.50' }), { code: 'invalid_request' });
  assert.throws(() => parsePaymentInput({ ...valid, amountMinor: 1250 }), { code: 'invalid_request' });
  assert.throws(() => parsePaymentInput({ ...valid, currency: 'USD' }), { code: 'invalid_request' });
  assert.throws(() => parsePaymentInput({ ...valid, cardNumber: 'not-allowed' }), { code: 'invalid_request' });
});

test('capture attempt binds stable processor identity, decision, and worker generation', () => {
  const parsed = parseCaptureInput({
    requestKey: 'req_capture_001',
    attemptId: 'att_capture_001',
    processorKey: 'proc_capture_001',
    syntheticDecision: 'accepted',
    expectedWorkerGeneration: 1
  }, 'pay_payment_001');
  assert.equal(parsed.paymentId, 'pay_payment_001');
  assert.throws(() => parseCaptureInput({ ...parsed, syntheticDecision: 'timeout' }, parsed.paymentId), {
    code: 'invalid_request'
  });
  assert.throws(() => parseCaptureInput({ ...parsed, expectedWorkerGeneration: 0 }, parsed.paymentId), {
    code: 'invalid_request'
  });
});

test('refund grammar rejects decimal, foreign currency, and unknown reason', () => {
  const valid = {
    requestKey: 'req_refund_001',
    refundId: 'ref_refund_001',
    attemptId: 'att_refund_001',
    processorKey: 'proc_refund_001',
    amountMinor: '250',
    currency: 'LAB',
    reasonClass: 'requested_by_merchant',
    syntheticDecision: 'accepted',
    expectedWorkerGeneration: 1
  };
  assert.equal(parseRefundInput(valid, 'pay_payment_001').amountMinor, '250');
  assert.throws(() => parseRefundInput({ ...valid, amountMinor: '2e2' }, 'pay_payment_001'), {
    code: 'invalid_request'
  });
  assert.throws(() => parseRefundInput({ ...valid, reasonClass: 'free_text' }, 'pay_payment_001'), {
    code: 'invalid_request'
  });
});

test('delivery acknowledgement binds immutable payload digest', () => {
  const parsed = parseDeliveryInput({
    requestKey: 'req_delivery_001',
    eventId: 'evt_event_001',
    payloadDigest: 'a'.repeat(64),
    destinationClass: 'synthetic_merchant',
    expectedWorkerGeneration: 1
  }, 'delivery_event_001');
  assert.equal(parsed.payloadDigest, 'a'.repeat(64));
  assert.throws(() => parseDeliveryInput({ ...parsed, payloadDigest: 'short' }, parsed.deliveryId), {
    code: 'invalid_request'
  });
});
