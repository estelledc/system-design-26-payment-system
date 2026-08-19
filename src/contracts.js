import { createHash } from 'node:crypto';
import { fail } from './errors.js';

const LIMITS = Object.freeze({
  amountMinor: 1_000_000n,
  bodyBytes: 16_384,
  idLength: 72,
  reconciliationBatch: 64
});

const PREFIXES = Object.freeze({
  requestKey: 'req',
  paymentId: 'pay',
  merchantId: 'merchant',
  orderId: 'order',
  attemptId: 'att',
  processorKey: 'proc',
  refundId: 'ref',
  eventId: 'evt',
  deliveryId: 'delivery'
});

export { LIMITS };

export function assertPlainObject(value, label = 'request') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_request', `${label} must be a JSON object`);
  }
  return value;
}

export function exactKeys(value, required, optional = [], label = 'request') {
  assertPlainObject(value, label);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('invalid_request', `${label} contains unknown field`);
  }
  for (const key of required) {
    if (!(key in value)) fail('invalid_request', `${label} is missing required field`);
  }
}

export function parseId(value, field) {
  if (typeof value !== 'string' || value.length > LIMITS.idLength) {
    fail('invalid_request', `${field} has invalid identity grammar`);
  }
  const prefix = PREFIXES[field];
  if (!prefix || !new RegExp(`^${prefix}_[a-z0-9][a-z0-9_-]{2,63}$`).test(value)) {
    fail('invalid_request', `${field} has invalid identity grammar`);
  }
  return value;
}

export function parseAmountMinor(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,6}$/.test(value)) {
    fail('invalid_request', 'amountMinor must be a canonical positive integer string');
  }
  const amount = BigInt(value);
  if (amount > LIMITS.amountMinor) fail('invalid_request', 'amountMinor exceeds the lab bound');
  return amount;
}

export function parseCurrency(value) {
  if (value !== 'LAB') fail('invalid_request', 'currency must be the synthetic LAB unit');
  return value;
}

export function parseGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
    fail('invalid_request', 'expectedWorkerGeneration must be a bounded positive integer');
  }
  return value;
}

export function parseDecision(value) {
  if (value !== 'accepted' && value !== 'declined') {
    fail('invalid_request', 'syntheticDecision must be accepted or declined');
  }
  return value;
}

export function parseReasonClass(value) {
  if (value !== 'requested_by_merchant' && value !== 'duplicate_order') {
    fail('invalid_request', 'reasonClass is unsupported');
  }
  return value;
}

export function parseDestinationClass(value) {
  if (value !== 'synthetic_merchant') fail('invalid_request', 'destinationClass is unsupported');
  return value;
}

export function parseDigest(value, field = 'digest') {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    fail('invalid_request', `${field} must be a lowercase SHA-256 hex digest`);
  }
  return value;
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function digest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function parsePaymentInput(value) {
  exactKeys(value, ['requestKey', 'paymentId', 'merchantId', 'orderId', 'amountMinor', 'currency']);
  return Object.freeze({
    requestKey: parseId(value.requestKey, 'requestKey'),
    paymentId: parseId(value.paymentId, 'paymentId'),
    merchantId: parseId(value.merchantId, 'merchantId'),
    orderId: parseId(value.orderId, 'orderId'),
    amountMinor: parseAmountMinor(value.amountMinor).toString(),
    currency: parseCurrency(value.currency)
  });
}

export function parseCaptureInput(value, paymentId) {
  exactKeys(value, ['requestKey', 'attemptId', 'processorKey', 'syntheticDecision', 'expectedWorkerGeneration']);
  return Object.freeze({
    requestKey: parseId(value.requestKey, 'requestKey'),
    paymentId: parseId(paymentId, 'paymentId'),
    attemptId: parseId(value.attemptId, 'attemptId'),
    processorKey: parseId(value.processorKey, 'processorKey'),
    syntheticDecision: parseDecision(value.syntheticDecision),
    expectedWorkerGeneration: parseGeneration(value.expectedWorkerGeneration)
  });
}

export function parseRefundInput(value, paymentId) {
  exactKeys(value, [
    'requestKey', 'refundId', 'attemptId', 'processorKey', 'amountMinor', 'currency', 'reasonClass',
    'syntheticDecision', 'expectedWorkerGeneration'
  ]);
  return Object.freeze({
    requestKey: parseId(value.requestKey, 'requestKey'),
    paymentId: parseId(paymentId, 'paymentId'),
    refundId: parseId(value.refundId, 'refundId'),
    attemptId: parseId(value.attemptId, 'attemptId'),
    processorKey: parseId(value.processorKey, 'processorKey'),
    amountMinor: parseAmountMinor(value.amountMinor).toString(),
    currency: parseCurrency(value.currency),
    reasonClass: parseReasonClass(value.reasonClass),
    syntheticDecision: parseDecision(value.syntheticDecision),
    expectedWorkerGeneration: parseGeneration(value.expectedWorkerGeneration)
  });
}

export function parseDeliveryInput(value, deliveryId) {
  exactKeys(value, ['requestKey', 'eventId', 'payloadDigest', 'destinationClass', 'expectedWorkerGeneration']);
  return Object.freeze({
    requestKey: parseId(value.requestKey, 'requestKey'),
    deliveryId: parseId(deliveryId, 'deliveryId'),
    eventId: parseId(value.eventId, 'eventId'),
    payloadDigest: parseDigest(value.payloadDigest, 'payloadDigest'),
    destinationClass: parseDestinationClass(value.destinationClass),
    expectedWorkerGeneration: parseGeneration(value.expectedWorkerGeneration)
  });
}

export function parseProcessorRequest(value) {
  exactKeys(value, ['processorKey', 'requestDigest', 'kind', 'aggregateId', 'paymentId', 'amountMinor', 'currency', 'decision']);
  if (value.kind !== 'capture' && value.kind !== 'refund') fail('invalid_request', 'processor kind is unsupported');
  const aggregateField = value.kind === 'capture' ? 'paymentId' : 'refundId';
  return Object.freeze({
    processorKey: parseId(value.processorKey, 'processorKey'),
    requestDigest: parseDigest(value.requestDigest, 'requestDigest'),
    kind: value.kind,
    aggregateId: parseId(value.aggregateId, aggregateField),
    paymentId: parseId(value.paymentId, 'paymentId'),
    amountMinor: parseAmountMinor(value.amountMinor).toString(),
    currency: parseCurrency(value.currency),
    decision: parseDecision(value.decision)
  });
}
