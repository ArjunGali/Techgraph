-- 002_tenants_and_stay_history.sql
-- Tenants and the append-only stay history that every downstream calculation
-- (occupancy, vacancy, rent proration, EB apportionment) is derived from.

CREATE TYPE tenant_status AS ENUM ('prospect', 'active', 'notice', 'vacated', 'blacklisted');
CREATE TYPE stay_status  AS ENUM ('upcoming', 'active', 'ended', 'cancelled');
CREATE TYPE document_type AS ENUM ('aadhaar', 'office_id', 'pan', 'photo', 'agreement', 'other');

CREATE TABLE tenants (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_code              TEXT          NOT NULL,
  full_name                TEXT          NOT NULL,
  phone                    TEXT          NOT NULL,
  alt_phone                TEXT,
  email                    TEXT,
  gender                   TEXT CHECK (gender IN ('male', 'female', 'other')),
  date_of_birth            DATE,
  occupation               TEXT,
  company                  TEXT,
  permanent_address        TEXT,
  emergency_contact_name   TEXT,
  emergency_contact_phone  TEXT,
  joining_date             DATE          NOT NULL,
  exit_date                DATE,
  status                   tenant_status NOT NULL DEFAULT 'active',
  deposit_paise            BIGINT        NOT NULL DEFAULT 0 CHECK (deposit_paise >= 0),
  notes                    TEXT,
  created_by               UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tenants_code_key ON tenants (lower(tenant_code));
CREATE INDEX tenants_phone_idx ON tenants (phone);
CREATE INDEX tenants_status_idx ON tenants (status);
CREATE INDEX tenants_name_idx ON tenants (lower(full_name));

-- ---------------------------------------------------------------------------
-- Stay history
-- ---------------------------------------------------------------------------
-- One row per continuous occupancy of one bed/room by one tenant. A room move
-- NEVER edits an existing row: the old stay is closed with an end_date and a
-- new row is inserted. Rent and sharing capacity are snapshotted onto the row
-- so a historical bill stays reproducible even if the room is later
-- reconfigured or repriced.
--
-- end_date is INCLUSIVE — a stay of 1 Aug to 15 Aug covers 15 days.
CREATE TABLE tenant_stays (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  branch_id          UUID        NOT NULL REFERENCES branches (id) ON DELETE RESTRICT,
  floor_id           UUID        NOT NULL REFERENCES floors (id) ON DELETE RESTRICT,
  room_id            UUID        NOT NULL REFERENCES rooms (id) ON DELETE RESTRICT,
  bed_id             UUID        REFERENCES beds (id) ON DELETE RESTRICT,
  start_date         DATE        NOT NULL,
  end_date           DATE,
  sharing_capacity   INTEGER     NOT NULL CHECK (sharing_capacity > 0),
  monthly_rent_paise BIGINT      NOT NULL CHECK (monthly_rent_paise >= 0),
  price_rule_id      UUID,
  status             stay_status NOT NULL DEFAULT 'active',
  move_reason        TEXT,
  ended_reason       TEXT,
  previous_stay_id   UUID        REFERENCES tenant_stays (id) ON DELETE SET NULL,
  created_by         UUID        REFERENCES users (id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tenant_stays_date_order CHECK (end_date IS NULL OR end_date >= start_date)
);

CREATE INDEX tenant_stays_tenant_idx ON tenant_stays (tenant_id, start_date);
CREATE INDEX tenant_stays_room_idx   ON tenant_stays (room_id, start_date);
CREATE INDEX tenant_stays_branch_idx ON tenant_stays (branch_id, start_date);
CREATE INDEX tenant_stays_bed_idx    ON tenant_stays (bed_id) WHERE bed_id IS NOT NULL;
CREATE INDEX tenant_stays_open_idx   ON tenant_stays (room_id) WHERE end_date IS NULL;

-- A tenant cannot be in two places on the same day, and a bed cannot hold two
-- tenants on the same day. Enforced by the database rather than by application
-- code alone, so no code path can corrupt the history.
ALTER TABLE tenant_stays
  ADD CONSTRAINT tenant_stays_no_overlap_per_tenant
  EXCLUDE USING gist (
    tenant_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  ) WHERE (status <> 'cancelled');

ALTER TABLE tenant_stays
  ADD CONSTRAINT tenant_stays_no_overlap_per_bed
  EXCLUDE USING gist (
    bed_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  ) WHERE (bed_id IS NOT NULL AND status <> 'cancelled');

-- ---------------------------------------------------------------------------
-- Tenant documents (sensitive)
-- ---------------------------------------------------------------------------
-- Only a masked identifier is stored in the row; the raw file lives in
-- protected storage and is reachable solely through an authorised,
-- audit-logged download endpoint.
CREATE TABLE tenant_documents (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID          NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  doc_type           document_type NOT NULL,
  storage_key        TEXT          NOT NULL,
  original_name      TEXT          NOT NULL,
  mime_type          TEXT          NOT NULL,
  size_bytes         BIGINT        NOT NULL,
  masked_identifier  TEXT,
  is_verified        BOOLEAN       NOT NULL DEFAULT FALSE,
  verified_by        UUID REFERENCES users (id) ON DELETE SET NULL,
  verified_at        TIMESTAMPTZ,
  uploaded_by        UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX tenant_documents_tenant_idx ON tenant_documents (tenant_id, doc_type);
