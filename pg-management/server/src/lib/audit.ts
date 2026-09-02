import type { Db } from '../db/pool.js';

export type AuditEntry = {
  userId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  branchId?: string | null;
  before?: unknown;
  after?: unknown;
  meta?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
};

/**
 * Records an action in the audit trail.
 *
 * Always called with the same transaction as the change it describes, so the
 * log and the change commit or roll back together — a committed change can
 * never be missing its audit row, and a failed one never leaves a misleading
 * entry behind.
 */
export async function writeAudit(tx: Db, entry: AuditEntry): Promise<void> {
  await tx.query(
    `INSERT INTO audit_logs
       (user_id, action, entity_type, entity_id, branch_id, before, after, meta, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      entry.userId,
      entry.action,
      entry.entityType,
      entry.entityId ?? null,
      entry.branchId ?? null,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      entry.meta === undefined ? null : JSON.stringify(entry.meta),
      entry.ipAddress ?? null,
      entry.userAgent ?? null,
    ],
  );
}

/** Canonical action names, so the audit log stays queryable. */
export const AUDIT = {
  LOGIN: 'auth.login',
  LOGIN_FAILED: 'auth.login_failed',
  USER_CREATED: 'user.created',
  USER_UPDATED: 'user.updated',

  BRANCH_CREATED: 'branch.created',
  BRANCH_UPDATED: 'branch.updated',
  FLOOR_CREATED: 'floor.created',
  FLOOR_UPDATED: 'floor.updated',
  ROOM_CREATED: 'room.created',
  ROOM_UPDATED: 'room.updated',
  BED_CREATED: 'bed.created',
  BED_UPDATED: 'bed.updated',

  TENANT_CREATED: 'tenant.created',
  TENANT_UPDATED: 'tenant.updated',
  TENANT_MOVED: 'tenant.moved',
  TENANT_VACATED: 'tenant.vacated',
  TENANT_DOCUMENT_UPLOADED: 'tenant.document.uploaded',
  TENANT_DOCUMENT_ACCESSED: 'tenant.document.accessed',

  PRICE_CHANGED: 'pricing.changed',
  RATE_CHANGED: 'pricing.rate_changed',

  READING_ENTERED: 'meter.reading_entered',
  READING_UPDATED: 'meter.reading_updated',

  BILLING_GENERATED: 'billing.generated',
  BILLING_CLOSED: 'billing.closed',
  BILLING_REOPENED: 'billing.reopened',

  PAYMENT_SUBMITTED: 'payment.submitted',
  PAYMENT_PROOF_UPLOADED: 'payment.proof_uploaded',
  PAYMENT_APPROVED: 'payment.approved',
  PAYMENT_REJECTED: 'payment.rejected',
  PAYMENT_REVERSED: 'payment.reversed',

  MESSAGE_SENT: 'message.sent',
  AUTOMATION_RUN: 'automation.run',
  SETTING_UPDATED: 'settings.updated',
} as const;
