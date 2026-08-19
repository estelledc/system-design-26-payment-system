import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, fixture, refundFixture, spawnOracle } from '../test/helpers/runtime.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required; benchmark never substitutes a fake database');

const directory = await mkdtemp(join(tmpdir(), 'payment-benchmark-'));
const logPath = join(directory, 'processor.jsonl');
let oracle = await spawnOracle({ logPath });
const runtime = await createRuntime(process.env.DATABASE_URL, oracle.baseUrl, { reset: true });

try {
  const payments = Array.from({ length: 32 }, (_, index) => fixture(`bench${String(index).padStart(2, '0')}`, '1000'));
  let started = performance.now();
  for (const data of payments) await runtime.service.createPayment(data.payment);
  const createBatchMs = performance.now() - started;

  started = performance.now();
  for (const data of payments) {
    await runtime.service.prepareCapture(data.payment.paymentId, data.capture);
    await runtime.service.dispatchAttempt(data.capture.attemptId);
  }
  const captureBatchMs = performance.now() - started;

  started = performance.now();
  for (let index = 0; index < 16; index += 1) {
    const refund = refundFixture(`bench${String(index).padStart(2, '0')}`, '100');
    await runtime.service.prepareRefund(payments[index].payment.paymentId, refund);
    await runtime.service.dispatchAttempt(refund.attemptId);
  }
  const refundBatchMs = performance.now() - started;

  started = performance.now();
  for (const data of payments) await runtime.service.getPaymentEvidence(data.payment.paymentId);
  const evidenceBatchMs = performance.now() - started;

  await oracle.stop();
  oracle = await spawnOracle({ logPath });
  const retained = await oracle.client.query(payments[0].capture.processorKey);
  assert.equal(retained.decision, 'accepted');

  const state = await runtime.service.getState();
  const version = await runtime.pool.query('SHOW server_version');
  assert.deepEqual({
    payments: state.payments,
    attempts: state.attempts,
    refunds: state.refunds,
    journalTransactions: state.journal_transactions,
    journalLines: state.journal_lines,
    outboxEvents: state.outbox_events,
    unresolvedAttempts: state.unresolved_attempts,
    unbalancedTransactions: state.unbalanced_transactions,
    overRefundedPayments: state.over_refunded_payments
  }, {
    payments: 32,
    attempts: 48,
    refunds: 16,
    journalTransactions: 48,
    journalLines: 96,
    outboxEvents: 48,
    unresolvedAttempts: 0,
    unbalancedTransactions: 0,
    overRefundedPayments: 0
  });

  process.stdout.write(`${JSON.stringify({
    fixture: {
      payments: 32,
      captureAttempts: 32,
      refundAttempts: 16,
      journalTransactions: 48,
      journalLines: 96,
      evidenceQueries: 32,
      processorRestarts: 1,
      currency: 'LAB',
      paymentAmountMinor: '1000',
      refundAmountMinor: '100'
    },
    observationsMs: {
      createBatch: Number(createBatchMs.toFixed(3)),
      captureBatch: Number(captureBatchMs.toFixed(3)),
      refundBatch: Number(refundBatchMs.toFixed(3)),
      evidenceBatch: Number(evidenceBatchMs.toFixed(3))
    },
    runtime: { node: process.version, postgresql: version.rows[0].server_version },
    invariants: {
      unresolvedAttempts: state.unresolved_attempts,
      unbalancedTransactions: state.unbalanced_transactions,
      overRefundedPayments: state.over_refunded_payments,
      oracleRestartReplay: true
    },
    exclusions: {
      realProvider: true,
      realMoney: true,
      settlement: true,
      compliance: true,
      productionCapacity: true,
      sla: true,
      merchantCustomerOutcome: true,
      externalAcceptance: true
    }
  })}\n`);
} finally {
  await runtime.close();
  await oracle.stop();
  await rm(directory, { recursive: true, force: true });
}
