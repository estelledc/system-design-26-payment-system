import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertBalanced,
  captureJournalLines,
  eventIdentity,
  journalIdentity,
  publicOutcome,
  refundJournalLines,
  signedBalance
} from '../../src/model.js';

test('capture and refund mappings each conserve one currency amount', () => {
  const capture = captureJournalLines('1250');
  const refund = refundJournalLines('250');
  assert.equal(signedBalance(capture), 0n);
  assert.equal(signedBalance(refund), 0n);
  assert.equal(assertBalanced(capture), true);
  assert.equal(capture[0].accountCode, refund[1].accountCode);
  assert.equal(capture[1].accountCode, refund[0].accountCode);
});

test('unbalanced or incomplete journal evidence fails closed', () => {
  assert.throws(() => assertBalanced(captureJournalLines('10').slice(0, 1)), { code: 'invariant_violation' });
  assert.throws(() => assertBalanced([
    { side: 'debit', amountMinor: '10' },
    { side: 'credit', amountMinor: '9' }
  ]), { code: 'invariant_violation' });
});

test('derived journal and event identities are deterministic and operation-bound', () => {
  assert.equal(journalIdentity('capture', 'att_capture_001'), journalIdentity('capture', 'att_capture_001'));
  assert.notEqual(journalIdentity('capture', 'att_capture_001'), journalIdentity('refund', 'att_capture_001'));
  assert.notEqual(eventIdentity('payment_captured', 'pay_payment_001', 3),
    eventIdentity('payment_captured', 'pay_payment_001', 4));
});

test('public outcome never upgrades local evidence to real-world acceptance', () => {
  const result = publicOutcome({ externalAccepted: true, journalPosted: true, externalAcceptance: true, settled: true });
  assert.equal(result.externalAccepted, true);
  assert.equal(result.journalPosted, true);
  assert.equal(result.externalAcceptance, false);
  assert.equal(result.settled, false);
  assert.equal(result.fulfilled, false);
});
