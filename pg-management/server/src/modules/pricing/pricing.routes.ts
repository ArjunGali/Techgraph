import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../../db/pool.js';
import { handler, isoDateSchema, parse, paiseSchema, uuidSchema } from '../../lib/http.js';
import { notFound } from '../../lib/errors.js';
import { AUDIT, writeAudit } from '../../lib/audit.js';
import { PERMISSIONS } from '../../lib/permissions.js';
import { assertBranchAccess, authenticate, currentUser, requirePermission } from '../../middleware/auth.js';
import { resolveChargeRate, resolvePrice } from './pricing.service.js';

/**
 * Rent prices and administered rates.
 *
 * A price is never edited in place. Setting a new one closes the current rule
 * the day before the new one starts and inserts a new row, so ₹7,000 up to 31
 * August and ₹7,500 from 1 September both remain on record and an August bill
 * recomputes at ₹7,000 forever.
 */
export const pricingRouter = Router();
pricingRouter.use(authenticate);

pricingRouter.get(
  '/rules',
  requirePermission(PERMISSIONS.PRICING_READ),
  handler(async (req, res) => {
    const user = currentUser(req);
    const filters = parse(
      z.object({
        branchId: uuidSchema.optional(),
        roomId: uuidSchema.optional(),
        sharingCapacity: z.coerce.number().int().positive().optional(),
        includeExpired: z.coerce.boolean().default(true),
      }),
      req.query,
      'price filters',
    );
    if (filters.branchId) assertBranchAccess(user, filters.branchId);

    const { rows } = await query(
      `SELECT pr.*, b.name AS branch_name, r.code AS room_code, u.full_name AS created_by_name
         FROM price_rules pr
         LEFT JOIN branches b ON b.id = pr.branch_id
         LEFT JOIN rooms r ON r.id = pr.room_id
         LEFT JOIN users u ON u.id = pr.created_by
        WHERE ($1::uuid IS NULL OR pr.branch_id = $1)
          AND ($2::uuid IS NULL OR pr.room_id = $2)
          AND ($3::int IS NULL OR pr.sharing_capacity = $3)
          AND ($4::boolean OR pr.effective_to IS NULL OR pr.effective_to >= CURRENT_DATE)
          AND ($5::uuid[] IS NULL OR pr.branch_id IS NULL OR pr.branch_id = ANY($5))
        ORDER BY pr.sharing_capacity NULLS LAST, pr.effective_from DESC`,
      [
        filters.branchId ?? null, filters.roomId ?? null, filters.sharingCapacity ?? null,
        filters.includeExpired, user.branchIds,
      ],
    );
    res.json({ rules: rows });
  }),
);

const priceRuleSchema = z
  .object({
    branchId: uuidSchema.nullish(),
    roomId: uuidSchema.nullish(),
    sharingCapacity: z.number().int().positive().max(50).nullish(),
    monthlyRentPaise: paiseSchema,
    effectiveFrom: isoDateSchema,
    note: z.string().max(500).nullish(),
  })
  .refine(
    (value) => value.roomId || value.branchId || value.sharingCapacity,
    'Give the rule a scope: a room, a branch, or a sharing capacity',
  );

/**
 * Introduces a new price from a date, closing whatever rule it supersedes.
 * The old rule is retained with its own effective range.
 */
pricingRouter.post(
  '/rules',
  requirePermission(PERMISSIONS.PRICING_WRITE),
  handler(async (req, res) => {
    const actor = currentUser(req);
    const input = parse(priceRuleSchema, req.body, 'price rule');
    if (input.branchId) assertBranchAccess(actor, input.branchId);

    const id = await withTransaction(async (tx) => {
      // Close any rule for the same scope that is still open on the new start
      // date, ending it the day before. This keeps the exclusion constraint
      // satisfied and leaves an unbroken price timeline.
      const { rows: superseded } = await tx.query<{ id: string; monthly_rent_paise: number }>(
        `UPDATE price_rules
            SET effective_to = ($4::date - INTERVAL '1 day')::date
          WHERE coalesce(room_id::text, '-') = coalesce($1::text, '-')
            AND coalesce(branch_id::text, '-') = coalesce($2::text, '-')
            AND coalesce(sharing_capacity, -1) = coalesce($3::int, -1)
            AND (effective_to IS NULL OR effective_to >= $4::date)
            AND effective_from < $4::date
          RETURNING id, monthly_rent_paise`,
        [input.roomId ?? null, input.branchId ?? null, input.sharingCapacity ?? null, input.effectiveFrom],
      );

      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO price_rules
           (branch_id, room_id, sharing_capacity, monthly_rent_paise, effective_from, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [
          input.branchId ?? null, input.roomId ?? null, input.sharingCapacity ?? null,
          input.monthlyRentPaise, input.effectiveFrom, input.note ?? null, actor.id,
        ],
      );

      await writeAudit(tx, {
        userId: actor.id,
        action: AUDIT.PRICE_CHANGED,
        entityType: 'price_rule',
        entityId: rows[0]!.id,
        branchId: input.branchId ?? null,
        before: superseded[0] ?? null,
        after: input,
        meta: { supersededRuleIds: superseded.map((rule) => rule.id) },
        ipAddress: req.ip, userAgent: req.header('user-agent'),
      });

      return rows[0]!.id;
    });

    res.status(201).json({ id });
  }),
);

/** What a given room would cost on a given date, and which rule decided it. */
pricingRouter.get(
  '/resolve',
  requirePermission(PERMISSIONS.PRICING_READ),
  handler(async (req, res) => {
    const user = currentUser(req);
    const input = parse(
      z.object({ roomId: uuidSchema, onDate: isoDateSchema }),
      req.query,
      'price lookup',
    );

    const { rows } = await query<{ branch_id: string; sharing_capacity: number }>(
      'SELECT branch_id, sharing_capacity FROM rooms WHERE id = $1',
      [input.roomId],
    );
    const room = rows[0];
    if (!room) throw notFound('Room');
    assertBranchAccess(user, room.branch_id);

    const price = await resolvePrice(
      { query },
      {
        branchId: room.branch_id,
        roomId: input.roomId,
        sharingCapacity: room.sharing_capacity,
        onDate: input.onDate,
      },
    );
    res.json({ price });
  }),
);

// ---------------------------------------------------------------------------
// Administered rates: EB per unit and the flat common charge
// ---------------------------------------------------------------------------
pricingRouter.get(
  '/rates',
  requirePermission(PERMISSIONS.PRICING_READ),
  handler(async (req, res) => {
    const user = currentUser(req);
    const branchId = req.query.branchId ? parse(uuidSchema, req.query.branchId, 'branch id') : null;
    if (branchId) assertBranchAccess(user, branchId);

    const { rows } = await query(
      `SELECT cr.*, b.name AS branch_name, u.full_name AS created_by_name
         FROM charge_rates cr
         LEFT JOIN branches b ON b.id = cr.branch_id
         LEFT JOIN users u ON u.id = cr.created_by
        WHERE ($1::uuid IS NULL OR cr.branch_id = $1 OR cr.branch_id IS NULL)
        ORDER BY cr.charge, cr.effective_from DESC`,
      [branchId],
    );

    const today = new Date().toISOString().slice(0, 10);
    const current = branchId
      ? {
          ebRatePaise: await resolveChargeRate({ query }, { branchId, charge: 'eb_rate', onDate: today }),
          commonChargePaise: await resolveChargeRate(
            { query },
            { branchId, charge: 'common_charge', onDate: today },
          ),
        }
      : null;

    res.json({ rates: rows, current });
  }),
);

const rateSchema = z.object({
  branchId: uuidSchema.nullish(),
  charge: z.enum(['eb_rate', 'common_charge']),
  valuePaise: paiseSchema,
  effectiveFrom: isoDateSchema,
  note: z.string().max(500).nullish(),
});

/**
 * Sets an administered rate from a date.
 *
 * These values are inputs to the calculation engine, not the formula itself:
 * an admin may change the rate per unit or the common charge, but no role can
 * alter how those figures are combined.
 */
pricingRouter.post(
  '/rates',
  requirePermission(PERMISSIONS.PRICING_WRITE),
  handler(async (req, res) => {
    const actor = currentUser(req);
    const input = parse(rateSchema, req.body, 'rate');
    if (input.branchId) assertBranchAccess(actor, input.branchId);

    const id = await withTransaction(async (tx) => {
      const { rows: superseded } = await tx.query<{ id: string; value_paise: number }>(
        `UPDATE charge_rates
            SET effective_to = ($3::date - INTERVAL '1 day')::date
          WHERE coalesce(branch_id::text, '-') = coalesce($1::text, '-')
            AND charge = $2
            AND (effective_to IS NULL OR effective_to >= $3::date)
            AND effective_from < $3::date
          RETURNING id, value_paise`,
        [input.branchId ?? null, input.charge, input.effectiveFrom],
      );

      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO charge_rates (branch_id, charge, value_paise, effective_from, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [input.branchId ?? null, input.charge, input.valuePaise, input.effectiveFrom, input.note ?? null, actor.id],
      );

      await writeAudit(tx, {
        userId: actor.id, action: AUDIT.RATE_CHANGED, entityType: 'charge_rate',
        entityId: rows[0]!.id, branchId: input.branchId ?? null,
        before: superseded[0] ?? null, after: input,
        ipAddress: req.ip, userAgent: req.header('user-agent'),
      });

      return rows[0]!.id;
    });

    res.status(201).json({ id });
  }),
);
