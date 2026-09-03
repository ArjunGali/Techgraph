import type { Db } from '../../db/pool.js';
import { notFound, unprocessable } from '../../lib/errors.js';
import { AUDIT, writeAudit } from '../../lib/audit.js';
import { requirePrice } from '../pricing/pricing.service.js';

/**
 * Admission, movement and vacating.
 *
 * The one rule everything here exists to uphold: a tenant's location is never
 * edited. Moving someone closes their current stay with an end date and opens
 * a new one, so the record of where they were on any past date survives, and
 * every bill that depends on it stays reproducible.
 */

export type StayContext = {
  userId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
};

type RoomRow = {
  id: string;
  branch_id: string;
  floor_id: string;
  code: string;
  sharing_capacity: number;
  status: string;
};

async function loadRoom(tx: Db, roomId: string): Promise<RoomRow> {
  const { rows } = await tx.query<RoomRow>(
    'SELECT id, branch_id, floor_id, code, sharing_capacity, status FROM rooms WHERE id = $1',
    [roomId],
  );
  const room = rows[0];
  if (!room) throw notFound('Room');
  if (room.status !== 'active') throw unprocessable(`Room ${room.code} is not active`);
  return room;
}

/**
 * Refuses to put more people in a room than it is configured to sleep.
 *
 * Counts everyone whose stay overlaps the new one rather than only today's
 * occupants, so booking a bed for next month cannot quietly overfill the room.
 */
async function assertRoomHasSpace(
  tx: Db,
  room: RoomRow,
  startDate: string,
  endDate: string | null,
  excludeStayId?: string,
): Promise<void> {
  const { rows } = await tx.query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM tenant_stays
      WHERE room_id = $1
        AND status <> 'cancelled'
        AND ($4::uuid IS NULL OR id <> $4)
        AND daterange(start_date, end_date, '[]') && daterange($2::date, $3::date, '[]')`,
    [room.id, startDate, endDate, excludeStayId ?? null],
  );
  const overlapping = rows[0]?.count ?? 0;
  if (overlapping >= room.sharing_capacity) {
    throw unprocessable(
      `Room ${room.code} is ${room.sharing_capacity} sharing and is already full for those dates.`,
    );
  }
}

/** Picks a bed with no conflicting stay, so bed assignment needs no manual tracking. */
async function pickFreeBed(
  tx: Db,
  roomId: string,
  startDate: string,
  endDate: string | null,
): Promise<string | null> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT bd.id
       FROM beds bd
      WHERE bd.room_id = $1 AND bd.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM tenant_stays s
           WHERE s.bed_id = bd.id AND s.status <> 'cancelled'
             AND daterange(s.start_date, s.end_date, '[]') && daterange($2::date, $3::date, '[]')
        )
      ORDER BY bd.sort_order, bd.label
      LIMIT 1`,
    [roomId, startDate, endDate],
  );
  return rows[0]?.id ?? null;
}

export type AdmitInput = {
  tenantId: string;
  roomId: string;
  startDate: string;
  bedId?: string | null;
  /** Overrides the resolved price. Recorded on the stay, so history is explicit. */
  monthlyRentPaise?: number;
  moveReason?: string | null;
};

/** Places a tenant into a room from `startDate`, opening their first stay. */
export async function admitTenant(
  tx: Db,
  input: AdmitInput,
  context: StayContext,
): Promise<{ stayId: string; monthlyRentPaise: number }> {
  const room = await loadRoom(tx, input.roomId);
  await assertRoomHasSpace(tx, room, input.startDate, null);

  const price = await requirePrice(tx, {
    branchId: room.branch_id,
    roomId: room.id,
    sharingCapacity: room.sharing_capacity,
    onDate: input.startDate,
  });
  const monthlyRentPaise = input.monthlyRentPaise ?? price.monthlyRentPaise;
  const bedId = input.bedId ?? (await pickFreeBed(tx, room.id, input.startDate, null));

  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO tenant_stays
       (tenant_id, branch_id, floor_id, room_id, bed_id, start_date, sharing_capacity,
        monthly_rent_paise, price_rule_id, status, move_reason, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10,$11)
     RETURNING id`,
    [
      input.tenantId, room.branch_id, room.floor_id, room.id, bedId, input.startDate,
      room.sharing_capacity, monthlyRentPaise, price.priceRuleId, input.moveReason ?? null,
      context.userId,
    ],
  );

  return { stayId: rows[0]!.id, monthlyRentPaise };
}

export type MoveInput = {
  tenantId: string;
  toRoomId: string;
  /** First day in the new room. The old stay is closed the day before. */
  effectiveDate: string;
  bedId?: string | null;
  monthlyRentPaise?: number;
  reason?: string | null;
};

/**
 * Moves a tenant to another room.
 *
 * The previous stay is closed on the day before the move and a new one opens
 * on the effective date, so the two periods meet exactly: no day is counted
 * twice and none is lost. Billing for the month then charges each period at
 * its own rate automatically.
 */
export async function moveTenant(
  tx: Db,
  input: MoveInput,
  context: StayContext,
): Promise<{ previousStayId: string; stayId: string }> {
  const { rows: currentRows } = await tx.query<{
    id: string;
    room_id: string;
    start_date: string;
    branch_id: string;
  }>(
    `SELECT id, room_id, start_date, branch_id
       FROM tenant_stays
      WHERE tenant_id = $1 AND status = 'active' AND end_date IS NULL
      ORDER BY start_date DESC
      LIMIT 1`,
    [input.tenantId],
  );
  const current = currentRows[0];
  if (!current) {
    throw unprocessable('This tenant has no open stay to move from. Admit them to a room first.');
  }
  if (current.room_id === input.toRoomId) {
    throw unprocessable('The tenant is already in that room.');
  }
  if (input.effectiveDate <= current.start_date) {
    throw unprocessable(
      `The move must be after the current stay began (${current.start_date}).`,
    );
  }

  const room = await loadRoom(tx, input.toRoomId);
  await assertRoomHasSpace(tx, room, input.effectiveDate, null);

  // Close the outgoing stay the day before the move takes effect.
  const { rows: closed } = await tx.query<{ end_date: string }>(
    `UPDATE tenant_stays
        SET end_date = ($2::date - INTERVAL '1 day')::date,
            status = 'ended',
            ended_reason = 'moved',
            updated_at = now()
      WHERE id = $1
      RETURNING end_date`,
    [current.id, input.effectiveDate],
  );

  const price = await requirePrice(tx, {
    branchId: room.branch_id,
    roomId: room.id,
    sharingCapacity: room.sharing_capacity,
    onDate: input.effectiveDate,
  });
  const monthlyRentPaise = input.monthlyRentPaise ?? price.monthlyRentPaise;
  const bedId = input.bedId ?? (await pickFreeBed(tx, room.id, input.effectiveDate, null));

  const { rows: created } = await tx.query<{ id: string }>(
    `INSERT INTO tenant_stays
       (tenant_id, branch_id, floor_id, room_id, bed_id, start_date, sharing_capacity,
        monthly_rent_paise, price_rule_id, status, move_reason, previous_stay_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10,$11,$12)
     RETURNING id`,
    [
      input.tenantId, room.branch_id, room.floor_id, room.id, bedId, input.effectiveDate,
      room.sharing_capacity, monthlyRentPaise, price.priceRuleId, input.reason ?? null,
      current.id, context.userId,
    ],
  );

  await writeAudit(tx, {
    userId: context.userId,
    action: AUDIT.TENANT_MOVED,
    entityType: 'tenant',
    entityId: input.tenantId,
    branchId: room.branch_id,
    before: { stayId: current.id, roomId: current.room_id, endedOn: closed[0]?.end_date },
    after: {
      stayId: created[0]!.id,
      roomId: room.id,
      roomCode: room.code,
      startDate: input.effectiveDate,
      monthlyRentPaise,
    },
    meta: { reason: input.reason ?? null },
    ipAddress: context.ipAddress ?? null,
    userAgent: context.userAgent ?? null,
  });

  return { previousStayId: current.id, stayId: created[0]!.id };
}

export type VacateInput = {
  tenantId: string;
  /** Last day of residence, inclusive. */
  lastDate: string;
  reason?: string | null;
};

/** Ends a tenant's stay and marks them vacated, leaving the history intact. */
export async function vacateTenant(
  tx: Db,
  input: VacateInput,
  context: StayContext,
): Promise<{ stayId: string }> {
  const { rows } = await tx.query<{ id: string; start_date: string; branch_id: string }>(
    `SELECT id, start_date, branch_id FROM tenant_stays
      WHERE tenant_id = $1 AND status = 'active' AND end_date IS NULL
      ORDER BY start_date DESC LIMIT 1`,
    [input.tenantId],
  );
  const current = rows[0];
  if (!current) throw unprocessable('This tenant has no open stay to close.');
  if (input.lastDate < current.start_date) {
    throw unprocessable(`The last day cannot be before the stay began (${current.start_date}).`);
  }

  await tx.query(
    `UPDATE tenant_stays
        SET end_date = $2, status = 'ended', ended_reason = coalesce($3, 'vacated'), updated_at = now()
      WHERE id = $1`,
    [current.id, input.lastDate, input.reason ?? null],
  );

  await tx.query(
    `UPDATE tenants SET status = 'vacated', exit_date = $2, updated_at = now() WHERE id = $1`,
    [input.tenantId, input.lastDate],
  );

  await writeAudit(tx, {
    userId: context.userId,
    action: AUDIT.TENANT_VACATED,
    entityType: 'tenant',
    entityId: input.tenantId,
    branchId: current.branch_id,
    before: { stayId: current.id, endDate: null },
    after: { stayId: current.id, endDate: input.lastDate, reason: input.reason ?? null },
    ipAddress: context.ipAddress ?? null,
    userAgent: context.userAgent ?? null,
  });

  return { stayId: current.id };
}
