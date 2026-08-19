import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { digest } from './contracts.js';
import { DomainError, fail } from './errors.js';
import {
  assertBalanced,
  captureJournalLines,
  eventIdentity,
  eventPayload,
  journalIdentity,
  publicOutcome,
  refundJournalLines
} from './model.js';

const SCHEMA_URL = new URL('../sql/schema.sql', import.meta.url);

function paymentResult(row) {
  return publicOutcome({
    paymentId: row.payment_id,
    state: row.state,
    amountMinor: row.amount_minor,
    currency: row.currency,
    generation: row.generation,
    version: row.version,
    externalAccepted: row.state === 'captured' || row.state === 'partially_refunded' || row.state === 'refunded',
    journalPosted: Boolean(row.capture_journal_tx_id),
    notificationAcknowledged: false
  });
}

function attemptResult(row) {
  if (row.final_result) return row.final_result;
  return publicOutcome({
    attemptId: row.attempt_id,
    paymentId: row.payment_id,
    refundId: row.refund_id,
    kind: row.kind,
    state: row.state,
    processorKey: row.processor_key,
    externalAccepted: false,
    journalPosted: false,
    notificationAcknowledged: false
  });
}

async function afterCommit(hook, result) {
  if (hook) await hook(result);
  return result;
}

export class PaymentRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async init() {
    const sql = await readFile(fileURLToPath(SCHEMA_URL), 'utf8');
    await this.pool.query(sql);
    return this;
  }

  async close() {
    await this.pool.end();
  }

  async reset() {
    await this.pool.query(`
      TRUNCATE reconciliation_runs, deliveries, outbox_events, journal_lines, journal_transactions,
        processor_attempts, refunds, payment_intents, operation_receipts RESTART IDENTITY CASCADE;
      UPDATE worker_assignments SET generation = 1, updated_at = clock_timestamp();
    `);
  }

  async tx(callback) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async readReceipt(client, operation, requestKey, intentDigest) {
    const { rows } = await client.query(
      'SELECT intent_digest, result FROM operation_receipts WHERE operation = $1 AND request_key = $2',
      [operation, requestKey]
    );
    if (rows.length === 0) return null;
    if (rows[0].intent_digest !== intentDigest) {
      fail('intent_conflict', 'request key is already bound to changed intent', 409);
    }
    return rows[0].result;
  }

  async insertReceipt(client, operation, requestKey, intentDigest, result) {
    const inserted = await client.query(
      `INSERT INTO operation_receipts(operation, request_key, intent_digest, result)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (operation, request_key) DO NOTHING
       RETURNING result`,
      [operation, requestKey, intentDigest, result]
    );
    if (inserted.rows.length > 0) return inserted.rows[0].result;
    return this.readReceipt(client, operation, requestKey, intentDigest);
  }

  async lockWorker(client, kind, expectedGeneration) {
    const { rows } = await client.query(
      'SELECT generation FROM worker_assignments WHERE kind = $1 FOR UPDATE',
      [kind]
    );
    if (rows.length === 0 || rows[0].generation !== expectedGeneration) {
      fail('worker_fenced', 'worker assignment generation is stale', 409);
    }
    return rows[0].generation;
  }

  async createPayment(input, { afterCommit: hook } = {}) {
    const intent = {
      operation: 'create_payment', paymentId: input.paymentId, merchantId: input.merchantId, orderId: input.orderId,
      amountMinor: input.amountMinor, currency: input.currency
    };
    const intentDigest = digest(intent);
    const result = await this.tx(async (client) => {
      const replay = await this.readReceipt(client, 'create_payment', input.requestKey, intentDigest);
      if (replay) return replay;

      const existing = await client.query(
        `SELECT * FROM payment_intents
         WHERE payment_id = $1 OR (merchant_id = $2 AND order_id = $3)
         FOR UPDATE`,
        [input.paymentId, input.merchantId, input.orderId]
      );
      let output;
      if (existing.rows.length > 0) {
        if (existing.rows.length !== 1) {
          fail('intent_conflict', 'payment and merchant order identities refer to different records', 409);
        }
        const row = existing.rows[0];
        if (row.payment_id !== input.paymentId || row.intent_digest !== intentDigest) {
          fail('intent_conflict', 'payment identity or merchant order is bound to changed intent', 409);
        }
        output = paymentResult(row);
      } else {
        const inserted = await client.query(
          `INSERT INTO payment_intents(
             payment_id, merchant_id, order_id, amount_minor, currency, intent_digest, state
           ) VALUES ($1, $2, $3, $4, $5, $6, 'created')
           ON CONFLICT DO NOTHING RETURNING *`,
          [input.paymentId, input.merchantId, input.orderId, input.amountMinor, input.currency, intentDigest]
        );
        if (inserted.rows.length > 0) {
          output = paymentResult(inserted.rows[0]);
        } else {
          const raced = await client.query(
            `SELECT * FROM payment_intents
             WHERE payment_id = $1 OR (merchant_id = $2 AND order_id = $3)
             FOR UPDATE`,
            [input.paymentId, input.merchantId, input.orderId]
          );
          if (raced.rows.length !== 1 || raced.rows[0].payment_id !== input.paymentId ||
              raced.rows[0].intent_digest !== intentDigest) {
            fail('intent_conflict', 'payment identity or merchant order is bound to changed intent', 409);
          }
          output = paymentResult(raced.rows[0]);
        }
      }
      return this.insertReceipt(client, 'create_payment', input.requestKey, intentDigest, output);
    });
    return afterCommit(hook, result);
  }

  async prepareCapture(input, requestDigest, { afterCommit: hook } = {}) {
    const intentDigest = digest({ operation: 'prepare_capture', ...input, requestDigest });
    const result = await this.tx(async (client) => {
      const replay = await this.readReceipt(client, 'prepare_capture', input.requestKey, intentDigest);
      if (replay) return replay;
      await this.lockWorker(client, 'capture', input.expectedWorkerGeneration);
      const paymentQuery = await client.query(
        'SELECT * FROM payment_intents WHERE payment_id = $1 FOR UPDATE', [input.paymentId]
      );
      if (paymentQuery.rows.length === 0) fail('not_found', 'payment is not retained', 404);
      const payment = paymentQuery.rows[0];
      const existing = await client.query(
        `SELECT * FROM processor_attempts
         WHERE attempt_id = $1 OR processor_key = $2 OR (payment_id = $3 AND kind = 'capture')
         FOR UPDATE`,
        [input.attemptId, input.processorKey, input.paymentId]
      );
      let output;
      if (existing.rows.length > 0) {
        if (existing.rows.length !== 1) {
          fail('intent_conflict', 'capture identities refer to different attempts', 409);
        }
        const attempt = existing.rows[0];
        if (attempt.attempt_id !== input.attemptId || attempt.processor_key !== input.processorKey ||
            attempt.request_digest !== requestDigest) {
          fail('intent_conflict', 'capture identity is already bound to changed intent', 409);
        }
        output = attemptResult(attempt);
      } else {
        if (payment.state !== 'created') fail('invalid_state', 'payment cannot prepare another capture', 409);
        const inserted = await client.query(
          `INSERT INTO processor_attempts(
             attempt_id, kind, payment_id, processor_key, request_digest, amount_minor, currency,
             synthetic_decision, state, worker_generation
           ) VALUES ($1, 'capture', $2, $3, $4, $5, $6, $7, 'prepared', $8)
           RETURNING *`,
          [input.attemptId, input.paymentId, input.processorKey, requestDigest, payment.amount_minor,
            payment.currency, input.syntheticDecision, input.expectedWorkerGeneration]
        );
        await client.query(
          `UPDATE payment_intents SET state = 'capture_prepared', capture_attempt_id = $2,
             version = version + 1, updated_at = clock_timestamp() WHERE payment_id = $1`,
          [input.paymentId, input.attemptId]
        );
        output = attemptResult(inserted.rows[0]);
      }
      return this.insertReceipt(client, 'prepare_capture', input.requestKey, intentDigest, output);
    });
    return afterCommit(hook, result);
  }

  async prepareRefund(input, requestDigest, { afterCommit: hook } = {}) {
    const intentDigest = digest({ operation: 'prepare_refund', ...input, requestDigest });
    const result = await this.tx(async (client) => {
      const replay = await this.readReceipt(client, 'prepare_refund', input.requestKey, intentDigest);
      if (replay) return replay;
      await this.lockWorker(client, 'refund', input.expectedWorkerGeneration);
      const paymentQuery = await client.query(
        'SELECT * FROM payment_intents WHERE payment_id = $1 FOR UPDATE', [input.paymentId]
      );
      if (paymentQuery.rows.length === 0) fail('not_found', 'payment is not retained', 404);
      const payment = paymentQuery.rows[0];
      if (!['captured', 'refund_pending', 'partially_refunded'].includes(payment.state)) {
        fail('invalid_state', 'refund requires captured value', 409);
      }
      const existing = await client.query(
        `SELECT r.*, a.processor_key, a.request_digest, a.final_result
         FROM refunds r JOIN processor_attempts a ON a.attempt_id = r.attempt_id
         WHERE r.refund_id = $1 OR r.request_key = $2 OR a.attempt_id = $3 OR a.processor_key = $4
         FOR UPDATE OF r, a`,
        [input.refundId, input.requestKey, input.attemptId, input.processorKey]
      );
      let output;
      if (existing.rows.length > 0) {
        if (existing.rows.length !== 1) {
          fail('intent_conflict', 'refund identities refer to different records', 409);
        }
        const row = existing.rows[0];
        if (row.refund_id !== input.refundId || row.attempt_id !== input.attemptId ||
            row.processor_key !== input.processorKey || row.intent_digest !== intentDigest ||
            row.request_digest !== requestDigest) {
          fail('intent_conflict', 'refund identity is already bound to changed intent', 409);
        }
        output = row.final_result ?? publicOutcome({
          refundId: row.refund_id, paymentId: row.payment_id, attemptId: row.attempt_id, state: row.state,
          amountMinor: row.amount_minor, currency: row.currency, externalAccepted: false, journalPosted: false,
          notificationAcknowledged: false
        });
      } else {
        const reserved = await client.query(
          `SELECT COALESCE(sum(amount_minor), 0)::text AS total
           FROM refunds WHERE payment_id = $1 AND state IN ('prepared', 'unknown', 'accepted', 'reconciliation_required')`,
          [input.paymentId]
        );
        if (BigInt(reserved.rows[0].total) + BigInt(input.amountMinor) > BigInt(payment.captured_amount_minor)) {
          fail('insufficient_captured_value', 'refund would exceed captured value', 409);
        }
        await client.query(
          `INSERT INTO refunds(
             refund_id, payment_id, request_key, intent_digest, amount_minor, currency, reason_class, state, attempt_id
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'prepared', $8)`,
          [input.refundId, input.paymentId, input.requestKey, intentDigest, input.amountMinor, input.currency,
            input.reasonClass, input.attemptId]
        );
        const inserted = await client.query(
          `INSERT INTO processor_attempts(
             attempt_id, kind, payment_id, refund_id, processor_key, request_digest, amount_minor, currency,
             synthetic_decision, state, worker_generation
           ) VALUES ($1, 'refund', $2, $3, $4, $5, $6, $7, $8, 'prepared', $9)
           RETURNING *`,
          [input.attemptId, input.paymentId, input.refundId, input.processorKey, requestDigest, input.amountMinor,
            input.currency, input.syntheticDecision, input.expectedWorkerGeneration]
        );
        await client.query(
          `UPDATE payment_intents SET state = 'refund_pending', version = version + 1,
             updated_at = clock_timestamp() WHERE payment_id = $1`, [input.paymentId]
        );
        output = publicOutcome({
          refundId: input.refundId, paymentId: input.paymentId, attemptId: input.attemptId, state: 'prepared',
          amountMinor: input.amountMinor, currency: input.currency, externalAccepted: false, journalPosted: false,
          notificationAcknowledged: false
        });
        if (inserted.rows[0].request_digest !== requestDigest) {
          fail('invariant_violation', 'stored refund attempt digest changed', 500);
        }
      }
      return this.insertReceipt(client, 'prepare_refund', input.requestKey, intentDigest, output);
    });
    return afterCommit(hook, result);
  }

  async getAttempt(attemptId) {
    const { rows } = await this.pool.query('SELECT * FROM processor_attempts WHERE attempt_id = $1', [attemptId]);
    if (rows.length === 0) fail('not_found', 'attempt is not retained', 404);
    return rows[0];
  }

  async getPaymentCore(paymentId) {
    const { rows } = await this.pool.query(
      `SELECT payment_id, amount_minor::text, currency, state, generation, version
       FROM payment_intents WHERE payment_id = $1`, [paymentId]
    );
    if (rows.length === 0) fail('not_found', 'payment is not retained', 404);
    return rows[0];
  }

  async markAttemptUnknown(attemptId) {
    return this.tx(async (client) => {
      const attemptQuery = await client.query(
        'SELECT * FROM processor_attempts WHERE attempt_id = $1 FOR UPDATE', [attemptId]
      );
      if (attemptQuery.rows.length === 0) fail('not_found', 'attempt is not retained', 404);
      const attempt = attemptQuery.rows[0];
      if (attempt.state === 'accepted' || attempt.state === 'declined') return attemptResult(attempt);
      if (attempt.state !== 'unknown') {
        await client.query(
          `UPDATE processor_attempts SET state = 'unknown', updated_at = clock_timestamp() WHERE attempt_id = $1`,
          [attemptId]
        );
        if (attempt.kind === 'capture') {
          await client.query(
            `UPDATE payment_intents SET state = 'capture_unknown', updated_at = clock_timestamp()
             WHERE payment_id = $1 AND state = 'capture_prepared'`, [attempt.payment_id]
          );
        } else {
          await client.query(
            `UPDATE refunds SET state = 'unknown', updated_at = clock_timestamp() WHERE refund_id = $1`,
            [attempt.refund_id]
          );
        }
      }
      return publicOutcome({
        attemptId, paymentId: attempt.payment_id, refundId: attempt.refund_id, kind: attempt.kind,
        state: 'unknown', processorKey: attempt.processor_key, externalAccepted: false, journalPosted: false,
        notificationAcknowledged: false
      });
    });
  }

  validateExternalResult(attempt, result) {
    const expected = {
      processorKey: attempt.processor_key,
      requestDigest: attempt.request_digest,
      kind: attempt.kind,
      aggregateId: attempt.kind === 'capture' ? attempt.payment_id : attempt.refund_id,
      paymentId: attempt.payment_id,
      amountMinor: attempt.amount_minor,
      currency: attempt.currency,
      decision: attempt.synthetic_decision
    };
    const expectedReceipt = digest({ request: expected, decision: expected.decision });
    for (const [key, value] of Object.entries(expected)) {
      if (result?.[key] !== value) fail('external_evidence_conflict', 'processor result mismatches stored attempt', 409);
    }
    if (result.receiptDigest !== expectedReceipt || result.durable !== true) {
      fail('external_evidence_conflict', 'processor receipt is not the expected durable evidence', 409);
    }
    return expectedReceipt;
  }

  async applyExternalResult(attemptId, externalResult, {
    workerKind,
    expectedWorkerGeneration,
    afterCommit: hook
  }) {
    const result = await this.tx(async (client) => {
      const kindQuery = await client.query('SELECT kind FROM processor_attempts WHERE attempt_id = $1', [attemptId]);
      if (kindQuery.rows.length === 0) fail('not_found', 'attempt is not retained', 404);
      const kind = kindQuery.rows[0].kind;
      if (workerKind !== kind && workerKind !== 'reconcile') {
        fail('worker_fenced', 'worker kind cannot finalize this attempt', 409);
      }
      await this.lockWorker(client, workerKind, expectedWorkerGeneration);
      const attemptQuery = await client.query(
        'SELECT * FROM processor_attempts WHERE attempt_id = $1 FOR UPDATE', [attemptId]
      );
      const attempt = attemptQuery.rows[0];
      const receiptDigest = this.validateExternalResult(attempt, externalResult);
      if (attempt.state === 'accepted' || attempt.state === 'declined') {
        if (attempt.external_receipt_digest !== receiptDigest) {
          fail('external_evidence_conflict', 'terminal attempt has different external receipt', 409);
        }
        return attempt.final_result;
      }
      if (workerKind !== 'reconcile' && attempt.worker_generation !== expectedWorkerGeneration) {
        fail('worker_fenced', 'attempt belongs to a stale worker generation', 409);
      }
      const paymentQuery = await client.query(
        'SELECT * FROM payment_intents WHERE payment_id = $1 FOR UPDATE', [attempt.payment_id]
      );
      const payment = paymentQuery.rows[0];
      if (attempt.kind === 'capture') {
        return this.applyCapture(client, payment, attempt, externalResult, receiptDigest);
      }
      const refundQuery = await client.query('SELECT * FROM refunds WHERE refund_id = $1 FOR UPDATE', [attempt.refund_id]);
      return this.applyRefund(client, payment, refundQuery.rows[0], attempt, externalResult, receiptDigest);
    });
    return afterCommit(hook, result);
  }

  async insertJournal(client, { kind, paymentId, refundId, attemptId, amountMinor, currency, receiptDigest }) {
    const journalTxId = journalIdentity(kind, attemptId);
    const lines = kind === 'capture' ? captureJournalLines(amountMinor) : refundJournalLines(amountMinor);
    assertBalanced(lines);
    await client.query(
      `INSERT INTO journal_transactions(
         journal_tx_id, kind, payment_id, refund_id, attempt_id, currency, external_receipt_digest
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [journalTxId, kind, paymentId, refundId, attemptId, currency, receiptDigest]
    );
    for (const line of lines) {
      await client.query(
        `INSERT INTO journal_lines(journal_tx_id, line_no, account_code, side, amount_minor)
         VALUES ($1, $2, $3, $4, $5)`,
        [journalTxId, line.lineNo, line.accountCode, line.side, line.amountMinor]
      );
    }
    return journalTxId;
  }

  async insertOutbox(client, { kind, paymentId, refundId, amountMinor, currency, version }) {
    const aggregateId = refundId ?? paymentId;
    const eventType = kind === 'capture' ? 'payment_captured' : 'refund_accepted';
    const eventId = eventIdentity(eventType, aggregateId, version);
    const { payload, payloadDigest } = eventPayload(eventType, paymentId, aggregateId, amountMinor, currency, version);
    await client.query(
      `INSERT INTO outbox_events(
         event_id, payment_id, refund_id, aggregate_version, event_type, payload_digest, payload
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [eventId, paymentId, refundId, version, eventType, payloadDigest, payload]
    );
    return { eventId, payloadDigest };
  }

  async applyCapture(client, payment, attempt, externalResult, receiptDigest) {
    if (!['capture_prepared', 'capture_unknown', 'reconciliation_required'].includes(payment.state)) {
      fail('invariant_violation', 'payment state cannot accept capture result', 500);
    }
    const nextVersion = payment.version + 1;
    let journalTxId = null;
    let event = null;
    if (externalResult.decision === 'accepted') {
      journalTxId = await this.insertJournal(client, {
        kind: 'capture', paymentId: payment.payment_id, refundId: null, attemptId: attempt.attempt_id,
        amountMinor: attempt.amount_minor, currency: attempt.currency, receiptDigest
      });
      event = await this.insertOutbox(client, {
        kind: 'capture', paymentId: payment.payment_id, refundId: null, amountMinor: attempt.amount_minor,
        currency: attempt.currency, version: nextVersion
      });
      await client.query(
        `UPDATE payment_intents SET state = 'captured', captured_amount_minor = amount_minor,
           capture_journal_tx_id = $2, version = $3, updated_at = clock_timestamp() WHERE payment_id = $1`,
        [payment.payment_id, journalTxId, nextVersion]
      );
    } else {
      await client.query(
        `UPDATE payment_intents SET state = 'declined', version = $2, updated_at = clock_timestamp()
         WHERE payment_id = $1`, [payment.payment_id, nextVersion]
      );
    }
    const output = publicOutcome({
      attemptId: attempt.attempt_id, paymentId: payment.payment_id, refundId: null, kind: 'capture',
      state: externalResult.decision, processorKey: attempt.processor_key, externalReceiptDigest: receiptDigest,
      externalAccepted: externalResult.decision === 'accepted', journalPosted: Boolean(journalTxId), journalTxId,
      outboxEventId: event?.eventId ?? null, notificationAcknowledged: false
    });
    await client.query(
      `UPDATE processor_attempts SET state = $2, external_receipt_digest = $3, external_result = $4,
         journal_tx_id = $5, final_result = $6, updated_at = clock_timestamp() WHERE attempt_id = $1`,
      [attempt.attempt_id, externalResult.decision, receiptDigest, externalResult, journalTxId, output]
    );
    return output;
  }

  async paymentStateAfterRefund(client, paymentId, capturedAmount) {
    const { rows } = await client.query(
      `SELECT
         COALESCE(sum(amount_minor) FILTER (WHERE state = 'accepted'), 0)::text AS accepted,
         count(*) FILTER (WHERE state IN ('prepared', 'unknown', 'reconciliation_required'))::integer AS pending
       FROM refunds WHERE payment_id = $1`, [paymentId]
    );
    const accepted = BigInt(rows[0].accepted);
    if (rows[0].pending > 0) return 'refund_pending';
    if (accepted === 0n) return 'captured';
    if (accepted === BigInt(capturedAmount)) return 'refunded';
    return 'partially_refunded';
  }

  async applyRefund(client, payment, refund, attempt, externalResult, receiptDigest) {
    if (!refund || !['prepared', 'unknown', 'reconciliation_required'].includes(refund.state)) {
      fail('invariant_violation', 'refund state cannot accept processor result', 500);
    }
    const nextVersion = payment.version + 1;
    let journalTxId = null;
    let event = null;
    if (externalResult.decision === 'accepted') {
      journalTxId = await this.insertJournal(client, {
        kind: 'refund', paymentId: payment.payment_id, refundId: refund.refund_id, attemptId: attempt.attempt_id,
        amountMinor: attempt.amount_minor, currency: attempt.currency, receiptDigest
      });
      event = await this.insertOutbox(client, {
        kind: 'refund', paymentId: payment.payment_id, refundId: refund.refund_id, amountMinor: attempt.amount_minor,
        currency: attempt.currency, version: nextVersion
      });
      await client.query(
        `UPDATE refunds SET state = 'accepted', journal_tx_id = $2, updated_at = clock_timestamp()
         WHERE refund_id = $1`, [refund.refund_id, journalTxId]
      );
    } else {
      await client.query(
        `UPDATE refunds SET state = 'declined', updated_at = clock_timestamp() WHERE refund_id = $1`, [refund.refund_id]
      );
    }
    const nextState = await this.paymentStateAfterRefund(client, payment.payment_id, payment.captured_amount_minor);
    await client.query(
      `UPDATE payment_intents SET state = $2, version = $3, updated_at = clock_timestamp() WHERE payment_id = $1`,
      [payment.payment_id, nextState, nextVersion]
    );
    const output = publicOutcome({
      attemptId: attempt.attempt_id, paymentId: payment.payment_id, refundId: refund.refund_id, kind: 'refund',
      state: externalResult.decision, amountMinor: attempt.amount_minor, currency: attempt.currency,
      processorKey: attempt.processor_key, externalReceiptDigest: receiptDigest,
      externalAccepted: externalResult.decision === 'accepted', journalPosted: Boolean(journalTxId), journalTxId,
      outboxEventId: event?.eventId ?? null, notificationAcknowledged: false
    });
    await client.query(
      `UPDATE processor_attempts SET state = $2, external_receipt_digest = $3, external_result = $4,
         journal_tx_id = $5, final_result = $6, updated_at = clock_timestamp() WHERE attempt_id = $1`,
      [attempt.attempt_id, externalResult.decision, receiptDigest, externalResult, journalTxId, output]
    );
    return output;
  }

  async acknowledgeDelivery(input, { afterCommit: hook } = {}) {
    const intentDigest = digest({ operation: 'acknowledge_delivery', ...input });
    const result = await this.tx(async (client) => {
      const replay = await this.readReceipt(client, 'acknowledge_delivery', input.requestKey, intentDigest);
      if (replay) return replay;
      await this.lockWorker(client, 'delivery', input.expectedWorkerGeneration);
      const eventQuery = await client.query(
        'SELECT * FROM outbox_events WHERE event_id = $1 FOR UPDATE', [input.eventId]
      );
      if (eventQuery.rows.length === 0) fail('not_found', 'outbox event is not retained', 404);
      const event = eventQuery.rows[0];
      if (event.payload_digest !== input.payloadDigest) {
        fail('intent_conflict', 'delivery payload does not match immutable event', 409);
      }
      const existing = await client.query(
        'SELECT * FROM deliveries WHERE delivery_id = $1 OR request_key = $2 FOR UPDATE',
        [input.deliveryId, input.requestKey]
      );
      let output;
      if (existing.rows.length > 0) {
        if (existing.rows.length !== 1) {
          fail('intent_conflict', 'delivery identities refer to different records', 409);
        }
        const row = existing.rows[0];
        if (row.delivery_id !== input.deliveryId || row.intent_digest !== intentDigest) {
          fail('intent_conflict', 'delivery identity is bound to changed intent', 409);
        }
        output = row.result;
      } else {
        output = publicOutcome({
          deliveryId: input.deliveryId, eventId: input.eventId, state: 'acknowledged',
          externalAccepted: false, journalPosted: false, notificationAcknowledged: true
        });
        await client.query(
          `INSERT INTO deliveries(
             delivery_id, event_id, request_key, intent_digest, payload_digest, destination_class,
             state, worker_generation, result
           ) VALUES ($1, $2, $3, $4, $5, $6, 'acknowledged', $7, $8)`,
          [input.deliveryId, input.eventId, input.requestKey, intentDigest, input.payloadDigest,
            input.destinationClass, input.expectedWorkerGeneration, output]
        );
      }
      return this.insertReceipt(client, 'acknowledge_delivery', input.requestKey, intentDigest, output);
    });
    return afterCommit(hook, result);
  }

  async advanceWorker(kind, expectedGeneration) {
    return this.tx(async (client) => {
      await this.lockWorker(client, kind, expectedGeneration);
      const { rows } = await client.query(
        `UPDATE worker_assignments SET generation = generation + 1, updated_at = clock_timestamp()
         WHERE kind = $1 RETURNING kind, generation`, [kind]
      );
      return rows[0];
    });
  }

  async getWorkerGeneration(kind) {
    const { rows } = await this.pool.query('SELECT generation FROM worker_assignments WHERE kind = $1', [kind]);
    if (rows.length === 0) fail('not_found', 'worker assignment is not retained', 404);
    return rows[0].generation;
  }

  async getPaymentEvidence(paymentId) {
    const payment = await this.pool.query('SELECT * FROM payment_intents WHERE payment_id = $1', [paymentId]);
    if (payment.rows.length === 0) fail('not_found', 'payment is not retained', 404);
    const [attempts, refunds, journals, lines, events, deliveries] = await Promise.all([
      this.pool.query(
        `SELECT attempt_id, kind, refund_id, processor_key, request_digest, amount_minor::text, currency, state,
           worker_generation, external_receipt_digest, journal_tx_id
         FROM processor_attempts WHERE payment_id = $1 ORDER BY created_at, attempt_id`, [paymentId]
      ),
      this.pool.query(
        `SELECT refund_id, amount_minor::text, currency, reason_class, state, attempt_id, journal_tx_id
         FROM refunds WHERE payment_id = $1 ORDER BY created_at, refund_id`, [paymentId]
      ),
      this.pool.query(
        `SELECT journal_tx_id, kind, refund_id, attempt_id, currency, external_receipt_digest
         FROM journal_transactions WHERE payment_id = $1 ORDER BY created_at, journal_tx_id`, [paymentId]
      ),
      this.pool.query(
        `SELECT l.journal_tx_id, l.line_no, l.account_code, l.side, l.amount_minor::text
         FROM journal_lines l JOIN journal_transactions j USING (journal_tx_id)
         WHERE j.payment_id = $1 ORDER BY l.journal_tx_id, l.line_no`, [paymentId]
      ),
      this.pool.query(
        `SELECT event_id, refund_id, aggregate_version, event_type, payload_digest
         FROM outbox_events WHERE payment_id = $1 ORDER BY aggregate_version, event_id`, [paymentId]
      ),
      this.pool.query(
        `SELECT d.delivery_id, d.event_id, d.state, d.payload_digest
         FROM deliveries d JOIN outbox_events e USING (event_id)
         WHERE e.payment_id = $1 ORDER BY d.acknowledged_at, d.delivery_id`, [paymentId]
      )
    ]);
    const p = payment.rows[0];
    const acceptedRefund = refunds.rows.filter((row) => row.state === 'accepted')
      .reduce((sum, row) => sum + BigInt(row.amount_minor), 0n);
    const reservedRefund = refunds.rows.filter((row) => ['prepared', 'unknown', 'reconciliation_required'].includes(row.state))
      .reduce((sum, row) => sum + BigInt(row.amount_minor), 0n);
    return publicOutcome({
      payment: paymentResult(p), attempts: attempts.rows, refunds: refunds.rows, journalTransactions: journals.rows,
      journalLines: lines.rows, outboxEvents: events.rows, deliveries: deliveries.rows,
      acceptedRefundMinor: acceptedRefund.toString(), reservedRefundMinor: reservedRefund.toString(),
      externalAccepted: Boolean(p.capture_journal_tx_id), journalPosted: Boolean(p.capture_journal_tx_id),
      notificationAcknowledged: deliveries.rows.length > 0
    });
  }

  async getState() {
    const { rows } = await this.pool.query(`
      SELECT
        (SELECT count(*)::integer FROM payment_intents) AS payments,
        (SELECT count(*)::integer FROM processor_attempts) AS attempts,
        (SELECT count(*)::integer FROM processor_attempts WHERE state IN ('prepared', 'unknown', 'reconciliation_required')) AS unresolved_attempts,
        (SELECT count(*)::integer FROM refunds) AS refunds,
        (SELECT count(*)::integer FROM journal_transactions) AS journal_transactions,
        (SELECT count(*)::integer FROM journal_lines) AS journal_lines,
        (SELECT count(*)::integer FROM outbox_events) AS outbox_events,
        (SELECT count(*)::integer FROM deliveries) AS deliveries,
        (SELECT count(*)::integer FROM (
          SELECT j.journal_tx_id
          FROM journal_transactions j LEFT JOIN journal_lines l USING (journal_tx_id)
          GROUP BY j.journal_tx_id, j.expected_line_count
          HAVING count(l.*) <> j.expected_line_count
             OR COALESCE(sum(CASE l.side WHEN 'debit' THEN l.amount_minor ELSE -l.amount_minor END), 0) <> 0
        ) bad) AS unbalanced_transactions,
        (SELECT count(*)::integer FROM payment_intents p WHERE
          (SELECT COALESCE(sum(r.amount_minor), 0) FROM refunds r
           WHERE r.payment_id = p.payment_id AND r.state IN ('prepared', 'unknown', 'accepted', 'reconciliation_required'))
          > p.captured_amount_minor) AS over_refunded_payments
    `);
    const workers = await this.pool.query('SELECT kind, generation FROM worker_assignments ORDER BY kind');
    return {
      ...rows[0], workers: Object.fromEntries(workers.rows.map((row) => [row.kind, row.generation])),
      realMoneyMoved: false, providerCompatible: false, compliant: false, settled: false,
      merchantNotified: false, fulfilled: false, externalAcceptance: false
    };
  }
}

export function isRetryableDatabaseError(error) {
  return error instanceof DomainError === false && ['40001', '40P01'].includes(error?.code);
}
