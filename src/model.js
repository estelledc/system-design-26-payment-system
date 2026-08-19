import { digest } from './contracts.js';
import { fail } from './errors.js';

export const OUTCOME_BOUNDARY = Object.freeze({
  customerOutcome: false,
  settled: false,
  merchantNotified: false,
  fulfilled: false,
  compliant: false,
  externalAcceptance: false
});

export function captureJournalLines(amountMinor) {
  return Object.freeze([
    Object.freeze({ lineNo: 1, accountCode: 'processor_receivable', side: 'debit', amountMinor }),
    Object.freeze({ lineNo: 2, accountCode: 'merchant_payable', side: 'credit', amountMinor })
  ]);
}

export function refundJournalLines(amountMinor) {
  return Object.freeze([
    Object.freeze({ lineNo: 1, accountCode: 'merchant_payable', side: 'debit', amountMinor }),
    Object.freeze({ lineNo: 2, accountCode: 'processor_receivable', side: 'credit', amountMinor })
  ]);
}

export function signedBalance(lines) {
  return lines.reduce((sum, line) => {
    const amount = BigInt(line.amountMinor);
    return sum + (line.side === 'debit' ? amount : -amount);
  }, 0n);
}

export function assertBalanced(lines) {
  if (lines.length !== 2 || signedBalance(lines) !== 0n) {
    fail('invariant_violation', 'journal transaction must contain two balanced lines', 500);
  }
  if (lines.some((line) => BigInt(line.amountMinor) <= 0n)) {
    fail('invariant_violation', 'journal line amount must be positive', 500);
  }
  return true;
}

export function journalIdentity(kind, attemptId) {
  return `jtx_${digest({ kind, attemptId }).slice(0, 24)}`;
}

export function eventIdentity(kind, aggregateId, version) {
  return `evt_${digest({ kind, aggregateId, version }).slice(0, 24)}`;
}

export function eventPayload(kind, paymentId, aggregateId, amountMinor, currency, version) {
  const payload = { kind, paymentId, aggregateId, amountMinor, currency, version };
  return Object.freeze({ payload, payloadDigest: digest(payload) });
}

export function publicOutcome(extra = {}) {
  return Object.freeze({ ...extra, ...OUTCOME_BOUNDARY });
}
