import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../../db/pool.js';
import { handler, isoDateSchema, paiseSchema, parse, uuidSchema } from '../../lib/http.js';
import { notFound } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { PERMISSIONS } from '../../lib/permissions.js';
import { assertBranchAccess, authenticate, currentUser, requirePermission } from '../../middleware/auth.js';

/** Maintenance issues, expenses and the audit log viewer. */
export const operationsRouter = Router();
operationsRouter.use(authenticate);

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------
operationsRouter.get(
  '/maintenance',
  requirePermission(PERMISSIONS.MAINTENANCE_READ),
  handler(async (req, res) => {
    const user = currentUser(req);
    const filters = parse(
      z.object({
        branchId: uuidSchema.optional(),
        status: z.enum(['open', 'in_progress', 'resolved', 'closed']).optional(),
        priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
      }),
      req.query,
      'maintenance filters',
    );
    if (filters.branchId) assertBranchAccess(user, filters.branchId);

    const { rows } = await query(
      `SELECT mi.*, b.name AS branch_name, f.name AS floor_name, r.code AS room_code,
              assignee.full_name AS assigned_to_name, reporter.full_name AS reported_by_name
         FROM maintenance_issues mi
         JOIN branches b ON b.id = mi.branch_id
         LEFT JOIN floors f ON f.id = mi.floor_id
         LEFT JOIN rooms r ON r.id = mi.room_id
         LEFT JOIN users assignee ON assignee.id = mi.assigned_to
         LEFT JOIN users reporter ON reporter.id = mi.reported_by
        WHERE ($1::uuid IS NULL OR mi.branch_id = $1)
          AND ($2::text IS NULL OR mi.status::text = $2)
          AND ($3::text IS NULL OR mi.priority::text = $3)
          AND ($4::uuid[] IS NULL OR mi.branch_id = ANY($4))
        ORDER BY
          CASE mi.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
          CASE mi.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
          mi.reported_date`,
      [filters.branchId ?? null, filters.status ?? null, filters.priority ?? null, user.branchIds],
    );
    res.json({ issues: rows });
  }),
);

const issueSchema = z.object({
  branchId: uuidSchema,
  floorId: uuidSchema.nullish(),
  roomId: uuidSchema.nullish(),
  title: z.string().min(1).max(200),
  description: z.string().max(4000).nullish(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
  assignedTo: uuidSchema.nullish(),
  reportedDate: isoDateSchema.optional(),
});

operationsRouter.post(
  '/maintenance',
  requirePermission(PERMISSIONS.MAINTENANCE_WRITE),
  handler(async (req, res) => {
    const actor = currentUser(req);
    const input = parse(issueSchema, req.body, 'maintenance issue');
    assertBranchAccess(actor, input.branchId);

    const { rows } = await query<{ id: string }>(
      `INSERT INTO maintenance_issues
         (branch_id, floor_id, room_id, title, description, priority, assigned_to,
          reported_by, reported_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, coalesce($9::date, CURRENT_DATE)) RETURNING id`,
      [
        input.branchId, input.floorId ?? null, input.roomId ?? null, input.title,
        input.description ?? null, input.priority, input.assignedTo ?? null, actor.id,
        input.reportedDate ?? null,
      ],
    );
    res.status(201).json({ id: rows[0]!.id });
  }),
);

operationsRouter.patch(
  '/maintenance/:id',
  requirePermission(PERMISSIONS.MAINTENANCE_WRITE),
  handler(async (req, res) => {
    const actor = currentUser(req);
    const issueId = parse(uuidSchema, req.params.id, 'issue id');
    const input = parse(
      issueSchema.partial().omit({ branchId: true }).extend({
        status: z.enum(['open', 'in_progress', 'resolved', 'closed']).optional(),
        costPaise: paiseSchema.optional(),
      }),
      req.body,
      'maintenance issue',
    );

    await withTransaction(async (tx) => {
      const { rows } = await tx.query('SELECT * FROM maintenance_issues WHERE id = $1', [issueId]);
      const before = rows[0];
      if (!before) throw notFound('Issue');
      assertBranchAccess(actor, before.branch_id as string);

      await tx.query(
        `UPDATE maintenance_issues SET
           title = coalesce($2, title), description = coalesce($3, description),
           priority = coalesce($4, priority), status = coalesce($5, status),
           assigned_to = coalesce($6, assigned_to), cost_paise = coalesce($7, cost_paise),
           floor_id = coalesce($8, floor_id), room_id = coalesce($9, room_id),
           resolved_date = CASE WHEN $5 IN ('resolved', 'closed') AND resolved_date IS NULL
                                THEN CURRENT_DATE ELSE resolved_date END,
           updated_at = now()
         WHERE id = $1`,
        [
          issueId, input.title ?? null, input.description ?? null, input.priority ?? null,
          input.status ?? null, input.assignedTo ?? null, input.costPaise ?? null,
          input.floorId ?? null, input.roomId ?? null,
        ],
      );

      await writeAudit(tx, {
        userId: actor.id, action: 'maintenance.updated', entityType: 'maintenance_issue',
        entityId: issueId, branchId: before.branch_id as string, before, after: input,
      });
    });

    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------
operationsRouter.get(
  '/expenses',
  requirePermission(PERMISSIONS.EXPENSE_READ),
  handler(async (req, res) => {
    const user = currentUser(req);
    const filters = parse(
      z.object({
        branchId: uuidSchema.optional(),
        category: z
          .enum(['electricity', 'salary', 'repairs', 'maintenance', 'supplies', 'rent', 'internet', 'water', 'other'])
          .optional(),
        from: isoDateSchema.optional(),
        to: isoDateSchema.optional(),
      }),
      req.query,
      'expense filters',
    );
    if (filters.branchId) assertBranchAccess(user, filters.branchId);

    const { rows } = await query(
      `SELECT e.*, b.name AS branch_name, u.full_name AS created_by_name
         FROM expenses e
         JOIN branches b ON b.id = e.branch_id
         LEFT JOIN users u ON u.id = e.created_by
        WHERE ($1::uuid IS NULL OR e.branch_id = $1)
          AND ($2::text IS NULL OR e.category::text = $2)
          AND ($3::date IS NULL OR e.expense_date >= $3)
          AND ($4::date IS NULL OR e.expense_date <= $4)
          AND ($5::uuid[] IS NULL OR e.branch_id = ANY($5))
        ORDER BY e.expense_date DESC LIMIT 500`,
      [
        filters.branchId ?? null, filters.category ?? null, filters.from ?? null,
        filters.to ?? null, user.branchIds,
      ],
    );

    const totalPaise = rows.reduce((sum, row) => sum + Number(row.amount_paise), 0);
    res.json({ expenses: rows, totalPaise });
  }),
);

operationsRouter.post(
  '/expenses',
  requirePermission(PERMISSIONS.EXPENSE_WRITE),
  handler(async (req, res) => {
    const actor = currentUser(req);
    const input = parse(
      z.object({
        branchId: uuidSchema,
        category: z.enum([
          'electricity', 'salary', 'repairs', 'maintenance', 'supplies', 'rent', 'internet', 'water', 'other',
        ]),
        amountPaise: paiseSchema.refine((value) => value > 0, 'Amount must be more than zero'),
        expenseDate: isoDateSchema,
        vendor: z.string().max(120).nullish(),
        notes: z.string().max(1000).nullish(),
      }),
      req.body,
      'expense',
    );
    assertBranchAccess(actor, input.branchId);

    const { rows } = await query<{ id: string }>(
      `INSERT INTO expenses (branch_id, category, amount_paise, expense_date, vendor, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        input.branchId, input.category, input.amountPaise, input.expenseDate,
        input.vendor ?? null, input.notes ?? null, actor.id,
      ],
    );
    res.status(201).json({ id: rows[0]!.id });
  }),
);

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------
operationsRouter.get(
  '/audit',
  requirePermission(PERMISSIONS.AUDIT_READ),
  handler(async (req, res) => {
    const filters = parse(
      z.object({
        entityType: z.string().max(60).optional(),
        entityId: z.string().max(60).optional(),
        userId: uuidSchema.optional(),
        action: z.string().max(60).optional(),
        branchId: uuidSchema.optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      req.query,
      'audit filters',
    );

    const { rows } = await query(
      `SELECT a.*, u.full_name AS user_name, u.email AS user_email, b.name AS branch_name
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.user_id
         LEFT JOIN branches b ON b.id = a.branch_id
        WHERE ($1::text IS NULL OR a.entity_type = $1)
          AND ($2::text IS NULL OR a.entity_id = $2)
          AND ($3::uuid IS NULL OR a.user_id = $3)
          AND ($4::text IS NULL OR a.action = $4)
          AND ($5::uuid IS NULL OR a.branch_id = $5)
        ORDER BY a.created_at DESC
        LIMIT $6 OFFSET $7`,
      [
        filters.entityType ?? null, filters.entityId ?? null, filters.userId ?? null,
        filters.action ?? null, filters.branchId ?? null, filters.limit, filters.offset,
      ],
    );
    res.json({ entries: rows, limit: filters.limit, offset: filters.offset });
  }),
);
