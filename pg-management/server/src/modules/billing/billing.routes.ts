import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../../db/pool.js';
import { handler, parse, periodMonthSchema, uuidSchema } from '../../lib/http.js';
import { notFound, unprocessable } from '../../lib/errors.js';
import { AUDIT, writeAudit } from '../../lib/audit.js';
import { PERMISSIONS } from '../../lib/permissions.js';
import { assertBranchAccess, authenticate, currentUser, requirePermission } from '../../middleware/auth.js';
import { generateBillsForPeriod, findMissingReadings } from './billing.service.js';

/**
 * Billing periods and bills.
 *
 * A month moves draft -> calculated -> reviewed -> closed. Closing freezes it:
 * later price changes, tenant moves and readings cannot alter a closed month's
 * figures, and only an admin can reopen it — which is recorded in the audit
 * trail with a reason.
 */
export const billingRouter = Router();
billingRouter.use(authenticate);

billingRouter.get(
  '/periods',
  requirePermission(PERMISSIONS.BILLING_READ),
  handler(async (req, res) => {
    const user = currentUser(req);
    const branchId = req.query.branchId ? parse(uuidSchema, req.query.branchId, 'branch id') : null;
    if (branchId) assertBranchAccess(user, branchId);

    const { rows } = await query(
      `SELECT bp.*, b.name AS branch_name,
              stats.bill_count, stats.total_paise, stats.collected_paise, stats.outstanding_paise
         FROM billing_periods bp
         JOIN branches b ON b.id = bp.branch_id
         CROSS JOIN LATERAL (
           SELECT count(*)::int AS bill_count,
                  coalesce(sum(bl.total_paise), 0)::bigint AS total_paise,
                  coalesce(sum(bl.paid_paise), 0)::bigint AS collected_paise,
                  coalesce(sum(bl.outstanding_paise), 0)::bigint AS outstanding_paise
             FROM bills bl WHERE bl.billing_period_id = bp.id AND bl.status <> 'void'
         ) stats
        WHERE ($1::uuid IS NULL OR bp.branch_id = $1)
          AND ($2::uuid[] IS NULL OR bp.branch_id = ANY($2))
        ORDER BY bp.period_month DESC, b.name`,
      [branchId, user.branchIds],
    );
    res.json({ periods: rows });
  }),
);

/** Dry run: what is missing before this month can be billed. */
billingRouter.get(
  '/periods/readiness',
  requirePermission(PERMISSIONS.BILLING_READ),
  handler(async (req, res) => {
    const user = currentUser(req);
    const input = parse(
      z.object({ branchId: uuidSchema, periodMonth: periodMonthSchema }),
      req.query,
      'readiness query',
    );
    assertBranchAccess(user, input.branchId);

    const missingReadings = await findMissingReadings(
      { query },
      input.branchId,
      input.periodMonth,
    );
    const { rows: flagged } = await query(
      `SELECT er.id, m.code AS meter_code, er.units_consumed, er.flag_reason
         FROM eb_readings er JOIN eb_meters m ON m.id = er.meter_id
        WHERE m.branch_id = $1 AND er.period_month = $2 AND er.status = 'flagged'`,
      [input.branchId, input.periodMonth],
    );

    res.json({
      ready: missingReadings.length === 0,
      missingReadings,
      flaggedReadings: flagged,
    });
  }),
);

/**
 * Generates every bill for the month. Idempotent while the month is open, so
 * it can be re-run after a late meter reading or a corrected stay.
 */
billingRouter.post(
  '/periods/generate',
  requirePermission(PERMISSIONS.BILLING_GENERATE),
  handler(async (req, res) => {
    const actor = currentUser(req);
    const input = parse(
      z.object({ branchId: uuidSchema, periodMonth: periodMonthSchema }),
      req.body,
      'generation request',
    );
    assertBranchAccess(actor, input.branchId);

    const result = await withTransaction(async (tx) => {
      const generated = await generateBillsForPeriod(tx, {
        branchId: input.branchId,
        periodMonth: input.periodMonth,
        userId: actor.id,
      });

      await writeAudit(tx, {
        userId: actor.id,
        action: AUDIT.BILLING_GENERATED,
        entityType: 'billing_period',
        entityId: generated.periodId,
        branchId: input.branchId,
        after: {
          periodMonth: input.periodMonth,
          billCount: generated.bills.length,
          totalPaise: generated.bills.reduce((sum, bill) => sum + bill.calculation.totalPaise, 0),
        },
        meta: { missingReadings: generated.missingReadings },
        ipAddress: req.ip, userAgent: req.header('user-agent'),
      });

      return generated;
    });

    res.json({
      periodId: result.periodId,
      billCount: result.bills.length,
      missingReadings: result.missingReadings,
      bills: result.bills.map((bill) => ({
        billId: bill.billId,
        tenantId: bill.tenantId,
        tenantName: bill.tenantName,
        rentPaise: bill.calculation.rentPaise,
        ebPaise: bill.calculation.ebPaise,
        commonChargePaise: bill.calculation.commonChargePaise,
        previousDuesPaise: bill.calculation.previousDuesPaise,
        totalPaise: bill.calculation.totalPaise,
        outstandingPaise: bill.calculation.outstandingPaise,
      })),
    });
  }),
);

const periodStatusSchema = z.object({
  branchId: uuidSchema,
  periodMonth: periodMonthSchema,
  reason: z.string().max(500).optional(),
});

billingRouter.post(
  '/periods/review',
  requirePermission(PERMISSIONS.BILLING_GENERATE),
  handler(async (req, res) => {
    const actor = currentUser(req);
    const input = parse(periodStatusSchema, req.body, 'review request');
    assertBranchAccess(actor, input.branchId);

    const { rowCount } = await query(
      `UPDATE billing_periods SET status = 'reviewed', reviewed_at = now(), updated_at = now()
        WHERE branch_id = $1 AND period_month = $2 AND status = 'calculated'`,
      [input.branchId, input.periodMonth],
    );
    if (rowCount === 0) throw unprocessable('That month is not in a state that can be reviewed.');
    res.json({ ok: true });
  }),
);

/** Freezes the month. Everything in it becomes historical record. */
billingRouter.post(
  '/periods/close',
  requirePermission(PERMISSIONS.BILLING_CLOSE),
  handler(async (req, res) => {
    const actor = currentUser(req);
    const input = parse(periodStatusSchema, req.body, 'close request');
    assertBranchAccess(actor, input.branchId);

    await withTransaction(async (tx) => {
      const { rows } = await tx.query<{ id: string; status: string }>(
        'SELECT id, status FROM billing_periods WHERE branch_id = $1 AND period_month = $2',
        [input.branchId, input.periodMonth],
      );
      const period = rows[0];
      if (!period) throw notFound('Billing period');
      if (period.status === 'closed') throw unprocessable('That month is already closed.');
      if (period.status === 'draft') {
        throw unprocessable('Generate the bills for this month before closing it.');
      }

      const missing = await findMissingReadings(tx, input.branchId, input.periodMonth);
      if (missing.length > 0) {
        throw unprocessable(
          `Meter reading missing for ${missing.map((meter) => meter.meterCode).join(', ')}. ` +
            'Enter the readings before closing the month.',
        );
      }

      await tx.query(
        `UPDATE billing_periods
            SET status = 'closed', closed_at = now(), closed_by = $2, updated_at = now()
          WHERE id = $1`,
        [period.id, actor.id],
      );
      await tx.query(
        `UPDATE bills SET status = 'closed', closed_at = now(), updated_at = now()
          WHERE billing_period_id = $1 AND status <> 'void'`,
        [period.id],
      );

      await writeAudit(tx, {
        userId: actor.id, action: AUDIT.BILLING_CLOSED, entityType: 'billing_period',
        entityId: period.id, branchId: input.branchId,
        before: { status: period.status }, after: { status: 'closed' },
        meta: { reason: input.reason ?? null },
        ipAddress: req.ip, userAgent: req.header('user-agent'),
      });
    });

    res.json({ ok: true });
  }),
);

/** Admin-only, always audited, and requires a reason. */
billingRouter.post(
  '/periods/reopen',
  requirePermission(PERMISSIONS.BILLING_REOPEN),
  handler(async (req, res) => {
    const actor = currentUser(req);
    const input = parse(
      periodStatusSchema.extend({ reason: z.string().min(5).max(500) }),
      req.body,
      'reopen request',
    );
    assertBranchAccess(actor, input.branchId);

    await withTransaction(async (tx) => {
      const { rows } = await tx.query<{ id: string; status: string; reopen_count: number }>(
        'SELECT id, status, reopen_count FROM billing_periods WHERE branch_id = $1 AND period_month = $2',
        [input.branchId, input.periodMonth],
      );
      const period = rows[0];
      if (!period) throw notFound('Billing period');
      if (period.status !== 'closed') throw unprocessable('That month is not closed.');

      await tx.query(
        `UPDATE billing_periods
            SET status = 'reviewed', closed_at = NULL, closed_by = NULL,
                reopen_count = reopen_count + 1, updated_at = now()
          WHERE id = $1`,
        [period.id],
      );
      await tx.query(
        `UPDATE bills SET status = 'reviewed', closed_at = NULL, updated_at = now()
          WHERE billing_period_id = $1 AND status = 'closed'`,
        [period.id],
      );

      await writeAudit(tx, {
        userId: actor.id, action: AUDIT.BILLING_REOPENED, entityType: 'billing_period',
        entityId: period.id, branchId: input.branchId,
        before: { status: 'closed', reopenCount: period.reopen_count },
        after: { status: 'reviewed', reopenCount: period.reopen_count + 1 },
        meta: { reason: input.reason },
        ipAddress: req.ip, userAgent: req.header('user-agent'),
      });
    });

    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// Bills
// ---------------------------------------------------------------------------
billingRouter.get(
  '/bills',
  requirePermission(PERMISSIONS.BILLING_READ),
  handler(async (req, res) => {
    const user = currentUser(req);
    const filters = parse(
      z.object({
        branchId: uuidSchema.optional(),
        periodMonth: periodMonthSchema.optional(),
        tenantId: uuidSchema.optional(),
        paymentStatus: z
          .enum(['not_paid', 'proof_submitted', 'pending_approval', 'partially_paid', 'paid', 'rejected'])
          .optional(),
      }),
      req.query,
      'bill filters',
    );
    if (filters.branchId) assertBranchAccess(user, filters.branchId);

    const { rows } = await query(
      `SELECT bl.*, bp.period_month, bp.status AS period_status, bp.branch_id,
              t.full_name AS tenant_name, t.phone AS tenant_phone, t.tenant_code,
              br.name AS branch_name
         FROM bills bl
         JOIN billing_periods bp ON bp.id = bl.billing_period_id
         JOIN branches br ON br.id = bp.branch_id
         JOIN tenants t ON t.id = bl.tenant_id
        WHERE ($1::uuid IS NULL OR bp.branch_id = $1)
          AND ($2::date IS NULL OR bp.period_month = $2)
          AND ($3::uuid IS NULL OR bl.tenant_id = $3)
          AND ($4::text IS NULL OR bl.payment_status::text = $4)
          AND ($5::uuid[] IS NULL OR bp.branch_id = ANY($5))
        ORDER BY bp.period_month DESC, t.full_name`,
      [
        filters.branchId ?? null, filters.periodMonth ?? null, filters.tenantId ?? null,
        filters.paymentStatus ?? null, user.branchIds,
      ],
    );
    res.json({ bills: rows });
  }),
);

/**
 * One bill with its full working: every rent segment, the whole electricity
 * apportionment behind the tenant's share, and the line-by-line explanation.
 */
billingRouter.get(
  '/bills/:id',
  requirePermission(PERMISSIONS.BILLING_READ),
  handler(async (req, res) => {
    const user = currentUser(req);
    const billId = parse(uuidSchema, req.params.id, 'bill id');

    const { rows } = await query(
      `SELECT bl.*, bp.period_month, bp.status AS period_status, bp.branch_id,
              t.full_name AS tenant_name, t.phone AS tenant_phone, t.tenant_code,
              br.name AS branch_name
         FROM bills bl
         JOIN billing_periods bp ON bp.id = bl.billing_period_id
         JOIN branches br ON br.id = bp.branch_id
         JOIN tenants t ON t.id = bl.tenant_id
        WHERE bl.id = $1`,
      [billId],
    );
    const bill = rows[0];
    if (!bill) throw notFound('Bill');
    assertBranchAccess(user, bill.branch_id as string);

    const { rows: items } = await query(
      'SELECT * FROM bill_items WHERE bill_id = $1 ORDER BY sort_order',
      [billId],
    );
    const { rows: breakdown } = await query(
      'SELECT engine_version, breakdown, created_at FROM bill_calculations WHERE bill_id = $1',
      [billId],
    );
    const { rows: payments } = await query(
      `SELECT p.*, u.full_name AS submitted_by_name
         FROM payments p LEFT JOIN users u ON u.id = p.submitted_by
        WHERE p.bill_id = $1 ORDER BY p.created_at DESC`,
      [billId],
    );

    res.json({
      bill,
      items,
      calculation: breakdown[0] ?? null,
      payments: user.permissions.has(PERMISSIONS.PAYMENT_READ) ? payments : [],
    });
  }),
);

/** The electricity working for a whole month, meter by meter. */
billingRouter.get(
  '/periods/:id/electricity',
  requirePermission(PERMISSIONS.BILLING_READ),
  handler(async (req, res) => {
    const user = currentUser(req);
    const periodId = parse(uuidSchema, req.params.id, 'period id');

    const { rows: periodRows } = await query<{ branch_id: string }>(
      'SELECT branch_id FROM billing_periods WHERE id = $1',
      [periodId],
    );
    if (!periodRows[0]) throw notFound('Billing period');
    assertBranchAccess(user, periodRows[0].branch_id);

    const { rows } = await query(
      `SELECT ec.*, m.code AS meter_code, m.label AS meter_label
         FROM eb_calculations ec JOIN eb_meters m ON m.id = ec.meter_id
        WHERE ec.billing_period_id = $1 ORDER BY m.code`,
      [periodId],
    );
    res.json({ calculations: rows });
  }),
);
