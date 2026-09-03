import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { handler, isoDateSchema, parse, uuidSchema } from '../../lib/http.js';
import { PERMISSIONS } from '../../lib/permissions.js';
import { assertBranchAccess, authenticate, currentUser, requirePermission } from '../../middleware/auth.js';

/**
 * Vacancy and occupancy, derived entirely from stay history.
 *
 * The owner never maintains a vacancy count: a bed is free on a date when no
 * stay covers it, and it is "coming free" when the stay covering it today has
 * an end date in the future. Both fall straight out of the same records that
 * drive billing, so the two can never disagree.
 */
export const vacanciesRouter = Router();
vacanciesRouter.use(authenticate, requirePermission(PERMISSIONS.BRANCH_READ));

const filtersSchema = z.object({
  branchId: uuidSchema.optional(),
  floorId: uuidSchema.optional(),
  sharingCapacity: z.coerce.number().int().positive().optional(),
  asOf: isoDateSchema.optional(),
  /** How far ahead to look for beds about to come free. */
  horizonDays: z.coerce.number().int().min(1).max(365).default(60),
});

/** Headline occupancy for the branches the caller can see. */
vacanciesRouter.get(
  '/summary',
  handler(async (req, res) => {
    const user = currentUser(req);
    const filters = parse(filtersSchema, req.query, 'vacancy filters');
    if (filters.branchId) assertBranchAccess(user, filters.branchId);
    const asOf = filters.asOf ?? new Date().toISOString().slice(0, 10);

    const { rows } = await query(
      `SELECT b.id AS branch_id, b.name AS branch_name,
              coalesce(sum(r.sharing_capacity), 0)::int AS total_capacity,
              coalesce(sum(occ.occupied_count), 0)::int AS occupied,
              greatest(coalesce(sum(r.sharing_capacity), 0) - coalesce(sum(occ.occupied_count), 0), 0)::int AS vacant
         FROM branches b
         LEFT JOIN rooms r ON r.branch_id = b.id AND r.status = 'active'
         LEFT JOIN LATERAL (
           SELECT count(*)::int AS occupied_count FROM tenant_stays s
            WHERE s.room_id = r.id AND s.status <> 'cancelled'
              AND s.start_date <= $1::date AND (s.end_date IS NULL OR s.end_date >= $1::date)
         ) occ ON TRUE
        WHERE b.status = 'active'
          AND ($2::uuid IS NULL OR b.id = $2)
          AND ($3::uuid[] IS NULL OR b.id = ANY($3))
        GROUP BY b.id, b.name
        ORDER BY b.name`,
      [asOf, filters.branchId ?? null, user.branchIds],
    );

    const totals = rows.reduce(
      (accumulator, row) => ({
        totalCapacity: accumulator.totalCapacity + Number(row.total_capacity),
        occupied: accumulator.occupied + Number(row.occupied),
        vacant: accumulator.vacant + Number(row.vacant),
      }),
      { totalCapacity: 0, occupied: 0, vacant: 0 },
    );

    res.json({
      asOf,
      branches: rows,
      totals: {
        ...totals,
        occupancyPercent:
          totals.totalCapacity === 0
            ? 0
            : Math.round((totals.occupied / totals.totalCapacity) * 1000) / 10,
      },
    });
  }),
);

/** Beds free right now, room by room. */
vacanciesRouter.get(
  '/available',
  handler(async (req, res) => {
    const user = currentUser(req);
    const filters = parse(filtersSchema, req.query, 'vacancy filters');
    if (filters.branchId) assertBranchAccess(user, filters.branchId);
    const asOf = filters.asOf ?? new Date().toISOString().slice(0, 10);

    const { rows } = await query(
      `SELECT r.id AS room_id, r.code AS room_code, r.name AS room_name, r.sharing_capacity,
              f.id AS floor_id, f.name AS floor_name, b.id AS branch_id, b.name AS branch_name,
              occ.occupied_count,
              (r.sharing_capacity - occ.occupied_count) AS vacant_count
         FROM rooms r
         JOIN floors f ON f.id = r.floor_id
         JOIN branches b ON b.id = r.branch_id
         CROSS JOIN LATERAL (
           SELECT count(*)::int AS occupied_count FROM tenant_stays s
            WHERE s.room_id = r.id AND s.status <> 'cancelled'
              AND s.start_date <= $1::date AND (s.end_date IS NULL OR s.end_date >= $1::date)
         ) occ
        WHERE r.status = 'active' AND b.status = 'active'
          AND r.sharing_capacity > occ.occupied_count
          AND ($2::uuid IS NULL OR r.branch_id = $2)
          AND ($3::uuid IS NULL OR r.floor_id = $3)
          AND ($4::int IS NULL OR r.sharing_capacity = $4)
          AND ($5::uuid[] IS NULL OR r.branch_id = ANY($5))
        ORDER BY b.name, f.sort_order, r.code`,
      [asOf, filters.branchId ?? null, filters.floorId ?? null, filters.sharingCapacity ?? null, user.branchIds],
    );

    res.json({ asOf, rooms: rows });
  }),
);

/**
 * Beds with a known departure date inside the horizon — what the owner needs
 * to start filling before the room actually empties.
 */
vacanciesRouter.get(
  '/upcoming',
  handler(async (req, res) => {
    const user = currentUser(req);
    const filters = parse(filtersSchema, req.query, 'vacancy filters');
    if (filters.branchId) assertBranchAccess(user, filters.branchId);
    const asOf = filters.asOf ?? new Date().toISOString().slice(0, 10);

    const { rows } = await query(
      `SELECT s.id AS stay_id, s.end_date, (s.end_date + 1) AS available_from,
              (s.end_date - $1::date) AS days_until_free,
              t.id AS tenant_id, t.full_name AS tenant_name, t.phone,
              r.id AS room_id, r.code AS room_code, r.sharing_capacity,
              f.name AS floor_name, b.id AS branch_id, b.name AS branch_name
         FROM tenant_stays s
         JOIN tenants t ON t.id = s.tenant_id
         JOIN rooms r ON r.id = s.room_id
         JOIN floors f ON f.id = s.floor_id
         JOIN branches b ON b.id = s.branch_id
        WHERE s.status <> 'cancelled'
          AND s.end_date IS NOT NULL
          AND s.end_date >= $1::date
          AND s.end_date <= ($1::date + $2::int)
          AND ($3::uuid IS NULL OR s.branch_id = $3)
          AND ($4::uuid IS NULL OR s.floor_id = $4)
          AND ($5::int IS NULL OR r.sharing_capacity = $5)
          AND ($6::uuid[] IS NULL OR s.branch_id = ANY($6))
        ORDER BY s.end_date, b.name, r.code`,
      [
        asOf, filters.horizonDays, filters.branchId ?? null, filters.floorId ?? null,
        filters.sharingCapacity ?? null, user.branchIds,
      ],
    );

    res.json({ asOf, horizonDays: filters.horizonDays, upcoming: rows });
  }),
);
