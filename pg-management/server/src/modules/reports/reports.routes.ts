import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { handler, isoDateSchema, parse, periodMonthSchema, uuidSchema } from '../../lib/http.js';
import { PERMISSIONS } from '../../lib/permissions.js';
import { assertBranchAccess, authenticate, currentUser, requirePermission } from '../../middleware/auth.js';

/**
 * Reporting.
 *
 * Every report is scoped to the caller's branches, and the financial ones
 * additionally require the finance permission — a manager can see who is in
 * which room without seeing the business's collection figures.
 */
export const reportsRouter = Router();
reportsRouter.use(authenticate, requirePermission(PERMISSIONS.REPORT_READ));

const scopeSchema = z.object({
  branchId: uuidSchema.optional(),
  periodMonth: periodMonthSchema.optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});

reportsRouter.get(
  '/occupancy',
  handler(async (req, res) => {
    const user = currentUser(req);
    const input = parse(scopeSchema, req.query, 'report scope');
    if (input.branchId) assertBranchAccess(user, input.branchId);
    const branchIds = input.branchId ? [input.branchId] : user.branchIds;

    const { rows } = await query(
      `SELECT b.id AS branch_id, b.name AS branch_name, f.id AS floor_id, f.name AS floor_name,
              r.id AS room_id, r.code AS room_code, r.sharing_capacity,
              occ.occupied, (r.sharing_capacity - occ.occupied) AS vacant
         FROM rooms r
         JOIN floors f ON f.id = r.floor_id
         JOIN branches b ON b.id = r.branch_id
         CROSS JOIN LATERAL (
           SELECT count(*)::int AS occupied FROM tenant_stays s
            WHERE s.room_id = r.id AND s.status <> 'cancelled'
              AND s.start_date <= CURRENT_DATE AND (s.end_date IS NULL OR s.end_date >= CURRENT_DATE)
         ) occ
        WHERE r.status = 'active' AND ($1::uuid[] IS NULL OR r.branch_id = ANY($1))
        ORDER BY b.name, f.sort_order, r.code`,
      [branchIds],
    );

    const totals = rows.reduce(
      (accumulator, row) => ({
        capacity: accumulator.capacity + Number(row.sharing_capacity),
        occupied: accumulator.occupied + Number(row.occupied),
        vacant: accumulator.vacant + Number(row.vacant),
      }),
      { capacity: 0, occupied: 0, vacant: 0 },
    );

    const { rows: upcoming } = await query(
      `SELECT s.end_date, (s.end_date + 1) AS available_from, t.full_name AS tenant_name,
              r.code AS room_code, b.name AS branch_name
         FROM tenant_stays s
         JOIN tenants t ON t.id = s.tenant_id
         JOIN rooms r ON r.id = s.room_id
         JOIN branches b ON b.id = s.branch_id
        WHERE s.status <> 'cancelled' AND s.end_date >= CURRENT_DATE
          AND s.end_date <= CURRENT_DATE + 60
          AND ($1::uuid[] IS NULL OR s.branch_id = ANY($1))
        ORDER BY s.end_date`,
      [branchIds],
    );

    res.json({
      rooms: rows,
      totals: {
        ...totals,
        occupancyPercent:
          totals.capacity === 0 ? 0 : Math.round((totals.occupied / totals.capacity) * 1000) / 10,
      },
      upcomingVacancies: upcoming,
    });
  }),
);

reportsRouter.get(
  '/financial',
  requirePermission(PERMISSIONS.REPORT_FINANCE),
  handler(async (req, res) => {
    const user = currentUser(req);
    const input = parse(scopeSchema, req.query, 'report scope');
    if (input.branchId) assertBranchAccess(user, input.branchId);
    const branchIds = input.branchId ? [input.branchId] : user.branchIds;
    const periodMonth = input.periodMonth ?? `${new Date().toISOString().slice(0, 7)}-01`;

    const { rows: billing } = await query(
      `SELECT bp.period_month, b.id AS branch_id, b.name AS branch_name,
              count(bl.id)::int AS bill_count,
              coalesce(sum(bl.rent_paise), 0)::bigint AS rent_paise,
              coalesce(sum(bl.eb_paise), 0)::bigint AS eb_paise,
              coalesce(sum(bl.common_charge_paise), 0)::bigint AS common_charge_paise,
              coalesce(sum(bl.total_paise), 0)::bigint AS expected_paise,
              coalesce(sum(bl.paid_paise), 0)::bigint AS collected_paise,
              coalesce(sum(bl.outstanding_paise), 0)::bigint AS outstanding_paise
         FROM billing_periods bp
         JOIN branches b ON b.id = bp.branch_id
         LEFT JOIN bills bl ON bl.billing_period_id = bp.id AND bl.status <> 'void'
        WHERE bp.period_month = $1 AND ($2::uuid[] IS NULL OR bp.branch_id = ANY($2))
        GROUP BY bp.period_month, b.id, b.name
        ORDER BY b.name`,
      [periodMonth, branchIds],
    );

    const { rows: expenses } = await query(
      `SELECT e.category::text AS category, coalesce(sum(e.amount_paise), 0)::bigint AS amount_paise
         FROM expenses e
        WHERE e.expense_date >= $1::date
          AND e.expense_date < ($1::date + INTERVAL '1 month')::date
          AND ($2::uuid[] IS NULL OR e.branch_id = ANY($2))
        GROUP BY e.category ORDER BY amount_paise DESC`,
      [periodMonth, branchIds],
    );

    const totalExpensePaise = expenses.reduce((sum, row) => sum + Number(row.amount_paise), 0);
    const collectedPaise = billing.reduce((sum, row) => sum + Number(row.collected_paise), 0);

    res.json({
      periodMonth,
      billing,
      expenses,
      totals: {
        expectedPaise: billing.reduce((sum, row) => sum + Number(row.expected_paise), 0),
        collectedPaise,
        outstandingPaise: billing.reduce((sum, row) => sum + Number(row.outstanding_paise), 0),
        expensePaise: totalExpensePaise,
        netPaise: collectedPaise - totalExpensePaise,
      },
    });
  }),
);

reportsRouter.get(
  '/tenants',
  handler(async (req, res) => {
    const user = currentUser(req);
    const input = parse(scopeSchema, req.query, 'report scope');
    if (input.branchId) assertBranchAccess(user, input.branchId);
    const branchIds = input.branchId ? [input.branchId] : user.branchIds;
    const from = input.from ?? `${new Date().toISOString().slice(0, 7)}-01`;
    const to = input.to ?? new Date().toISOString().slice(0, 10);

    const { rows: summary } = await query<{
      active: number; new_joiners: number; vacated: number; missing_documents: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM tenants t
            JOIN tenant_stays s ON s.tenant_id = t.id AND s.end_date IS NULL AND s.status = 'active'
           WHERE t.status = 'active' AND ($3::uuid[] IS NULL OR s.branch_id = ANY($3))) AS active,
         (SELECT count(*)::int FROM tenant_stays s
           WHERE s.start_date BETWEEN $1::date AND $2::date
             AND s.previous_stay_id IS NULL
             AND ($3::uuid[] IS NULL OR s.branch_id = ANY($3))) AS new_joiners,
         (SELECT count(*)::int FROM tenant_stays s
           WHERE s.end_date BETWEEN $1::date AND $2::date AND s.ended_reason <> 'moved'
             AND ($3::uuid[] IS NULL OR s.branch_id = ANY($3))) AS vacated,
         (SELECT count(*)::int FROM tenants t
           WHERE t.status = 'active'
             AND NOT EXISTS (
               SELECT 1 FROM tenant_documents d
                WHERE d.tenant_id = t.id AND d.doc_type IN ('aadhaar', 'office_id')
                GROUP BY d.tenant_id HAVING count(DISTINCT d.doc_type) = 2
             )) AS missing_documents`,
      [from, to, branchIds],
    );

    const { rows: movements } = await query(
      `SELECT s.id, s.start_date, s.end_date, s.ended_reason, t.full_name AS tenant_name,
              r.code AS room_code, b.name AS branch_name,
              CASE WHEN s.previous_stay_id IS NULL THEN 'joined' ELSE 'moved' END AS event
         FROM tenant_stays s
         JOIN tenants t ON t.id = s.tenant_id
         JOIN rooms r ON r.id = s.room_id
         JOIN branches b ON b.id = s.branch_id
        WHERE s.start_date BETWEEN $1::date AND $2::date
          AND ($3::uuid[] IS NULL OR s.branch_id = ANY($3))
        ORDER BY s.start_date DESC LIMIT 200`,
      [from, to, branchIds],
    );

    res.json({ from, to, summary: summary[0], movements });
  }),
);

reportsRouter.get(
  '/payments',
  requirePermission(PERMISSIONS.REPORT_FINANCE),
  handler(async (req, res) => {
    const user = currentUser(req);
    const input = parse(scopeSchema, req.query, 'report scope');
    if (input.branchId) assertBranchAccess(user, input.branchId);
    const branchIds = input.branchId ? [input.branchId] : user.branchIds;
    const periodMonth = input.periodMonth ?? `${new Date().toISOString().slice(0, 7)}-01`;

    const { rows: byStatus } = await query(
      `SELECT bl.payment_status::text AS payment_status, count(*)::int AS bill_count,
              coalesce(sum(bl.total_paise), 0)::bigint AS total_paise,
              coalesce(sum(bl.outstanding_paise), 0)::bigint AS outstanding_paise
         FROM bills bl
         JOIN billing_periods bp ON bp.id = bl.billing_period_id
        WHERE bp.period_month = $1 AND bl.status <> 'void'
          AND ($2::uuid[] IS NULL OR bp.branch_id = ANY($2))
        GROUP BY bl.payment_status ORDER BY bl.payment_status`,
      [periodMonth, branchIds],
    );

    const { rows: byState } = await query(
      `SELECT p.state::text AS state, count(*)::int AS count,
              coalesce(sum(coalesce(p.approved_amount_paise, p.amount_paise)), 0)::bigint AS amount_paise
         FROM payments p
        WHERE p.created_at >= $1::date
          AND p.created_at < ($1::date + INTERVAL '1 month')
          AND ($2::uuid[] IS NULL OR p.branch_id = ANY($2))
        GROUP BY p.state ORDER BY p.state`,
      [periodMonth, branchIds],
    );

    res.json({ periodMonth, bills: byStatus, payments: byState });
  }),
);
