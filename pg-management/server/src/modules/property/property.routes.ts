import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../../db/pool.js';
import { handler, parse, uuidSchema } from '../../lib/http.js';
import { badRequest, notFound, unprocessable } from '../../lib/errors.js';
import { AUDIT, writeAudit } from '../../lib/audit.js';
import { PERMISSIONS } from '../../lib/permissions.js';
import { assertBranchAccess, authenticate, currentUser, requirePermission } from '../../middleware/auth.js';

/**
 * Branch, floor, room and bed administration.
 *
 * Nothing about the shape of a property is fixed in code: an admin adds
 * branches, names floors however the building is actually laid out, creates
 * rooms of any sharing capacity and gives them beds. Records are deactivated
 * or archived rather than deleted, so historical stays and bills keep
 * resolving to a real room.
 */
export const propertyRouter = Router();

propertyRouter.use(authenticate);

const statusSchema = z.enum(['active', 'inactive', 'archived']);

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------
propertyRouter.get(
  '/branches',
  requirePermission(PERMISSIONS.BRANCH_READ),
  handler(async (req, res) => {
    const user = currentUser(req);
    const includeArchived = req.query.includeArchived === 'true';

    const { rows } = await query(
      `SELECT b.*,
              (SELECT count(*)::int FROM floors f WHERE f.branch_id = b.id AND f.status = 'active') AS floor_count,
              (SELECT count(*)::int FROM rooms r WHERE r.branch_id = b.id AND r.status = 'active') AS room_count,
              (SELECT count(*)::int
                 FROM beds bd JOIN rooms r ON r.id = bd.room_id
                WHERE r.branch_id = b.id AND bd.status = 'active' AND r.status = 'active') AS bed_count
         FROM branches b
        WHERE ($1::uuid[] IS NULL OR b.id = ANY($1))
          AND ($2::boolean OR b.status <> 'archived')
        ORDER BY b.name`,
      [user.branchIds, includeArchived],
    );
    res.json({ branches: rows });
  }),
);

const branchSchema = z.object({
  code: z.string().min(1).max(32),
  name: z.string().min(1).max(120),
  addressLine1: z.string().max(200).nullish(),
  addressLine2: z.string().max(200).nullish(),
  city: z.string().max(80).nullish(),
  state: z.string().max(80).nullish(),
  pincode: z.string().max(12).nullish(),
  contactName: z.string().max(120).nullish(),
  contactPhone: z.string().max(20).nullish(),
  contactEmail: z.string().email().nullish(),
  notes: z.string().max(2000).nullish(),
});

propertyRouter.post(
  '/branches',
  requirePermission(PERMISSIONS.BRANCH_WRITE),
  handler(async (req, res) => {
    const actor = currentUser(req);
    const input = parse(branchSchema, req.body, 'branch');

    const id = await withTransaction(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO branches
           (code, name, address_line1, address_line2, city, state, pincode,
            contact_name, contact_phone, contact_email, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [
          input.code, input.name, input.addressLine1 ?? null, input.addressLine2 ?? null,
          input.city ?? null, input.state ?? null, input.pincode ?? null,
          input.contactName ?? null, input.contactPhone ?? null, input.contactEmail ?? null,
          input.notes ?? null,
        ],
      );
      const branchId = rows[0]!.id;
      await writeAudit(tx, {
        userId: actor.id,
        action: AUDIT.BRANCH_CREATED,
        entityType: 'branch',
        entityId: branchId,
        branchId,
        after: input,
      });
      return branchId;
    });

    res.status(201).json({ id });
  }),
);

propertyRouter.patch(
  '/branches/:id',
  requirePermission(PERMISSIONS.BRANCH_WRITE),
  handler(async (req, res) => {
    const actor = currentUser(req);
    const branchId = parse(uuidSchema, req.params.id, 'branch id');
    assertBranchAccess(actor, branchId);
    const input = parse(branchSchema.partial().extend({ status: statusSchema.optional() }), req.body, 'branch');

    await withTransaction(async (tx) => {
      const { rows } = await tx.query('SELECT * FROM branches WHERE id = $1', [branchId]);
      const before = rows[0];
      if (!before) throw notFound('Branch');

      await tx.query(
        `UPDATE branches SET
           code = coalesce($2, code), name = coalesce($3, name),
           address_line1 = coalesce($4, address_line1), address_line2 = coalesce($5, address_line2),
           city = coalesce($6, city), state = coalesce($7, state), pincode = coalesce($8, pincode),
           contact_name = coalesce($9, contact_name), contact_phone = coalesce($10, contact_phone),
           contact_email = coalesce($11, contact_email), notes = coalesce($12, notes),
           status = coalesce($13, status), updated_at = now()
         WHERE id = $1`,
        [
          branchId, input.code ?? null, input.name ?? null, input.addressLine1 ?? null,
          input.addressLine2 ?? null, input.city ?? null, input.state ?? null, input.pincode ?? null,
          input.contactName ?? null, input.contactPhone ?? null, input.contactEmail ?? null,
          input.notes ?? null, input.status ?? null,
        ],
      );

      // Renaming a branch never breaks history: every stay, bill and payment
      // references the branch by id, not by its name.
      await writeAudit(tx, {
        userId: actor.id,
        action: AUDIT.BRANCH_UPDATED,
        entityType: 'branch',
        entityId: branchId,
        branchId,
        before,
        after: input,
      });
    });

    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// Floors
// ---------------------------------------------------------------------------
propertyRouter.get(
  '/branches/:branchId/floors',
  requirePermission(PERMISSIONS.BRANCH_READ),
  handler(async (req, res) => {
    const user = currentUser(req);
    const branchId = parse(uuidSchema, req.params.branchId, 'branch id');
    assertBranchAccess(user, branchId);

    const { rows } = await query(
      `SELECT f.*,
              (SELECT count(*)::int FROM rooms r WHERE r.floor_id = f.id AND r.status = 'active') AS room_count,
              (SELECT coalesce(sum(r.sharing_capacity), 0)::int
                 FROM rooms r WHERE r.floor_id = f.id AND r.status = 'active') AS bed_capacity
         FROM floors f
        WHERE f.branch_id = $1 AND ($2::boolean OR f.status = 'active')
        ORDER BY f.sort_order, f.name`,
      [branchId, req.query.includeInactive === 'true'],
    );
    res.json({ floors: rows });
  }),
);

const floorSchema = z.object({
  code: z.string().min(1).max(32),
  name: z.string().min(1).max(120),
  sortOrder: z.number().int().default(0),
});

propertyRouter.post(
  '/branches/:branchId/floors',
  requirePermission(PERMISSIONS.PROPERTY_WRITE),
  handler(async (req, res) => {
    const actor = currentUser(req);
    const branchId = parse(uuidSchema, req.params.branchId, 'branch id');
    assertBranchAccess(actor, branchId);
    const input = parse(floorSchema, req.body, 'floor');

    const id = await withTransaction(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        'INSERT INTO floors (branch_id, code, name, sort_order) VALUES ($1,$2,$3,$4) RETURNING id',
        [branchId, input.code, input.name, input.sortOrder],
      );
      const floorId = rows[0]!.id;
      await writeAudit(tx, {
        userId: actor.id, action: AUDIT.FLOOR_CREATED, entityType: 'floor',
        entityId: floorId, branchId, after: input,
      });
      return floorId;
    });

    res.status(201).json({ id });
  }),
);

propertyRouter.patch(
  '/floors/:id',
  requirePermission(PERMISSIONS.PROPERTY_WRITE),
  handler(async (req, res) => {
    const actor = currentUser(req);
    const floorId = parse(uuidSchema, req.params.id, 'floor id');
    const input = parse(
      floorSchema.partial().extend({ status: statusSchema.optional() }),
      req.body,
      'floor',
    );

    await withTransaction(async (tx) => {
      const { rows } = await tx.query('SELECT * FROM floors WHERE id = $1', [floorId]);
      const before = rows[0];
      if (!before) throw notFound('Floor');
      assertBranchAccess(actor, before.branch_id as string);

      if (input.status && input.status !== 'active') {
        const { rows: occupied } = await tx.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM tenant_stays
            WHERE floor_id = $1 AND end_date IS NULL AND status = 'active'`,
          [floorId],
        );
        if ((occupied[0]?.count ?? 0) > 0) {
          throw unprocessable(
            'This floor still has tenants in residence. Move or vacate them before deactivating it.',
          );
        }
      }

      await tx.query(
        `UPDATE floors SET code = coalesce($2, code), name = coalesce($3, name),
                sort_order = coalesce($4, sort_order), status = coalesce($5, status),
                updated_at = now()
          WHERE id = $1`,
        [floorId, input.code ?? null, input.name ?? null, input.sortOrder ?? null, input.status ?? null],
      );
      await writeAudit(tx, {
        userId: actor.id, action: AUDIT.FLOOR_UPDATED, entityType: 'floor',
        entityId: floorId, branchId: before.branch_id as string, before, after: input,
      });
    });

    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------
/**
 * Rooms with live occupancy worked out from stay history rather than from a
 * counter that could drift out of step with reality.
 */
propertyRouter.get(
  '/rooms',
  requirePermission(PERMISSIONS.BRANCH_READ),
  handler(async (req, res) => {
    const user = currentUser(req);
    const filters = parse(
      z.object({
        branchId: uuidSchema.optional(),
        floorId: uuidSchema.optional(),
        sharingCapacity: z.coerce.number().int().positive().optional(),
        includeInactive: z.coerce.boolean().default(false),
        asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      }),
      req.query,
      'room filters',
    );
    if (filters.branchId) assertBranchAccess(user, filters.branchId);

    const { rows } = await query(
      `SELECT r.*, f.name AS floor_name, f.sort_order AS floor_sort_order,
              b.name AS branch_name, m.code AS meter_code,
              (SELECT count(*)::int FROM beds bd WHERE bd.room_id = r.id AND bd.status = 'active') AS bed_count,
              occ.occupied_count,
              greatest(r.sharing_capacity - occ.occupied_count, 0) AS vacant_count
         FROM rooms r
         JOIN floors f ON f.id = r.floor_id
         JOIN branches b ON b.id = r.branch_id
         LEFT JOIN eb_meters m ON m.id = r.meter_id
         CROSS JOIN LATERAL (
           SELECT count(*)::int AS occupied_count
             FROM tenant_stays s
            WHERE s.room_id = r.id
              AND s.status <> 'cancelled'
              AND s.start_date <= $5::date
              AND (s.end_date IS NULL OR s.end_date >= $5::date)
         ) occ
        WHERE ($1::uuid IS NULL OR r.branch_id = $1)
          AND ($2::uuid IS NULL OR r.floor_id = $2)
          AND ($3::int IS NULL OR r.sharing_capacity = $3)
          AND ($4::boolean OR r.status = 'active')
          AND ($6::uuid[] IS NULL OR r.branch_id = ANY($6))
        ORDER BY b.name, f.sort_order, r.code`,
      [
        filters.branchId ?? null,
        filters.floorId ?? null,
        filters.sharingCapacity ?? null,
        filters.includeInactive,
        filters.asOf ?? new Date().toISOString().slice(0, 10),
        user.branchIds,
      ],
    );
    res.json({ rooms: rows });
  }),
);

const roomSchema = z.object({
  floorId: uuidSchema,
  code: z.string().min(1).max(40),
  name: z.string().max(120).nullish(),
  /** Any positive number — 1, 2, 6 sharing or anything the business adds later. */
  sharingCapacity: z.number().int().positive().max(50),
  meterId: uuidSchema.nullish(),
  notes: z.string().max(2000).nullish(),
  /** Creates beds 1..N alongside the room. */
  createBeds: z.boolean().default(true),
});

propertyRouter.post(
  '/rooms',
  requirePermission(PERMISSIONS.PROPERTY_WRITE),
  handler(async (req, res) => {
    const actor = currentUser(req);
    const input = parse(roomSchema, req.body, 'room');

    const id = await withTransaction(async (tx) => {
      const { rows: floors } = await tx.query<{ branch_id: string }>(
        'SELECT branch_id FROM floors WHERE id = $1',
        [input.floorId],
      );
      const floor = floors[0];
      if (!floor) throw notFound('Floor');
      assertBranchAccess(actor, floor.branch_id);

      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO rooms (branch_id, floor_id, meter_id, code, name, sharing_capacity, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [
          floor.branch_id, input.floorId, input.meterId ?? null, input.code,
          input.name ?? null, input.sharingCapacity, input.notes ?? null,
        ],
      );
      const roomId = rows[0]!.id;

      if (input.createBeds) {
        for (let index = 1; index <= input.sharingCapacity; index += 1) {
          await tx.query('INSERT INTO beds (room_id, label, sort_order) VALUES ($1,$2,$3)', [
            roomId,
            `Bed ${index}`,
            index,
          ]);
        }
      }

      await writeAudit(tx, {
        userId: actor.id, action: AUDIT.ROOM_CREATED, entityType: 'room',
        entityId: roomId, branchId: floor.branch_id, after: input,
      });
      return roomId;
    });

    res.status(201).json({ id });
  }),
);

propertyRouter.patch(
  '/rooms/:id',
  requirePermission(PERMISSIONS.PROPERTY_WRITE),
  handler(async (req, res) => {
    const actor = currentUser(req);
    const roomId = parse(uuidSchema, req.params.id, 'room id');
    const input = parse(
      roomSchema.partial().omit({ createBeds: true }).extend({ status: statusSchema.optional() }),
      req.body,
      'room',
    );

    await withTransaction(async (tx) => {
      const { rows } = await tx.query('SELECT * FROM rooms WHERE id = $1', [roomId]);
      const before = rows[0];
      if (!before) throw notFound('Room');
      assertBranchAccess(actor, before.branch_id as string);

      const { rows: occupancy } = await tx.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM tenant_stays
          WHERE room_id = $1 AND status <> 'cancelled' AND end_date IS NULL`,
        [roomId],
      );
      const occupied = occupancy[0]?.count ?? 0;

      // Shrinking a room below the number of people already in it would leave
      // the property in a state the rest of the system treats as an exception.
      if (input.sharingCapacity !== undefined && input.sharingCapacity < occupied) {
        throw unprocessable(
          `${occupied} tenant(s) are currently in this room, so its capacity cannot be set to ${input.sharingCapacity}. Move them first.`,
        );
      }
      if (input.status && input.status !== 'active' && occupied > 0) {
        throw unprocessable('This room still has tenants in residence.');
      }

      await tx.query(
        `UPDATE rooms SET
            code = coalesce($2, code), name = coalesce($3, name),
            sharing_capacity = coalesce($4, sharing_capacity),
            meter_id = CASE WHEN $5::boolean THEN $6 ELSE meter_id END,
            notes = coalesce($7, notes), status = coalesce($8, status), updated_at = now()
          WHERE id = $1`,
        [
          roomId, input.code ?? null, input.name ?? null, input.sharingCapacity ?? null,
          input.meterId !== undefined, input.meterId ?? null, input.notes ?? null, input.status ?? null,
        ],
      );

      await writeAudit(tx, {
        userId: actor.id, action: AUDIT.ROOM_UPDATED, entityType: 'room',
        entityId: roomId, branchId: before.branch_id as string, before, after: input,
      });
    });

    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// Beds
// ---------------------------------------------------------------------------
propertyRouter.get(
  '/rooms/:roomId/beds',
  requirePermission(PERMISSIONS.BRANCH_READ),
  handler(async (req, res) => {
    const user = currentUser(req);
    const roomId = parse(uuidSchema, req.params.roomId, 'room id');
    const asOf = (req.query.asOf as string | undefined) ?? new Date().toISOString().slice(0, 10);

    const { rows: roomRows } = await query<{ branch_id: string }>(
      'SELECT branch_id FROM rooms WHERE id = $1',
      [roomId],
    );
    if (!roomRows[0]) throw notFound('Room');
    assertBranchAccess(user, roomRows[0].branch_id);

    const { rows } = await query(
      `SELECT bd.*,
              s.id AS stay_id, s.tenant_id, t.full_name AS tenant_name,
              s.start_date, s.end_date
         FROM beds bd
         LEFT JOIN tenant_stays s
           ON s.bed_id = bd.id AND s.status <> 'cancelled'
          AND s.start_date <= $2::date AND (s.end_date IS NULL OR s.end_date >= $2::date)
         LEFT JOIN tenants t ON t.id = s.tenant_id
        WHERE bd.room_id = $1
        ORDER BY bd.sort_order, bd.label`,
      [roomId, asOf],
    );
    res.json({ beds: rows });
  }),
);

propertyRouter.post(
  '/rooms/:roomId/beds',
  requirePermission(PERMISSIONS.PROPERTY_WRITE),
  handler(async (req, res) => {
    const actor = currentUser(req);
    const roomId = parse(uuidSchema, req.params.roomId, 'room id');
    const input = parse(
      z.object({ label: z.string().min(1).max(40), sortOrder: z.number().int().default(0) }),
      req.body,
      'bed',
    );

    const id = await withTransaction(async (tx) => {
      const { rows: roomRows } = await tx.query<{ branch_id: string; sharing_capacity: number }>(
        'SELECT branch_id, sharing_capacity FROM rooms WHERE id = $1',
        [roomId],
      );
      const room = roomRows[0];
      if (!room) throw notFound('Room');
      assertBranchAccess(actor, room.branch_id);

      const { rows: counts } = await tx.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM beds WHERE room_id = $1 AND status = 'active'",
        [roomId],
      );
      if ((counts[0]?.count ?? 0) >= room.sharing_capacity) {
        throw unprocessable(
          `This room is configured for ${room.sharing_capacity} sharing and already has that many beds. Raise its capacity first.`,
        );
      }

      const { rows } = await tx.query<{ id: string }>(
        'INSERT INTO beds (room_id, label, sort_order) VALUES ($1,$2,$3) RETURNING id',
        [roomId, input.label, input.sortOrder],
      );
      const bedId = rows[0]!.id;
      await writeAudit(tx, {
        userId: actor.id, action: AUDIT.BED_CREATED, entityType: 'bed',
        entityId: bedId, branchId: room.branch_id, after: { roomId, ...input },
      });
      return bedId;
    });

    res.status(201).json({ id });
  }),
);

/**
 * The property tree for one branch: floors, their rooms, and each room's live
 * occupancy. This is what the navigation Branch > Floor > Room is built from.
 */
propertyRouter.get(
  '/branches/:branchId/tree',
  requirePermission(PERMISSIONS.BRANCH_READ),
  handler(async (req, res) => {
    const user = currentUser(req);
    const branchId = parse(uuidSchema, req.params.branchId, 'branch id');
    assertBranchAccess(user, branchId);
    const asOf = (req.query.asOf as string | undefined) ?? new Date().toISOString().slice(0, 10);

    const { rows: branchRows } = await query('SELECT * FROM branches WHERE id = $1', [branchId]);
    if (!branchRows[0]) throw notFound('Branch');

    const { rows: floors } = await query(
      `SELECT * FROM floors WHERE branch_id = $1 AND status = 'active' ORDER BY sort_order, name`,
      [branchId],
    );

    const { rows: rooms } = await query(
      `SELECT r.id, r.floor_id, r.code, r.name, r.sharing_capacity, r.status, r.meter_id,
              m.code AS meter_code, occ.occupied_count,
              greatest(r.sharing_capacity - occ.occupied_count, 0) AS vacant_count
         FROM rooms r
         LEFT JOIN eb_meters m ON m.id = r.meter_id
         CROSS JOIN LATERAL (
           SELECT count(*)::int AS occupied_count FROM tenant_stays s
            WHERE s.room_id = r.id AND s.status <> 'cancelled'
              AND s.start_date <= $2::date AND (s.end_date IS NULL OR s.end_date >= $2::date)
         ) occ
        WHERE r.branch_id = $1 AND r.status = 'active'
        ORDER BY r.code`,
      [branchId, asOf],
    );

    res.json({
      branch: branchRows[0],
      floors: floors.map((floor) => ({
        ...floor,
        rooms: rooms.filter((room) => room.floor_id === floor.id),
      })),
    });
  }),
);
