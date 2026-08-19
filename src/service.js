import {
  digest,
  parseCaptureInput,
  parseDeliveryInput,
  parseId,
  parsePaymentInput,
  parseRefundInput
} from './contracts.js';
import { DomainError } from './errors.js';

function processorRequestFromAttempt(attempt) {
  return Object.freeze({
    processorKey: attempt.processor_key,
    requestDigest: attempt.request_digest,
    kind: attempt.kind,
    aggregateId: attempt.kind === 'capture' ? attempt.payment_id : attempt.refund_id,
    paymentId: attempt.payment_id,
    amountMinor: attempt.amount_minor,
    currency: attempt.currency,
    decision: attempt.synthetic_decision
  });
}

function processorDigest({ kind, aggregateId, paymentId, amountMinor, currency, decision }) {
  return digest({ kind, aggregateId, paymentId, amountMinor, currency, decision });
}

export class PaymentService {
  constructor(repository, processorClient) {
    this.repository = repository;
    this.processorClient = processorClient;
  }

  createPayment(raw, options) {
    return this.repository.createPayment(parsePaymentInput(raw), options);
  }

  async prepareCapture(paymentId, raw, options) {
    const input = parseCaptureInput(raw, paymentId);
    const payment = await this.repository.getPaymentCore(input.paymentId);
    const requestDigest = processorDigest({
      kind: 'capture', aggregateId: input.paymentId, paymentId: input.paymentId,
      amountMinor: payment.amount_minor, currency: payment.currency, decision: input.syntheticDecision
    });
    return this.repository.prepareCapture(input, requestDigest, options);
  }

  async prepareRefund(paymentId, raw, options) {
    const input = parseRefundInput(raw, paymentId);
    const requestDigest = processorDigest({
      kind: 'refund', aggregateId: input.refundId, paymentId: input.paymentId,
      amountMinor: input.amountMinor, currency: input.currency, decision: input.syntheticDecision
    });
    return this.repository.prepareRefund(input, requestDigest, options);
  }

  async dispatchAttempt(attemptId, { afterExternalResult, afterCommit } = {}) {
    parseId(attemptId, 'attemptId');
    const attempt = await this.repository.getAttempt(attemptId);
    if (attempt.state === 'accepted' || attempt.state === 'declined') return attempt.final_result;
    let externalResult;
    try {
      externalResult = await this.processorClient.dispatch(processorRequestFromAttempt(attempt));
    } catch (error) {
      if (error instanceof DomainError && error.code === 'external_unknown') {
        return this.repository.markAttemptUnknown(attemptId);
      }
      throw error;
    }
    if (afterExternalResult) await afterExternalResult(externalResult);
    return this.repository.applyExternalResult(attemptId, externalResult, {
      workerKind: attempt.kind,
      expectedWorkerGeneration: attempt.worker_generation,
      afterCommit
    });
  }

  async reconcileAttempt(attemptId, { expectedWorkerGeneration, afterCommit } = {}) {
    parseId(attemptId, 'attemptId');
    const attempt = await this.repository.getAttempt(attemptId);
    if (attempt.state === 'accepted' || attempt.state === 'declined') {
      return { ...attempt.final_result, reconciliation: 'applied' };
    }
    const generation = expectedWorkerGeneration ?? await this.repository.getWorkerGeneration('reconcile');
    const externalResult = await this.processorClient.query(attempt.processor_key);
    if (!externalResult) {
      const unknown = await this.repository.markAttemptUnknown(attemptId);
      return { ...unknown, reconciliation: 'unresolved' };
    }
    const result = await this.repository.applyExternalResult(attemptId, externalResult, {
      workerKind: 'reconcile', expectedWorkerGeneration: generation, afterCommit
    });
    return { ...result, reconciliation: 'applied' };
  }

  acknowledgeDelivery(deliveryId, raw, options) {
    return this.repository.acknowledgeDelivery(parseDeliveryInput(raw, deliveryId), options);
  }

  advanceWorker(kind, expectedGeneration) {
    if (!['capture', 'refund', 'reconcile', 'delivery'].includes(kind)) {
      throw new DomainError('invalid_request', 'worker kind is unsupported');
    }
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) {
      throw new DomainError('invalid_request', 'expected generation is invalid');
    }
    return this.repository.advanceWorker(kind, expectedGeneration);
  }

  getPaymentEvidence(paymentId) {
    return this.repository.getPaymentEvidence(parseId(paymentId, 'paymentId'));
  }

  getState() {
    return this.repository.getState();
  }
}

export { processorRequestFromAttempt, processorDigest };
