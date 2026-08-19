import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { digest } from '../../src/contracts.js';
import { DurableProcessorOracle } from '../../src/processor-oracle.js';

function request(overrides = {}) {
  const base = {
    processorKey: 'proc_capture_001',
    kind: 'capture',
    aggregateId: 'pay_payment_001',
    paymentId: 'pay_payment_001',
    amountMinor: '1250',
    currency: 'LAB',
    decision: 'accepted'
  };
  const complete = { ...base, ...overrides };
  return { ...complete, requestDigest: digest({
    kind: complete.kind,
    aggregateId: complete.aggregateId,
    paymentId: complete.paymentId,
    amountMinor: complete.amountMinor,
    currency: complete.currency,
    decision: complete.decision
  }) };
}

test('durable oracle replays one immutable decision across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'payment-oracle-unit-'));
  const path = join(directory, 'decisions.jsonl');
  try {
    const first = await new DurableProcessorOracle(path).init();
    const accepted = await first.decide(request());
    assert.equal(accepted.durable, true);
    assert.equal(accepted.realMoneyMoved, false);
    const restarted = await new DurableProcessorOracle(path).init();
    assert.deepEqual(await restarted.decide(request()), accepted);
    assert.deepEqual(restarted.get('proc_capture_001'), accepted);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('durable oracle rejects one key rebound to changed intent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'payment-oracle-conflict-'));
  const path = join(directory, 'decisions.jsonl');
  try {
    const oracle = await new DurableProcessorOracle(path).init();
    await oracle.decide(request());
    await assert.rejects(oracle.decide(request({ amountMinor: '1251' })), { code: 'intent_conflict' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
