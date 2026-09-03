-- 001_core_identity_and_property.sql
-- Identity, access control and the physical property hierarchy.
--
-- Money is stored everywhere as INTEGER PAISE (1 rupee = 100 paise). Storing
-- currency as an integer keeps every financial figure exact; floating point
-- rupees would drift after a few thousand bills.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------------
CREATE TYPE user_role AS ENUM ('admin', 'manager', 'staff');
CREATE TYPE record_status AS ENUM ('active', 'inactive', 'archived');

-- ---------------------------------------------------------------------------
-- Users, roles and permissions
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          TEXT        NOT NULL,
  phone          TEXT,
  full_name      TEXT        NOT NULL,
  password_hash  TEXT        NOT NULL,
  role           user_role   NOT NULL DEFAULT 'staff',
  is_active      BOOLEAN     NOT NULL DEFAULT TRUE,
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

-- Branch scoping. An admin with no rows here sees every branch; managers and
-- staff are limited to the branches listed for them.
CREATE TABLE user_branches (
  user_id    UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  branch_id  UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, branch_id)
);

-- Per-user grants/revocations layered on top of the role's default permission
-- set. `granted = false` subtracts a permission the role would otherwise have.
CREATE TABLE user_permissions (
  user_id    UUID    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  permission TEXT    NOT NULL,
  granted    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, permission)
);

-- ---------------------------------------------------------------------------
-- Branch -> Floor -> Room -> Bed
-- ---------------------------------------------------------------------------
CREATE TABLE branches (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code           TEXT          NOT NULL,
  name           TEXT          NOT NULL,
  address_line1  TEXT,
  address_line2  TEXT,
  city           TEXT,
  state          TEXT,
  pincode        TEXT,
  contact_name   TEXT,
  contact_phone  TEXT,
  contact_email  TEXT,
  status         record_status NOT NULL DEFAULT 'active',
  notes          TEXT,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX branches_code_key ON branches (lower(code));

ALTER TABLE user_branches
  ADD CONSTRAINT user_branches_branch_id_fkey
  FOREIGN KEY (branch_id) REFERENCES branches (id) ON DELETE CASCADE;

-- Floors are free-form areas: "Ground Floor", "First Floor", "Terrace", ...
-- Nothing about the count or naming is fixed in code.
CREATE TABLE floors (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id  UUID          NOT NULL REFERENCES branches (id) ON DELETE RESTRICT,
  code       TEXT          NOT NULL,
  name       TEXT          NOT NULL,
  sort_order INTEGER       NOT NULL DEFAULT 0,
  status     record_status NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX floors_branch_code_key ON floors (branch_id, lower(code));
CREATE INDEX floors_branch_idx ON floors (branch_id, sort_order);

-- Electricity meters. A meter may cover a whole branch, one floor, or a single
-- room; rooms point at the meter that bills them.
CREATE TABLE eb_meters (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id    UUID          NOT NULL REFERENCES branches (id) ON DELETE RESTRICT,
  floor_id     UUID          REFERENCES floors (id) ON DELETE SET NULL,
  code         TEXT          NOT NULL,
  label        TEXT          NOT NULL,
  scope        TEXT          NOT NULL DEFAULT 'floor'
                 CHECK (scope IN ('branch', 'floor', 'room')),
  status       record_status NOT NULL DEFAULT 'active',
  notes        TEXT,
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX eb_meters_branch_code_key ON eb_meters (branch_id, lower(code));

CREATE TABLE rooms (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id        UUID          NOT NULL REFERENCES branches (id) ON DELETE RESTRICT,
  floor_id         UUID          NOT NULL REFERENCES floors (id) ON DELETE RESTRICT,
  meter_id         UUID          REFERENCES eb_meters (id) ON DELETE SET NULL,
  code             TEXT          NOT NULL,
  name             TEXT,
  -- Sharing capacity is a plain integer, so 1-, 2-, 6- or any future N-sharing
  -- room works without a code change.
  sharing_capacity INTEGER       NOT NULL CHECK (sharing_capacity > 0),
  status           record_status NOT NULL DEFAULT 'active',
  notes            TEXT,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX rooms_branch_code_key ON rooms (branch_id, lower(code));
CREATE INDEX rooms_floor_idx ON rooms (floor_id);
CREATE INDEX rooms_meter_idx ON rooms (meter_id);

CREATE TABLE beds (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id    UUID          NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  label      TEXT          NOT NULL,
  sort_order INTEGER       NOT NULL DEFAULT 0,
  status     record_status NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX beds_room_label_key ON beds (room_id, lower(label));
CREATE INDEX beds_room_idx ON beds (room_id, sort_order);
