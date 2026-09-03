/**
 * The permission catalogue and each role's default grants.
 *
 * Permissions are checked in the API layer on every protected route. Hiding a
 * button in the client is a convenience for the user, never the control: the
 * server refuses an action the caller's role does not carry, whatever the
 * client sends.
 */
export const PERMISSIONS = {
  BRANCH_READ: 'branch.read',
  BRANCH_WRITE: 'branch.write',
  PROPERTY_WRITE: 'property.write',

  TENANT_READ: 'tenant.read',
  TENANT_WRITE: 'tenant.write',
  TENANT_MOVE: 'tenant.move',
  /** Viewing or downloading identity documents. Sensitive and always audited. */
  TENANT_DOCUMENT_READ: 'tenant.document.read',
  TENANT_DOCUMENT_WRITE: 'tenant.document.write',

  PRICING_READ: 'pricing.read',
  PRICING_WRITE: 'pricing.write',

  METER_READ: 'meter.read',
  METER_WRITE: 'meter.write',

  BILLING_READ: 'billing.read',
  BILLING_GENERATE: 'billing.generate',
  BILLING_CLOSE: 'billing.close',
  BILLING_REOPEN: 'billing.reopen',

  PAYMENT_READ: 'payment.read',
  PAYMENT_RECORD: 'payment.record',
  PAYMENT_APPROVE: 'payment.approve',

  REPORT_READ: 'report.read',
  /** Full financial reporting, including collection and outstanding figures. */
  REPORT_FINANCE: 'report.finance',

  MAINTENANCE_READ: 'maintenance.read',
  MAINTENANCE_WRITE: 'maintenance.write',

  EXPENSE_READ: 'expense.read',
  EXPENSE_WRITE: 'expense.write',

  MESSAGE_SEND: 'message.send',
  MESSAGE_READ: 'message.read',

  AUTOMATION_READ: 'automation.read',
  AUTOMATION_RUN: 'automation.run',

  USER_MANAGE: 'user.manage',
  AUDIT_READ: 'audit.read',
  SETTINGS_WRITE: 'settings.write',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS);

export type Role = 'admin' | 'manager' | 'staff';

/**
 * Operational access: day-to-day tenant and room work for the branches a
 * manager is assigned to. Deliberately excludes approving money, changing
 * prices, closing a month, and identity documents.
 */
const MANAGER_PERMISSIONS: Permission[] = [
  PERMISSIONS.BRANCH_READ,
  PERMISSIONS.TENANT_READ,
  PERMISSIONS.TENANT_WRITE,
  PERMISSIONS.TENANT_MOVE,
  PERMISSIONS.TENANT_DOCUMENT_WRITE,
  PERMISSIONS.PRICING_READ,
  PERMISSIONS.METER_READ,
  PERMISSIONS.METER_WRITE,
  PERMISSIONS.BILLING_READ,
  PERMISSIONS.BILLING_GENERATE,
  PERMISSIONS.PAYMENT_READ,
  PERMISSIONS.PAYMENT_RECORD,
  PERMISSIONS.REPORT_READ,
  PERMISSIONS.MAINTENANCE_READ,
  PERMISSIONS.MAINTENANCE_WRITE,
  PERMISSIONS.EXPENSE_READ,
  PERMISSIONS.EXPENSE_WRITE,
  PERMISSIONS.MESSAGE_SEND,
  PERMISSIONS.MESSAGE_READ,
  PERMISSIONS.AUTOMATION_READ,
];

/**
 * Limited access: look up the rooms and tenants of an assigned branch and
 * submit operational information such as meter readings and maintenance
 * issues. No money, no documents, no settings.
 */
const STAFF_PERMISSIONS: Permission[] = [
  PERMISSIONS.BRANCH_READ,
  PERMISSIONS.TENANT_READ,
  PERMISSIONS.METER_READ,
  PERMISSIONS.METER_WRITE,
  PERMISSIONS.MAINTENANCE_READ,
  PERMISSIONS.MAINTENANCE_WRITE,
];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: ALL_PERMISSIONS,
  manager: MANAGER_PERMISSIONS,
  staff: STAFF_PERMISSIONS,
};

/**
 * The caller's effective permissions: their role's defaults, plus any per-user
 * grants, minus any per-user revocations.
 */
export function effectivePermissions(
  role: Role,
  overrides: { permission: string; granted: boolean }[] = [],
): Set<string> {
  const permissions = new Set<string>(ROLE_PERMISSIONS[role]);
  for (const override of overrides) {
    if (override.granted) permissions.add(override.permission);
    else permissions.delete(override.permission);
  }
  return permissions;
}
