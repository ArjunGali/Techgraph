-- 004_billing_and_payments.sql
-- Billing periods, bills and the payment ledger.
--
-- Financial rows are never deleted or silently rewritten. A mistake is
-- corrected by a reversal or adjustment entry, so the ledger always adds up to
-- the balance shown and every historical bill stays reproducible.

CREATE TYPE billing_period_status AS ENUM ('draft', 'calculated', 'reviewed', 'closed');
CREATE TYPE bill_status           AS ENUM ('draft', 'calculated', 'reviewed', 'closed', 'void');
CREATE TYPE bill_payment_status   AS ENUM (
  'not_paid', 'proof_submitted', 'pending_approval', 'partially_paid', 'paid', 'rejected'
);
CREATE TYPE bill_item_type AS ENUM (
  'rent', 'eb', 'common_charge', 'other', 'discount', 'adjustment', 'previous_dues'
);
CREATE TYPE payment_kind AS ENUM (
  'payment', 'deposit', 'advance', 'refund', 'discount', 'adjustment', 'reversal'
);
CREATE TYPE payment_state AS ENUM ('pending_approval', 'approved', 'rejected', 'reversed');
CREATE TYPE payment_method AS ENUM ('upi', 'cash', 'bank_transfer', 'card', 'cheque', 'other');

-- ---------------------------------------------------------------------------
-- Billing periods
-- ---------------------------------------------------------------------------
CREATE TABLE billing_periods (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id      UUID                 NOT NULL REFERENCES branches (id) ON DELETE RESTRICT,
  period_month   DATE                 NOT NULL,
  status         billing_period_status NOT NULL DEFAULT 'draft',
  calculated_at  TIMESTAMPTZ,
  reviewed_at    TIMESTAMPTZ,
  closed_at      TIMESTAMPTZ,
  closed_by      UUID REFERENCES users (id) ON DELETE SET NULL,
  reopen_count   INTEGER              NOT NULL DEFAULT 0,
  notes          TEXT,
  created_by     UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ          NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ          NOT NULL DEFAULT now(),
  CONSTRAINT billing_periods_period_is_month_start CHECK (EXTRACT(DAY FROM period_month) = 1)
);
CREATE UNIQUE INDEX billing_periods_branch_month_key ON billing_periods (branch_id, period_month);
CREATE INDEX billing_periods_status_idx ON billing_periods (status);

-- ---------------------------------------------------------------------------
-- EB apportionment, computed once per meter per period
-- ---------------------------------------------------------------------------
-- The full breakdown is kept as JSON so the exact figures shown to the owner
-- and messaged to tenants can be reproduced verbatim, even years later.
CREATE TABLE eb_calculations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_period_id   UUID           NOT NULL REFERENCES billing_periods (id) ON DELETE CASCADE,
  meter_id            UUID           NOT NULL REFERENCES eb_meters (id) ON DELETE RESTRICT,
  reading_id          UUID           NOT NULL REFERENCES eb_readings (id) ON DELETE RESTRICT,
  engine_version      TEXT           NOT NULL,
  total_units         NUMERIC(12, 2) NOT NULL,
  eb_rate_paise       BIGINT         NOT NULL,
  total_eb_paise      BIGINT         NOT NULL,
  total_occupancy_days INTEGER       NOT NULL,
  breakdown           JSONB          NOT NULL,
  created_at          TIMESTAMPTZ    NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX eb_calculations_period_meter_key
  ON eb_calculations (billing_period_id, meter_id);

-- ---------------------------------------------------------------------------
-- Bills
-- ---------------------------------------------------------------------------
CREATE TABLE bills (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_period_id   UUID                NOT NULL REFERENCES billing_periods (id) ON DELETE CASCADE,
  tenant_id           UUID                NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  bill_number         TEXT                NOT NULL,
  status              bill_status         NOT NULL DEFAULT 'draft',
  payment_status      bill_payment_status NOT NULL DEFAULT 'not_paid',
  rent_paise          BIGINT              NOT NULL DEFAULT 0,
  eb_paise            BIGINT              NOT NULL DEFAULT 0,
  common_charge_paise BIGINT              NOT NULL DEFAULT 0,
  other_charges_paise BIGINT              NOT NULL DEFAULT 0,
  discount_paise      BIGINT              NOT NULL DEFAULT 0,
  adjustment_paise    BIGINT              NOT NULL DEFAULT 0,
  previous_dues_paise BIGINT              NOT NULL DEFAULT 0,
  total_paise         BIGINT              NOT NULL DEFAULT 0,
  paid_paise          BIGINT              NOT NULL DEFAULT 0,
  outstanding_paise   BIGINT              NOT NULL DEFAULT 0,
  due_date            DATE,
  engine_version      TEXT,
  generated_at        TIMESTAMPTZ,
  closed_at           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ         NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ         NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX bills_number_key ON bills (lower(bill_number));
CREATE UNIQUE INDEX bills_period_tenant_key ON bills (billing_period_id, tenant_id);
CREATE INDEX bills_tenant_idx ON bills (tenant_id, created_at DESC);
CREATE INDEX bills_payment_status_idx ON bills (payment_status);

CREATE TABLE bill_items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id      UUID           NOT NULL REFERENCES bills (id) ON DELETE CASCADE,
  item_type    bill_item_type NOT NULL,
  description  TEXT           NOT NULL,
  amount_paise BIGINT         NOT NULL,
  sort_order   INTEGER        NOT NULL DEFAULT 0,
  meta         JSONB          NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ    NOT NULL DEFAULT now()
);
CREATE INDEX bill_items_bill_idx ON bill_items (bill_id, sort_order);

-- The complete human-readable working for one bill: every stay segment, every
-- occupancy day, the EB per-day figure and how each rupee was arrived at.
CREATE TABLE bill_calculations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id        UUID        NOT NULL REFERENCES bills (id) ON DELETE CASCADE,
  engine_version TEXT        NOT NULL,
  breakdown      JSONB       NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX bill_calculations_bill_key ON bill_calculations (bill_id);

-- ---------------------------------------------------------------------------
-- Payment ledger
-- ---------------------------------------------------------------------------
-- direction is +1 for anything that reduces what the tenant owes (a payment, a
-- discount) and -1 for anything that increases it (a refund paid back out, a
-- reversal of an approved payment). Balances are a sum over this table, never a
-- mutable counter.
CREATE TABLE payments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID          NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  bill_id           UUID          REFERENCES bills (id) ON DELETE SET NULL,
  branch_id         UUID          NOT NULL REFERENCES branches (id) ON DELETE RESTRICT,
  kind              payment_kind  NOT NULL DEFAULT 'payment',
  amount_paise      BIGINT        NOT NULL CHECK (amount_paise > 0),
  direction         SMALLINT      NOT NULL DEFAULT 1 CHECK (direction IN (-1, 1)),
  method            payment_method NOT NULL DEFAULT 'upi',
  reference         TEXT,
  paid_at           TIMESTAMPTZ,
  state             payment_state NOT NULL DEFAULT 'pending_approval',
  approved_amount_paise BIGINT    CHECK (approved_amount_paise IS NULL OR approved_amount_paise >= 0),
  reversal_of_id    UUID          REFERENCES payments (id) ON DELETE RESTRICT,
  idempotency_key   TEXT,
  notes             TEXT,
  submitted_by      UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX payments_tenant_idx ON payments (tenant_id, created_at DESC);
CREATE INDEX payments_bill_idx ON payments (bill_id);
CREATE INDEX payments_state_idx ON payments (state) WHERE state = 'pending_approval';
-- Guards the approval endpoint against a double submit creating two payments.
CREATE UNIQUE INDEX payments_idempotency_key
  ON payments (idempotency_key) WHERE idempotency_key IS NOT NULL;
-- A transaction reference may only be banked once per tenant.
CREATE UNIQUE INDEX payments_reference_key
  ON payments (tenant_id, lower(reference))
  WHERE reference IS NOT NULL AND state <> 'rejected';

CREATE TABLE payment_proofs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id          UUID        NOT NULL REFERENCES payments (id) ON DELETE CASCADE,
  storage_key         TEXT        NOT NULL,
  original_name       TEXT        NOT NULL,
  mime_type           TEXT        NOT NULL,
  size_bytes          BIGINT      NOT NULL,
  ocr_status          TEXT        NOT NULL DEFAULT 'pending'
                        CHECK (ocr_status IN ('pending', 'extracted', 'failed', 'skipped')),
  ocr_amount_paise    BIGINT,
  ocr_reference       TEXT,
  ocr_paid_at         TIMESTAMPTZ,
  ocr_provider        TEXT,
  ocr_raw             JSONB,
  uploaded_by         UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payment_proofs_payment_idx ON payment_proofs (payment_id);

-- Every admin decision on a payment, kept as an append-only trail.
CREATE TABLE payment_approvals (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id            UUID        NOT NULL REFERENCES payments (id) ON DELETE CASCADE,
  action                TEXT        NOT NULL
                          CHECK (action IN ('approve', 'approve_partial', 'reject', 'reverse')),
  approved_amount_paise BIGINT,
  reason                TEXT,
  reviewer_id           UUID        REFERENCES users (id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payment_approvals_payment_idx ON payment_approvals (payment_id, created_at);

CREATE TABLE payment_qr_configs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id          UUID    REFERENCES branches (id) ON DELETE CASCADE,
  display_name       TEXT    NOT NULL,
  payment_identifier TEXT    NOT NULL,
  storage_key        TEXT,
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  notes              TEXT,
  created_by         UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- At most one active QR per branch, and one active business-wide default.
CREATE UNIQUE INDEX payment_qr_active_branch_key
  ON payment_qr_configs (coalesce(branch_id::text, 'default')) WHERE is_active;
