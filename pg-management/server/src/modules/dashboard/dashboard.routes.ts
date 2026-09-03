import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { handler, parse, periodMonthSchema, uuidSchema } from '../../lib/http.js';
import { PERMISSIONS } from '../../lib/permissions.js';
import { assertBranchAccess, authenticate, currentUser, requirePermission } from '../../middleware/auth.js';
import { detectExceptions } from './exceptions.service.js';

/**
 * The owner's dashboard.
 *
 * Ordered by what needs a decision rather than by what is easy to count:
 * exceptions first, then money, then occupancy. Financial figures are omitted
 * for callers without the finance permission, rather than being sent and
 * hidden in the client.
 */
export const dashboardRouter = Router();
dashboardRouter.use(authenticate, requirePermission(PERMISSIONS.BRANCH_READ));

function currentPeriodMonth(): string {
  return `${new Date().toISOString().slice(0, 7)}-01`;
}

dashboardRouter.get(
  '/',
  handler(async (req, res) => {
    const user = currentUser(req);
    const input = parse(
      z.object({
        branchId: uuidSchema.optional(),
        periodMonth: periodMonthSchema.optional(),
      }),
      req.query,
      'dashboard filters',
    );
    if (input.branchId) assertBranchAccess(user, input.branchId);

    const periodMonth = input.periodMonth ?? currentPeriodMonth();
    // A branch filter narrows the caller's own scope; it never widens it.
    const branchIds = input.branchId
      ? [input.branchId]
      : user.branchIds;
    const canSeeFinance = user.permissions.has(PERMISSIONS.REPORT_FINANCE);

    const { rows: occupancyRows } = await query<{
      total_capacity: number; occupied: number; vacant: number;
    }>(
      `SELECT coalesce(sum(r.sharing_capacity), 0)::int AS total_capacity,
              coalesce(sum(occ.occupied_count), 0)::int AS occupied,
              greatest(coalesce(sum(r.sharing_capacity), 0) - coalesce(sum(occ.occupied_count), 0), 0)::int AS vacant
         FROM rooms r
         JOIN branches b ON b.id = r.branch_id
         CROSS JOIN LATERAL (
           SELECT count(*)::int AS occupied_count FROM tenant_stays s
            WHERE s.room_id = r.id AND s.status <> 'cancelled'
              AND s.start_date <= CURRENT_DATE AND (s.end_date IS NULL OR s.end_date >= CURRENT_DATE)
         ) occ
        WHERE r.status = 'active' AND b.status = 'active'
          AND ($1::uuid[] IS NULL OR r.branch_id = ANY($1))`,
      [branchIds],
    );
    const occupancy = occupancyRows[0] ?? { total_capacity: 0, occupied: 0, vacant: 0 };

    const { rows: upcomingRows } = await query<{ count: number }>(
      `SELECT count(*)::int AS count FROM tenant_stays s
        WHERE s.status <> 'cancelled' AND s.end_date IS NOT NULL
          AND s.end_date >= CURRENT_DATE AND s.end_date <= CURRENT_DATE + 30
          AND ($1::uuid[] IS NULL OR s.branch_id = ANY($1))`,
      [branchIds],
    );

    let finance = null;
    if (canSeeFinance) {
      const { rows: financeRows } = await query<{
        expected_paise: number; collected_paise: number; pending_paise: number;
        overdue_paise: number; pending_approvals: number;
      }>(
        `SELECT coalesce(sum(bl.total_paise), 0)::bigint AS expected_paise,
                coalesce(sum(bl.paid_paise), 0)::bigint AS collected_paise,
                coalesce(sum(bl.outstanding_paise), 0)::bigint AS pending_paise,
                coalesce(sum(bl.outstanding_paise) FILTER (WHERE bl.due_date < CURRENT_DATE), 0)::bigint AS overdue_paise,
                (SELECT count(*)::int FROM payments p
                  WHERE p.state = 'pending_approval'
                    AND ($1::uuid[] IS NULL OR p.branch_id = ANY($1))) AS pending_approvals
           FROM bills bl
           JOIN billing_periods bp ON bp.id = bl.billing_period_id
          WHERE bp.period_month = $2 AND bl.status <> 'void'
            AND ($1::uuid[] IS NULL OR bp.branch_id = ANY($1))`,
        [branchIds, periodMonth],
      );
      finance = financeRows[0] ?? null;
    }

    const exceptions = await detectExceptions({ query }, { branchIds, periodMonth });

    res.json({
      periodMonth,
      occupancy: {
        totalCapacity: occupancy.total_capacity,
        occupied: occupancy.occupied,
        vacant: occupancy.vacant,
        occupancyPercent:
          occupancy.total_capacity === 0
            ? 0
            : Math.round((occupancy.occupied / occupancy.total_capacity) * 1000) / 10,
        upcomingVacancies: upcomingRows[0]?.count ?? 0,
      },
      finance,
      exceptions,
      exceptionCounts: {
        critical: exceptions.filter((item) => item.severity === 'critical').length,
        warning: exceptions.filter((item) => item.severity === 'warning').length,
        info: exceptions.filter((item) => item.severity === 'info').length,
      },
    });
  }),
);

dashboardRouter.get(
  '/exceptions',
  handler(async (req, res) => {
    const user = currentUser(req);
    const input = parse(
      z.object({ branchId: uuidSchema.optional(), periodMonth: periodMonthSchema.optional() }),
      req.query,
      'exception filters',
    );
    if (input.branchId) assertBranchAccess(user, input.branchId);

    const exceptions = await detectExceptions(
      { query },
      {
        branchIds: input.branchId ? [input.branchId] : user.branchIds,
        periodMonth: input.periodMonth ?? currentPeriodMonth(),
      },
    );
    res.json({ exceptions });
  }),
);
