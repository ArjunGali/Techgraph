-- 003_pricing_and_electricity.sql
-- Effective-dated pricing and administered rates, plus electricity meter
-- readings. Nothing here is ever updated in place: a price change closes the
-- old row and opens a new one, so an old bill can always be recomputed with
-- the price that actually applied on its dates.

CREATE TYPE charge_type AS ENUM ('eb_rate', 'common_charge');
CREATE TYPE reading_status AS ENUM ('recorded', 'flagged', 'verified');

-- ---------------------------------------------------------------------------
-- Rent price rules
-- ---------------------------------------------------------------------------
-- A rule may target, from most to least specific:
--   1. one room                       (room_id set)
--   2. one sharing size in one branch (branch_id + sharing_capacity set)
--   3. one sharing size everywhere    (sharing_capacity set)
--   4. a branch default               (branch_id set)
-- The resolver picks the most specific rule in force on a given date.
CREATE TABLE price_rules (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id          UUID   REFERENCES branches (id) ON DELETE CASCADE,
  room_id            UUID   REFERENCES rooms (id) ON DELETE CASCADE,
  sharing_capacity   INTEGER CHECK (sharing_capacity IS NULL OR sharing_capacity > 0),
  monthly_rent_paise BIGINT NOT NULL CHECK (monthly_rent_paise >= 0),
  effective_from     DATE   NOT NULL,
  effective_to       DATE,
  note               TEXT,
  created_by         UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT price_rules_date_order
    CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT price_rules_scope_present
    CHECK (room_id IS NOT NULL OR branch_id IS NOT NULL OR sharing_capacity IS NOT NULL),
  -- Identity of the thing being priced, used to stop two rules for the same
  -- scope from being in force on the same day.
  scope_key TEXT GENERATED ALWAYS AS (
    coalesce(room_id::text, '-') || '|' ||
    coalesce(branch_id::text, '-') || '|' ||
    coalesce(sharing_capacity::text, '-')
  ) STORED
);

ALTER TABLE price_rules
  ADD CONSTRAINT price_rules_no_overlap
  EXCLUDE USING gist (
    scope_key WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  );

CREATE INDEX price_rules_lookup_idx
  ON price_rules (sharing_capacity, branch_id, effective_from DESC);
CREATE INDEX price_rules_room_idx ON price_rules (room_id, effective_from DESC);

ALTER TABLE tenant_stays
  ADD CONSTRAINT tenant_stays_price_rule_fkey
  FOREIGN KEY (price_rule_id) REFERENCES price_rules (id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Administered rates: EB per-unit rate and the flat common charge
-- ---------------------------------------------------------------------------
-- Admins change the VALUES here. The formula that consumes them lives in the
-- locked calculation engine and is not editable from the application.
CREATE TABLE charge_rates (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id      UUID        REFERENCES branches (id) ON DELETE CASCADE,
  charge         charge_type NOT NULL,
  value_paise    BIGINT      NOT NULL CHECK (value_paise >= 0),
  effective_from DATE        NOT NULL,
  effective_to   DATE,
  note           TEXT,
  created_by     UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT charge_rates_date_order
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

-- Two rates for the same charge and the same scope may not be in force on the
-- same day. Casting an enum to text is not immutable, so the enum column and
-- the branch are compared directly rather than through a generated key.
ALTER TABLE charge_rates
  ADD CONSTRAINT charge_rates_no_overlap
  EXCLUDE USING gist (
    coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
    charge WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  );

CREATE INDEX charge_rates_lookup_idx ON charge_rates (charge, branch_id, effective_from DESC);

-- ---------------------------------------------------------------------------
-- Meter readings
-- ---------------------------------------------------------------------------
-- units_consumed is a generated column so it can never disagree with the two
-- readings it is derived from.
CREATE TABLE eb_readings (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meter_id         UUID           NOT NULL REFERENCES eb_meters (id) ON DELETE RESTRICT,
  period_month     DATE           NOT NULL,
  reading_date     DATE           NOT NULL,
  previous_reading NUMERIC(12, 2) NOT NULL CHECK (previous_reading >= 0),
  current_reading  NUMERIC(12, 2) NOT NULL CHECK (current_reading >= 0),
  units_consumed   NUMERIC(12, 2) GENERATED ALWAYS AS (current_reading - previous_reading) STORED,
  eb_rate_paise    BIGINT         NOT NULL CHECK (eb_rate_paise >= 0),
  status           reading_status NOT NULL DEFAULT 'recorded',
  flag_reason      TEXT,
  notes            TEXT,
  entered_by       UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ    NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ    NOT NULL DEFAULT now()
);

-- One reading per meter per billing month. A correction edits the row in place
-- and is captured in the audit log rather than creating a duplicate.
CREATE UNIQUE INDEX eb_readings_meter_month_key ON eb_readings (meter_id, period_month);
CREATE INDEX eb_readings_month_idx ON eb_readings (period_month);
CREATE INDEX eb_readings_status_idx ON eb_readings (status) WHERE status = 'flagged';

-- The billing month must be the first of a month, so period arithmetic is
-- unambiguous everywhere downstream.
ALTER TABLE eb_readings
  ADD CONSTRAINT eb_readings_period_is_month_start
  CHECK (EXTRACT(DAY FROM period_month) = 1);
