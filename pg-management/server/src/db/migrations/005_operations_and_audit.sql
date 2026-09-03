-- 005_operations_and_audit.sql
-- Messaging, automation, maintenance, expenses and the audit trail.

CREATE TYPE message_status  AS ENUM ('queued', 'sent', 'delivered', 'read', 'failed', 'cancelled');
CREATE TYPE job_run_status  AS ENUM ('running', 'success', 'failed', 'partial');
CREATE TYPE issue_priority  AS ENUM ('low', 'medium', 'high', 'urgent');
CREATE TYPE issue_status    AS ENUM ('open', 'in_progress', 'resolved', 'closed');
CREATE TYPE expense_category AS ENUM (
  'electricity', 'salary', 'repairs', 'maintenance', 'supplies', 'rent', 'internet', 'water', 'other'
);

-- ---------------------------------------------------------------------------
-- Messaging
-- ---------------------------------------------------------------------------
CREATE TABLE message_templates (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code       TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  channel    TEXT    NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp', 'sms', 'email')),
  body       TEXT    NOT NULL,
  variables  JSONB   NOT NULL DEFAULT '[]'::jsonb,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX message_templates_code_key ON message_templates (lower(code));

-- Outbound message log. `provider` records which adapter handled the send, so
-- switching from the local stub to a live WhatsApp provider leaves history
-- intact and attributable.
CREATE TABLE whatsapp_messages (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID           REFERENCES tenants (id) ON DELETE SET NULL,
  bill_id             UUID           REFERENCES bills (id) ON DELETE SET NULL,
  branch_id           UUID           REFERENCES branches (id) ON DELETE SET NULL,
  template_code       TEXT,
  phone               TEXT           NOT NULL,
  body                TEXT           NOT NULL,
  media_storage_key   TEXT,
  provider            TEXT           NOT NULL DEFAULT 'stub',
  provider_message_id TEXT,
  status              message_status NOT NULL DEFAULT 'queued',
  error               TEXT,
  attempts            INTEGER        NOT NULL DEFAULT 0,
  scheduled_for       TIMESTAMPTZ,
  sent_at             TIMESTAMPTZ,
  delivered_at        TIMESTAMPTZ,
  created_by          UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ    NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ    NOT NULL DEFAULT now()
);
CREATE INDEX whatsapp_messages_tenant_idx ON whatsapp_messages (tenant_id, created_at DESC);
CREATE INDEX whatsapp_messages_bill_idx ON whatsapp_messages (bill_id);
CREATE INDEX whatsapp_messages_status_idx ON whatsapp_messages (status);

-- Reminder ladder: which template fires on which day of the month. Reminders
-- stop on their own once a bill is fully paid.
CREATE TABLE reminder_rules (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id     UUID    REFERENCES branches (id) ON DELETE CASCADE,
  day_of_month  INTEGER NOT NULL CHECK (day_of_month BETWEEN 1 AND 28),
  template_code TEXT    NOT NULL,
  label         TEXT    NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX reminder_rules_scope_day_key
  ON reminder_rules (coalesce(branch_id::text, 'default'), day_of_month);

-- ---------------------------------------------------------------------------
-- Automation
-- ---------------------------------------------------------------------------
CREATE TABLE automation_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code          TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  description   TEXT,
  schedule_cron TEXT,
  is_enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  config        JSONB   NOT NULL DEFAULT '{}'::jsonb,
  last_run_at   TIMESTAMPTZ,
  next_run_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX automation_jobs_code_key ON automation_jobs (lower(code));

CREATE TABLE automation_runs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      UUID           NOT NULL REFERENCES automation_jobs (id) ON DELETE CASCADE,
  status      job_run_status NOT NULL DEFAULT 'running',
  attempt     INTEGER        NOT NULL DEFAULT 1,
  started_at  TIMESTAMPTZ    NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  result      JSONB,
  error       TEXT,
  triggered_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ    NOT NULL DEFAULT now()
);
CREATE INDEX automation_runs_job_idx ON automation_runs (job_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- Maintenance and expenses
-- ---------------------------------------------------------------------------
CREATE TABLE maintenance_issues (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id     UUID           NOT NULL REFERENCES branches (id) ON DELETE RESTRICT,
  floor_id      UUID           REFERENCES floors (id) ON DELETE SET NULL,
  room_id       UUID           REFERENCES rooms (id) ON DELETE SET NULL,
  title         TEXT           NOT NULL,
  description   TEXT,
  priority      issue_priority NOT NULL DEFAULT 'medium',
  status        issue_status   NOT NULL DEFAULT 'open',
  assigned_to   UUID REFERENCES users (id) ON DELETE SET NULL,
  reported_by   UUID REFERENCES users (id) ON DELETE SET NULL,
  reported_date DATE           NOT NULL DEFAULT CURRENT_DATE,
  resolved_date DATE,
  cost_paise    BIGINT         NOT NULL DEFAULT 0 CHECK (cost_paise >= 0),
  created_at    TIMESTAMPTZ    NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ    NOT NULL DEFAULT now()
);
CREATE INDEX maintenance_issues_branch_idx ON maintenance_issues (branch_id, status);
CREATE INDEX maintenance_issues_open_idx ON maintenance_issues (status)
  WHERE status IN ('open', 'in_progress');

CREATE TABLE expenses (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id    UUID             NOT NULL REFERENCES branches (id) ON DELETE RESTRICT,
  category     expense_category NOT NULL,
  amount_paise BIGINT           NOT NULL CHECK (amount_paise > 0),
  expense_date DATE             NOT NULL,
  vendor       TEXT,
  notes        TEXT,
  storage_key  TEXT,
  created_by   UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ      NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ      NOT NULL DEFAULT now()
);
CREATE INDEX expenses_branch_date_idx ON expenses (branch_id, expense_date DESC);
CREATE INDEX expenses_category_idx ON expenses (category);

-- ---------------------------------------------------------------------------
-- Audit trail
-- ---------------------------------------------------------------------------
-- Written inside the same transaction as the change it describes, so a
-- committed change always has its audit row and a rolled-back one leaves none.
CREATE TABLE audit_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        REFERENCES users (id) ON DELETE SET NULL,
  action      TEXT        NOT NULL,
  entity_type TEXT        NOT NULL,
  entity_id   TEXT,
  branch_id   UUID        REFERENCES branches (id) ON DELETE SET NULL,
  before      JSONB,
  after       JSONB,
  meta        JSONB,
  ip_address  TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id, created_at DESC);
CREATE INDEX audit_logs_user_idx ON audit_logs (user_id, created_at DESC);
CREATE INDEX audit_logs_action_idx ON audit_logs (action, created_at DESC);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);

-- ---------------------------------------------------------------------------
-- Application settings
-- ---------------------------------------------------------------------------
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       JSONB       NOT NULL,
  description TEXT,
  updated_by  UUID REFERENCES users (id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
