import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../../db/pool.js';
import { handler, isoDateSchema, parse, periodMonthSchema, uuidSchema } from '../../lib/http.js';
import { notFound, unprocessable } from '../../lib/errors.js';
import { AUDIT, writeAudit } from '../../lib/audit.js';
import { PERMISSIONS } from '../../lib/permissions.js';
import { assertBranchAccess, authenticate, currentUser, requirePermission } from '../../middleware/auth.js';
import { resolveChargeRate } from '../pricing/pricing.service.js';

/**
 * Electricity meters and their monthly readings.
 *
 * Readings are validated as they are entered and anything doubtful is flagged
 * rather than rejected outright, so a genuine spike still gets recorded but
 * lands on the owner's attention list instead of quietly inflating everyone's
 * bill.
 */
export const metersRouter = Router();
metersRouter.use(authenticate);

metersRouter.get(
  '/',
  requirePermission(PERMISSIONS.METER_READ),
  handler(async (req, res) => {
    const user = currentUser(req);
    const branchId = req.query.branchId ? parse(uuidSchema, req.query.branchId, 'branch id') : null;
    if (branchId) assertBranchAccess(user, branchId);

    const { rows } = await query(
      `SELECT m.*, b.name AS branch_name, f.name AS floor_name,
              (SELECT count(*)::int FROM rooms r WHERE r.meter_id = m.id AND r.status = 'active') AS room_count,
              latest.period_month AS last_period, latest.current_reading AS last_reading,
              latest.reading_date AS last_reading_date
         FROM eb_meters m
         JOIN branches b ON b.id = m.branch_id
         LEFT JOIN floors f ON f.id = m.floor_id
         LEFT JOIN LATERAL (
           SELECT period_month, current_reading, reading_date FROM eb_readings er
            WHERE er.meter_id = m.id ORDER BY er.period_month DESC LIMIT 1
         ) latest ON TRUE
        WHERE ($1::uuid IS NULL OR m.branch_id = $1)
          AND ($2::uuid[] IS NULL OR m.branch_id = ANY($2))
          AND m.status = 'active'
        ORDER BY b.name, m.code`,
      [branchId, user.branchIds],
    );
    res.json({ meters: rows });
  }),
);

const meterSchema = z.object({
  branchId: uuidSchema,
  floorId: uuidSchema.nullish(),
  code: z.string().min(1).max(40),
  label: z.string().min(1).max(120),
  scope: z.enum(['branch', 'floor', 'room']).default('floor'),
  notes: z.string().max(1000).nullish(),
});

metersRouter.post(
  '/',
  requirePermission(PERMISSIONS.PROPERTY_WRITE),
  handler(async (req, res) => {
    const actor = currentUser(req);
    const input = parse(meterSchema, req.body, 'meter');
    assertBranchAccess(actor, input.branchId);

    const { rows } = await query<{ id: string }>(
      `INSERT INTO eb_meters (branch_id, floor_id, code, label, scope, notes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [input.branchId, input.floorId ?? null, input.code, input.label, input.scope, input.notes ?? null],
    );
    res.status(201).json({ id: rows[0]!.id });
  }),
);

metersRouter.get(
  '/readings',
  requirePermission(PERMISSIONS.METER_READ),
  handler(async (req, res) => {
    const user = currentUser(req);
    const filters = parse(
      z.object({
        branchId: uuidSchema.optional(),
        meterId: uuidSchema.optional(),
        periodMonth: periodMonthSchema.optional(),
        status: z.enum(['recorded', 'flagged', 'verified']).optional(),
      }),
      req.query,
      'reading filters',
    );
    if (filters.branchId) assertBranchAccess(user, filters.branchId);

    const { rows } = await query(
      `SELECT er.*, m.code AS meter_code, m.label AS meter_label, m.branch_id,
              b.name AS branch_name, u.full_name AS entered_by_name
         FROM eb_readings er
         JOIN eb_meters m ON m.id = er.meter_id
         JOIN branches b ON b.id = m.branch_id
         LEFT JOIN users u ON u.id = er.entered_by
        WHERE ($1::uuid IS NULL OR m.branch_id = $1)
          AND ($2::uuid IS NULL OR er.meter_id = $2)
          AND ($3::date IS NULL OR er.period_month = $3)
          AND ($4::text IS NULL OR er.status::text = $4)
          AND ($5::uuid[] IS NULL OR m.branch_id = ANY($5))
        ORDER BY er.period_month DESC, m.code`,
      [
        filters.branchId ?? null, filters.meterId ?? null, filters.periodMonth ?? null,
        filters.status ?? null, user.branchIds,
      ],
    );
    res.json({ readings: rows });
  }),
);

const readingSchema = z.object({
  meterId: uuidSchema,
  periodMonth: periodMonthSchema,
  readingDate: isoDateSchema,
  /** Omit to carry forward the previous month's closing reading. */
  previousReading: z.number().nonnegative().optional(),
  currentReading: z.number().nonnegative(),
  notes: z.string().max(1000).nullish(),
});

/** How far above the recent average a reading may be before it is flagged. */
const SPIKE_MULTIPLIER = 2.5;

metersRouter.post(
  '/readings',
  requirePermission(PERMISSIONS.METER_WRITE),
  handler(async (req, res) => {
    const actor = currentUser(req);
    const input = parse(readingSchema, req.body, 'reading');

    const result = await withTransaction(async (tx) => {
      const { rows: meterRows } = await tx.query<{ branch_id: string; code: string }>(
        'SELECT branch_id, code FROM eb_meters WHERE id = $1',
        [input.meterId],
      );
      const meter = meterRows[0];
      if (!meter) throw notFound('Meter');
      assertBranchAccess(actor, meter.branch_id);

      // A month that is already closed must not gain a new reading — its bills
      // are final and would no longer match.
      const { rows: closed } = await tx.query<{ status: string }>(
        `SELECT status FROM billing_periods WHERE branch_id = $1 AND period_month = $2`,
        [meter.branch_id, input.periodMonth],
      );
      if (closed[0]?.status === 'closed') {
        throw unprocessable(
          'That billing month is closed. An admin must reopen it before readings can change.',
        );
      }

      const { rows: previousRows } = await tx.query<{ current_reading: number }>(
        `SELECT current_reading FROM eb_readings
          WHERE meter_id = $1 AND period_month < $2
          ORDER BY period_month DESC LIMIT 1`,
        [input.meterId, input.periodMonth],
      );
      const previousReading = input.previousReading ?? previousRows[0]?.current_reading ?? 0;

      if (input.currentReading < previousReading) {
        throw unprocessable(
          `The current reading (${input.currentReading}) is below the previous one (${previousReading}). ` +
            'Check the meter, or correct the previous reading first.',
        );
      }

      // Flag a consumption far above this meter's recent norm, so the owner
      // sees it before tenants are billed for it.
      const units = input.currentReading - previousReading;
      const { rows: averageRows } = await tx.query<{ average: number | null }>(
        `SELECT avg(units_consumed)::float AS average FROM (
           SELECT units_consumed FROM eb_readings
            WHERE meter_id = $1 AND period_month < $2 AND units_consumed > 0
            ORDER BY period_month DESC LIMIT 6
         ) recent`,
        [input.meterId, input.periodMonth],
      );
      const average = averageRows[0]?.average ?? null;
      const isSpike = average !== null && average > 0 && units > average * SPIKE_MULTIPLIER;

      const ebRatePaise = await resolveChargeRate(tx, {
        branchId: meter.branch_id,
        charge: 'eb_rate',
        onDate: input.periodMonth,
      });

      const { rows } = await tx.query<{ id: string; units_consumed: number }>(
        `INSERT INTO eb_readings
           (meter_id, period_month, reading_date, previous_reading, current_reading,
            eb_rate_paise, status, flag_reason, notes, entered_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (meter_id, period_month) DO UPDATE SET
           reading_date = EXCLUDED.reading_date,
           previous_reading = EXCLUDED.previous_reading,
           current_reading = EXCLUDED.current_reading,
           eb_rate_paise = EXCLUDED.eb_rate_paise,
           status = EXCLUDED.status,
           flag_reason = EXCLUDED.flag_reason,
           notes = EXCLUDED.notes,
           updated_at = now()
         RETURNING id, units_consumed`,
        [
          input.meterId, input.periodMonth, input.readingDate, previousReading,
          input.currentReading, ebRatePaise,
          isSpike ? 'flagged' : 'recorded',
          isSpike
            ? `Consumption of ${units} units is more than ${SPIKE_MULTIPLIER}x the recent average of ${average!.toFixed(1)}.`
            : null,
          input.notes ?? null, actor.id,
        ],
      );

      await writeAudit(tx, {
        userId: actor.id,
        action: AUDIT.READING_ENTERED,
        entityType: 'eb_reading',
        entityId: rows[0]!.id,
        branchId: meter.branch_id,
        after: { ...input, previousReading, units, flagged: isSpike },
        ipAddress: req.ip, userAgent: req.header('user-agent'),
      });

      return { id: rows[0]!.id, unitsConsumed: rows[0]!.units_consumed, flagged: isSpike, ebRatePaise };
    });

    res.status(201).json(result);
  }),
);

/** Confirms a flagged reading is genuine, clearing it from the attention list. */
metersRouter.post(
  '/readings/:id/verify',
  requirePermission(PERMISSIONS.METER_WRITE),
  handler(async (req, res) => {
    const actor = currentUser(req);
    const readingId = parse(uuidSchema, req.params.id, 'reading id');

    await withTransaction(async (tx) => {
      const { rows } = await tx.query('SELECT * FROM eb_readings WHERE id = $1', [readingId]);
      const before = rows[0];
      if (!before) throw notFound('Reading');

      await tx.query(
        `UPDATE eb_readings SET status = 'verified', updated_at = now() WHERE id = $1`,
        [readingId],
      );
      await writeAudit(tx, {
        userId: actor.id, action: AUDIT.READING_UPDATED, entityType: 'eb_reading',
        entityId: readingId, before, after: { status: 'verified' },
      });
    });

    res.json({ ok: true });
  }),
);
