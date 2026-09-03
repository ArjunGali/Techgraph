import type { Db } from '../../db/pool.js';

/**
 * Detection of the situations that need a person to look at them.
 *
 * The philosophy of the whole system is that routine work runs itself and the
 * owner only sees what is unusual. Everything here is derived from live data
 * on each request, so an exception disappears the moment it is dealt with —
 * there is no separate list to tick off and no state to fall out of date.
 */

export type Severity = 'critical' | 'warning' | 'info';

export type Exception = {
  code: string;
  severity: Severity;
  title: string;
  detail: string;
  entityType: string;
  entityId: string | null;
  branchId: string | null;
  branchName: string | null;
  /** Where the client should send the user to resolve it. */
  action?: { route: string; label: string };
};

type Scope = { branchIds: string[] | null; periodMonth: string };

export async function detectExceptions(db: Db, scope: Scope): Promise<Exception[]> {
  const exceptions: Exception[] = [];
  const { branchIds, periodMonth } = scope;

  // Payments waiting on an admin decision — money the owner has not yet banked.
  const { rows: pendingPayments } = await db.query<{
    id: string; amount_paise: number; tenant_name: string; branch_id: string;
    branch_name: string; age_days: number;
  }>(
    `SELECT p.id, p.amount_paise, t.full_name AS tenant_name, p.branch_id, b.name AS branch_name,
            EXTRACT(DAY FROM now() - p.created_at)::int AS age_days
       FROM payments p
       JOIN tenants t ON t.id = p.tenant_id
       JOIN branches b ON b.id = p.branch_id
      WHERE p.state = 'pending_approval' AND ($1::uuid[] IS NULL OR p.branch_id = ANY($1))
      ORDER BY p.created_at`,
    [branchIds],
  );
  for (const payment of pendingPayments) {
    exceptions.push({
      code: 'payment_pending_approval',
      severity: payment.age_days >= 2 ? 'critical' : 'warning',
      title: 'Payment awaiting approval',
      detail:
        `${payment.tenant_name} submitted ₹${(payment.amount_paise / 100).toFixed(2)} ` +
        `${payment.age_days} day(s) ago.`,
      entityType: 'payment',
      entityId: payment.id,
      branchId: payment.branch_id,
      branchName: payment.branch_name,
      action: { route: `/payments/${payment.id}`, label: 'Review' },
    });
  }

  // Metered rooms with no reading for the month — bills cannot be finalised.
  const { rows: missingReadings } = await db.query<{
    meter_id: string; meter_code: string; branch_id: string; branch_name: string;
  }>(
    `SELECT DISTINCT m.id AS meter_id, m.code AS meter_code, m.branch_id, b.name AS branch_name
       FROM eb_meters m
       JOIN branches b ON b.id = m.branch_id
       JOIN rooms r ON r.meter_id = m.id AND r.status = 'active'
      WHERE m.status = 'active' AND b.status = 'active'
        AND ($1::uuid[] IS NULL OR m.branch_id = ANY($1))
        AND NOT EXISTS (
          SELECT 1 FROM eb_readings er WHERE er.meter_id = m.id AND er.period_month = $2
        )`,
    [branchIds, periodMonth],
  );
  for (const meter of missingReadings) {
    exceptions.push({
      code: 'missing_meter_reading',
      severity: 'warning',
      title: 'Meter reading missing',
      detail: `No reading recorded for meter ${meter.meter_code} in ${periodMonth.slice(0, 7)}.`,
      entityType: 'eb_meter',
      entityId: meter.meter_id,
      branchId: meter.branch_id,
      branchName: meter.branch_name,
      action: { route: '/meters', label: 'Enter reading' },
    });
  }

  // Readings the system flagged as improbably high.
  const { rows: flaggedReadings } = await db.query<{
    id: string; meter_code: string; units_consumed: number; flag_reason: string;
    branch_id: string; branch_name: string;
  }>(
    `SELECT er.id, m.code AS meter_code, er.units_consumed, er.flag_reason,
            m.branch_id, b.name AS branch_name
       FROM eb_readings er
       JOIN eb_meters m ON m.id = er.meter_id
       JOIN branches b ON b.id = m.branch_id
      WHERE er.status = 'flagged' AND ($1::uuid[] IS NULL OR m.branch_id = ANY($1))`,
    [branchIds],
  );
  for (const reading of flaggedReadings) {
    exceptions.push({
      code: 'suspicious_meter_reading',
      severity: 'warning',
      title: 'Unusual electricity consumption',
      detail: reading.flag_reason ?? `Meter ${reading.meter_code} recorded ${reading.units_consumed} units.`,
      entityType: 'eb_reading',
      entityId: reading.id,
      branchId: reading.branch_id,
      branchName: reading.branch_name,
      action: { route: '/meters', label: 'Check reading' },
    });
  }

  // Bills past their due date with money still outstanding.
  const { rows: overdue } = await db.query<{
    id: string; tenant_name: string; outstanding_paise: number; due_date: string;
    branch_id: string; branch_name: string; days_overdue: number;
  }>(
    `SELECT bl.id, t.full_name AS tenant_name, bl.outstanding_paise, bl.due_date,
            bp.branch_id, b.name AS branch_name,
            (CURRENT_DATE - bl.due_date) AS days_overdue
       FROM bills bl
       JOIN billing_periods bp ON bp.id = bl.billing_period_id
       JOIN branches b ON b.id = bp.branch_id
       JOIN tenants t ON t.id = bl.tenant_id
      WHERE bl.outstanding_paise > 0 AND bl.due_date < CURRENT_DATE AND bl.status <> 'void'
        AND ($1::uuid[] IS NULL OR bp.branch_id = ANY($1))
      ORDER BY bl.due_date`,
    [branchIds],
  );
  for (const bill of overdue) {
    exceptions.push({
      code: 'payment_overdue',
      severity: bill.days_overdue > 7 ? 'critical' : 'warning',
      title: 'Payment overdue',
      detail:
        `${bill.tenant_name} owes ₹${(bill.outstanding_paise / 100).toFixed(2)}, ` +
        `${bill.days_overdue} day(s) past due.`,
      entityType: 'bill',
      entityId: bill.id,
      branchId: bill.branch_id,
      branchName: bill.branch_name,
      action: { route: `/billing/bills/${bill.id}`, label: 'View bill' },
    });
  }

  // Active tenants with no Aadhaar or office ID on file.
  const { rows: missingDocuments } = await db.query<{
    id: string; full_name: string; branch_id: string | null; branch_name: string | null;
    missing: string;
  }>(
    `SELECT t.id, t.full_name, s.branch_id, b.name AS branch_name,
            array_to_string(
              array_remove(ARRAY[
                CASE WHEN NOT EXISTS (SELECT 1 FROM tenant_documents d
                                       WHERE d.tenant_id = t.id AND d.doc_type = 'aadhaar')
                     THEN 'Aadhaar' END,
                CASE WHEN NOT EXISTS (SELECT 1 FROM tenant_documents d
                                       WHERE d.tenant_id = t.id AND d.doc_type = 'office_id')
                     THEN 'office ID' END
              ], NULL), ' and '
            ) AS missing
       FROM tenants t
       LEFT JOIN tenant_stays s ON s.tenant_id = t.id AND s.end_date IS NULL AND s.status = 'active'
       LEFT JOIN branches b ON b.id = s.branch_id
      WHERE t.status = 'active'
        AND ($1::uuid[] IS NULL OR s.branch_id = ANY($1) OR s.branch_id IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM tenant_documents d
           WHERE d.tenant_id = t.id AND d.doc_type IN ('aadhaar', 'office_id')
           GROUP BY d.tenant_id HAVING count(DISTINCT d.doc_type) = 2
        )`,
    [branchIds],
  );
  for (const tenant of missingDocuments) {
    exceptions.push({
      code: 'missing_tenant_documents',
      severity: 'info',
      title: 'Verification documents missing',
      detail: `${tenant.full_name} has no ${tenant.missing} on file.`,
      entityType: 'tenant',
      entityId: tenant.id,
      branchId: tenant.branch_id,
      branchName: tenant.branch_name,
      action: { route: `/tenants/${tenant.id}`, label: 'Open tenant' },
    });
  }

  // Active tenants with no room — they would be missed by billing entirely.
  const { rows: unassigned } = await db.query<{ id: string; full_name: string }>(
    `SELECT t.id, t.full_name FROM tenants t
      WHERE t.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM tenant_stays s
           WHERE s.tenant_id = t.id AND s.status = 'active' AND s.end_date IS NULL
        )`,
  );
  for (const tenant of unassigned) {
    exceptions.push({
      code: 'tenant_without_room',
      severity: 'critical',
      title: 'Active tenant has no room',
      detail: `${tenant.full_name} is marked active but has no open stay, so they will not be billed.`,
      entityType: 'tenant',
      entityId: tenant.id,
      branchId: null,
      branchName: null,
      action: { route: `/tenants/${tenant.id}`, label: 'Assign a room' },
    });
  }

  // Rooms holding more people than their sharing capacity allows.
  const { rows: overCapacity } = await db.query<{
    id: string; code: string; sharing_capacity: number; occupied: number;
    branch_id: string; branch_name: string;
  }>(
    `SELECT r.id, r.code, r.sharing_capacity, occ.occupied, r.branch_id, b.name AS branch_name
       FROM rooms r
       JOIN branches b ON b.id = r.branch_id
       CROSS JOIN LATERAL (
         SELECT count(*)::int AS occupied FROM tenant_stays s
          WHERE s.room_id = r.id AND s.status <> 'cancelled'
            AND s.start_date <= CURRENT_DATE AND (s.end_date IS NULL OR s.end_date >= CURRENT_DATE)
       ) occ
      WHERE occ.occupied > r.sharing_capacity
        AND ($1::uuid[] IS NULL OR r.branch_id = ANY($1))`,
    [branchIds],
  );
  for (const room of overCapacity) {
    exceptions.push({
      code: 'room_over_capacity',
      severity: 'critical',
      title: 'Room over capacity',
      detail: `${room.code} is ${room.sharing_capacity} sharing but holds ${room.occupied} tenants.`,
      entityType: 'room',
      entityId: room.id,
      branchId: room.branch_id,
      branchName: room.branch_name,
      action: { route: '/property', label: 'Open room' },
    });
  }

  // Maintenance that has been open too long.
  const { rows: staleIssues } = await db.query<{
    id: string; title: string; priority: string; age_days: number;
    branch_id: string; branch_name: string;
  }>(
    `SELECT mi.id, mi.title, mi.priority::text AS priority,
            (CURRENT_DATE - mi.reported_date) AS age_days, mi.branch_id, b.name AS branch_name
       FROM maintenance_issues mi
       JOIN branches b ON b.id = mi.branch_id
      WHERE mi.status IN ('open', 'in_progress')
        AND (CURRENT_DATE - mi.reported_date) >= CASE mi.priority
              WHEN 'urgent' THEN 1 WHEN 'high' THEN 3 WHEN 'medium' THEN 7 ELSE 14 END
        AND ($1::uuid[] IS NULL OR mi.branch_id = ANY($1))`,
    [branchIds],
  );
  for (const issue of staleIssues) {
    exceptions.push({
      code: 'maintenance_overdue',
      severity: issue.priority === 'urgent' ? 'critical' : 'warning',
      title: 'Maintenance issue still open',
      detail: `"${issue.title}" (${issue.priority}) has been open for ${issue.age_days} day(s).`,
      entityType: 'maintenance_issue',
      entityId: issue.id,
      branchId: issue.branch_id,
      branchName: issue.branch_name,
      action: { route: '/maintenance', label: 'Open issue' },
    });
  }

  const order: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  return exceptions.sort((a, b) => order[a.severity] - order[b.severity]);
}
