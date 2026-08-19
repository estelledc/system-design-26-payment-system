CREATE TABLE IF NOT EXISTS worker_assignments (
  kind text PRIMARY KEY CHECK (kind IN ('capture', 'refund', 'reconcile', 'delivery')),
  generation integer NOT NULL CHECK (generation > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO worker_assignments(kind, generation)
VALUES ('capture', 1), ('refund', 1), ('reconcile', 1), ('delivery', 1)
ON CONFLICT (kind) DO NOTHING;

CREATE TABLE IF NOT EXISTS operation_receipts (
  operation text NOT NULL,
  request_key text NOT NULL,
  intent_digest character(64) NOT NULL CHECK (intent_digest ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (operation, request_key)
);

CREATE TABLE IF NOT EXISTS payment_intents (
  payment_id text PRIMARY KEY,
  merchant_id text NOT NULL,
  order_id text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 1000000),
  currency text NOT NULL CHECK (currency = 'LAB'),
  intent_digest character(64) NOT NULL CHECK (intent_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN (
    'created', 'capture_prepared', 'capture_unknown', 'captured', 'declined',
    'refund_pending', 'partially_refunded', 'refunded', 'reconciliation_required'
  )),
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  captured_amount_minor bigint NOT NULL DEFAULT 0 CHECK (captured_amount_minor >= 0),
  capture_attempt_id text UNIQUE,
  capture_journal_tx_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (merchant_id, order_id)
);

CREATE TABLE IF NOT EXISTS refunds (
  refund_id text PRIMARY KEY,
  payment_id text NOT NULL REFERENCES payment_intents(payment_id),
  request_key text NOT NULL UNIQUE,
  intent_digest character(64) NOT NULL CHECK (intent_digest ~ '^[a-f0-9]{64}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 1000000),
  currency text NOT NULL CHECK (currency = 'LAB'),
  reason_class text NOT NULL CHECK (reason_class IN ('requested_by_merchant', 'duplicate_order')),
  state text NOT NULL CHECK (state IN ('prepared', 'unknown', 'accepted', 'declined', 'reconciliation_required')),
  attempt_id text NOT NULL UNIQUE,
  journal_tx_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS processor_attempts (
  attempt_id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('capture', 'refund')),
  payment_id text NOT NULL REFERENCES payment_intents(payment_id),
  refund_id text REFERENCES refunds(refund_id),
  processor_key text NOT NULL UNIQUE,
  request_digest character(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 1000000),
  currency text NOT NULL CHECK (currency = 'LAB'),
  synthetic_decision text NOT NULL CHECK (synthetic_decision IN ('accepted', 'declined')),
  state text NOT NULL CHECK (state IN ('prepared', 'unknown', 'accepted', 'declined', 'reconciliation_required')),
  worker_generation integer NOT NULL CHECK (worker_generation > 0),
  external_receipt_digest character(64) CHECK (external_receipt_digest ~ '^[a-f0-9]{64}$'),
  external_result jsonb,
  journal_tx_id text UNIQUE,
  final_result jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((kind = 'capture' AND refund_id IS NULL) OR (kind = 'refund' AND refund_id IS NOT NULL)),
  CHECK ((state IN ('accepted', 'declined')) = (external_receipt_digest IS NOT NULL)),
  CHECK ((state IN ('accepted', 'declined')) = (external_result IS NOT NULL)),
  CHECK ((state IN ('accepted', 'declined')) = (final_result IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS one_capture_attempt_per_payment
ON processor_attempts(payment_id) WHERE kind = 'capture';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'refund_attempt_fk') THEN
    ALTER TABLE refunds
      ADD CONSTRAINT refund_attempt_fk FOREIGN KEY (attempt_id) REFERENCES processor_attempts(attempt_id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS journal_transactions (
  journal_tx_id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('capture', 'refund')),
  payment_id text NOT NULL REFERENCES payment_intents(payment_id),
  refund_id text REFERENCES refunds(refund_id),
  attempt_id text NOT NULL UNIQUE REFERENCES processor_attempts(attempt_id),
  currency text NOT NULL CHECK (currency = 'LAB'),
  external_receipt_digest character(64) NOT NULL UNIQUE CHECK (external_receipt_digest ~ '^[a-f0-9]{64}$'),
  expected_line_count smallint NOT NULL DEFAULT 2 CHECK (expected_line_count = 2),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((kind = 'capture' AND refund_id IS NULL) OR (kind = 'refund' AND refund_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS journal_lines (
  journal_tx_id text NOT NULL REFERENCES journal_transactions(journal_tx_id),
  line_no smallint NOT NULL CHECK (line_no IN (1, 2)),
  account_code text NOT NULL CHECK (account_code IN ('processor_receivable', 'merchant_payable')),
  side text NOT NULL CHECK (side IN ('debit', 'credit')),
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 1000000),
  PRIMARY KEY (journal_tx_id, line_no),
  UNIQUE (journal_tx_id, side),
  UNIQUE (journal_tx_id, account_code)
);

CREATE OR REPLACE FUNCTION reject_journal_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'journal evidence is immutable' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS journal_transactions_immutable ON journal_transactions;
CREATE TRIGGER journal_transactions_immutable
BEFORE UPDATE OR DELETE ON journal_transactions
FOR EACH ROW EXECUTE FUNCTION reject_journal_mutation();

DROP TRIGGER IF EXISTS journal_lines_immutable ON journal_lines;
CREATE TRIGGER journal_lines_immutable
BEFORE UPDATE OR DELETE ON journal_lines
FOR EACH ROW EXECUTE FUNCTION reject_journal_mutation();

CREATE OR REPLACE FUNCTION assert_journal_transaction_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_id text;
  expected_count integer;
  actual_count integer;
  signed_total bigint;
BEGIN
  target_id := COALESCE(NEW.journal_tx_id, OLD.journal_tx_id);
  SELECT expected_line_count INTO expected_count
  FROM journal_transactions WHERE journal_tx_id = target_id;

  IF expected_count IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT count(*), COALESCE(sum(CASE side WHEN 'debit' THEN amount_minor ELSE -amount_minor END), 0)
    INTO actual_count, signed_total
  FROM journal_lines WHERE journal_tx_id = target_id;

  IF actual_count <> expected_count OR signed_total <> 0 THEN
    RAISE EXCEPTION 'journal transaction % is not balanced', target_id USING ERRCODE = '23514';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS journal_transaction_balance_from_header ON journal_transactions;
CREATE CONSTRAINT TRIGGER journal_transaction_balance_from_header
AFTER INSERT ON journal_transactions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_journal_transaction_balanced();

DROP TRIGGER IF EXISTS journal_transaction_balance_from_line ON journal_lines;
CREATE CONSTRAINT TRIGGER journal_transaction_balance_from_line
AFTER INSERT ON journal_lines
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_journal_transaction_balanced();

CREATE TABLE IF NOT EXISTS outbox_events (
  event_id text PRIMARY KEY,
  payment_id text NOT NULL REFERENCES payment_intents(payment_id),
  refund_id text REFERENCES refunds(refund_id),
  aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
  event_type text NOT NULL CHECK (event_type IN ('payment_captured', 'refund_accepted')),
  payload_digest character(64) NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (payment_id, aggregate_version, event_type)
);

CREATE TABLE IF NOT EXISTS deliveries (
  delivery_id text PRIMARY KEY,
  event_id text NOT NULL REFERENCES outbox_events(event_id),
  request_key text NOT NULL UNIQUE,
  intent_digest character(64) NOT NULL CHECK (intent_digest ~ '^[a-f0-9]{64}$'),
  payload_digest character(64) NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  destination_class text NOT NULL CHECK (destination_class = 'synthetic_merchant'),
  state text NOT NULL CHECK (state = 'acknowledged'),
  worker_generation integer NOT NULL CHECK (worker_generation > 0),
  result jsonb NOT NULL,
  acknowledged_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  run_id bigserial PRIMARY KEY,
  request_key text NOT NULL UNIQUE,
  intent_digest character(64) NOT NULL CHECK (intent_digest ~ '^[a-f0-9]{64}$'),
  worker_generation integer NOT NULL CHECK (worker_generation > 0),
  attempt_count integer NOT NULL CHECK (attempt_count BETWEEN 0 AND 64),
  applied_count integer NOT NULL CHECK (applied_count BETWEEN 0 AND attempt_count),
  unresolved_count integer NOT NULL CHECK (unresolved_count BETWEEN 0 AND attempt_count),
  conflict_count integer NOT NULL CHECK (conflict_count BETWEEN 0 AND attempt_count),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (applied_count + unresolved_count + conflict_count = attempt_count)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_capture_attempt_fk') THEN
    ALTER TABLE payment_intents
      ADD CONSTRAINT payment_capture_attempt_fk FOREIGN KEY (capture_attempt_id) REFERENCES processor_attempts(attempt_id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_capture_journal_fk') THEN
    ALTER TABLE payment_intents
      ADD CONSTRAINT payment_capture_journal_fk FOREIGN KEY (capture_journal_tx_id) REFERENCES journal_transactions(journal_tx_id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'refund_journal_fk') THEN
    ALTER TABLE refunds
      ADD CONSTRAINT refund_journal_fk FOREIGN KEY (journal_tx_id) REFERENCES journal_transactions(journal_tx_id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attempt_journal_fk') THEN
    ALTER TABLE processor_attempts
      ADD CONSTRAINT attempt_journal_fk FOREIGN KEY (journal_tx_id) REFERENCES journal_transactions(journal_tx_id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
