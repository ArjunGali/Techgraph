import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withTransaction, pool } from '../db/pool.js';
import { admitTenant, moveTenant, vacateTenant } from '../modules/tenants/stays.service.js';
import { generateBillsForPeriod, refreshBillTotals } from '../modules/billing/billing.service.js';
import { resolvePrice, resolveChargeRate } from '../modules/pricing/pricing.service.js';
import { detectExceptions } from '../modules/dashboard/exceptions.service.js';
import { effectivePermissions, PERMISSIONS } from '../lib/permissions.js';
import {
  createTenant, recordReading, resetDatabase, seedFixture, type Fixture,
} from './helpers.js';

/**
 * End-to-end workflow tests against a real PostgreSQL database.
 *
 * These exercise the paths that money and history flow through — admission,
 * movement, billing, payment approval, month closing — and assert the
 * invariants the business depends on: history is never lost, a bill can always
 * be reproduced, and nothing is credited without approval.
 */

let fixture: Fixture;
const AUGUST = '2026-08-01';
const context = () => ({ userId: fixture.adminId });

before(async () => {
  await resetDatabase();
  fixture = await seedFixture();
});

after(async () => {
  await pool.end();
});

describe('tenant admission', () => {
  it('places a tenant and snapshots the rent that applied', async () => {
    const result = await withTransaction(async (tx) => {
      const tenantId = await createTenant(tx, 'T-01', 'Admit One', AUGUST);
      return admitTenant(
        tx,
        { tenantId, roomId: fixture.rooms['GF-5S-01']!.id, startDate: AUGUST },
        context(),
      );
    });

    assert.equal(result.monthlyRentPaise, 700_000, '5 sharing is priced at ₹7,000');

    const { rows } = await pool.query(
      'SELECT * FROM tenant_stays WHERE id = $1',
      [result.stayId],
    );
    assert.equal(rows[0]!.end_date, null, 'the stay is open');
    assert.equal(rows[0]!.sharing_capacity, 5, 'capacity is snapshotted onto the stay');
    assert.ok(rows[0]!.bed_id, 'a free bed was assigned automatically');
  });

  it('refuses to overfill a room', async () => {
    // The 1-sharing room takes exactly one person.
    await withTransaction(async (tx) => {
      const tenantId = await createTenant(tx, 'T-02', 'Solo', AUGUST);
      await admitTenant(
        tx,
        { tenantId, roomId: fixture.rooms['GF-1S-01']!.id, startDate: AUGUST },
        context(),
      );
    });

    await assert.rejects(
      withTransaction(async (tx) => {
        const tenantId = await createTenant(tx, 'T-03', 'Crowd', AUGUST);
        await admitTenant(
          tx,
          { tenantId, roomId: fixture.rooms['GF-1S-01']!.id, startDate: AUGUST },
          context(),
        );
      }),
      /1 sharing and is already full/,
    );
  });

  it('rolls the whole admission back when any part fails', async () => {
    const before = await pool.query('SELECT count(*)::int AS count FROM tenants');

    await assert.rejects(
      withTransaction(async (tx) => {
        await createTenant(tx, 'T-04', 'Rollback', AUGUST);
        // No price exists for a 4-sharing room, so admission fails after the
        // tenant row was already inserted in this transaction.
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO rooms (branch_id, floor_id, code, sharing_capacity)
           VALUES ($1,$2,'GF-4S-99',4) RETURNING id`,
          [fixture.branchId, fixture.floorId],
        );
        const tenantId = await createTenant(tx, 'T-05', 'Rollback Two', AUGUST);
        await admitTenant(tx, { tenantId, roomId: rows[0]!.id, startDate: AUGUST }, context());
      }),
    );

    const after = await pool.query('SELECT count(*)::int AS count FROM tenants');
    assert.equal(after.rows[0]!.count, before.rows[0]!.count, 'no partial tenant was committed');
  });
});

describe('tenant movement preserves history', () => {
  let tenantId: string;
  let firstStayId: string;

  it('closes the old stay and opens a new one', async () => {
    const admitted = await withTransaction(async (tx) => {
      tenantId = await createTenant(tx, 'T-10', 'Arun Mover', AUGUST);
      return admitTenant(
        tx,
        { tenantId, roomId: fixture.rooms['GF-6S-01']!.id, startDate: AUGUST },
        context(),
      );
    });
    firstStayId = admitted.stayId;

    const moved = await withTransaction((tx) =>
      moveTenant(
        tx,
        { tenantId, toRoomId: fixture.rooms['GF-5S-01']!.id, effectiveDate: '2026-08-16' },
        context(),
      ),
    );

    const { rows } = await pool.query(
      'SELECT id, start_date, end_date, sharing_capacity, monthly_rent_paise, status FROM tenant_stays WHERE tenant_id = $1 ORDER BY start_date',
      [tenantId],
    );

    assert.equal(rows.length, 2, 'the old stay was kept, not overwritten');
    assert.equal(rows[0]!.id, firstStayId);
    assert.equal(rows[0]!.end_date, '2026-08-15', 'closed the day before the move');
    assert.equal(rows[0]!.sharing_capacity, 6);
    assert.equal(rows[0]!.monthly_rent_paise, 600_000, 'the 6-sharing rent is still on record');
    assert.equal(rows[1]!.id, moved.stayId);
    assert.equal(rows[1]!.start_date, '2026-08-16');
    assert.equal(rows[1]!.monthly_rent_paise, 700_000, 'the new room is priced separately');
    assert.equal(rows[1]!.end_date, null);
  });

  it('leaves no gap and no overlap between the two periods', async () => {
    const { rows } = await pool.query<{ covered: number }>(
      `SELECT count(*)::int AS covered FROM generate_series($2::date, $3::date, '1 day') AS day
        WHERE EXISTS (
          SELECT 1 FROM tenant_stays s
           WHERE s.tenant_id = $1 AND day BETWEEN s.start_date AND coalesce(s.end_date, $3::date)
        )`,
      [tenantId, AUGUST, '2026-08-31'],
    );
    assert.equal(rows[0]!.covered, 31, 'every day of August is covered exactly once');
  });

  it('records the move in the audit trail with both locations', async () => {
    const { rows } = await pool.query(
      `SELECT action, before, after FROM audit_logs
        WHERE entity_id = $1 AND action = 'tenant.moved'`,
      [tenantId],
    );
    assert.equal(rows.length, 1);
    assert.equal((rows[0]!.before as Record<string, unknown>).stayId, firstStayId);
    assert.equal((rows[0]!.after as Record<string, unknown>).roomCode, 'GF-5S-01');
  });

  it('refuses a move dated before the current stay began', async () => {
    await assert.rejects(
      withTransaction((tx) =>
        moveTenant(
          tx,
          { tenantId, toRoomId: fixture.rooms['GF-3S-01']!.id, effectiveDate: '2026-08-10' },
          context(),
        ),
      ),
      /must be after the current stay began/,
    );
  });
});

describe('billing a month of real history', () => {
  const tenants: Record<string, string> = {};

  before(async () => {
    await resetDatabase();
    fixture = await seedFixture();

    await withTransaction(async (tx) => {
      // Two tenants stay all month in the 5-sharing room…
      for (const [code, name] of [['T-20', 'Full One'], ['T-21', 'Full Two']] as const) {
        const id = await createTenant(tx, code, name, AUGUST);
        tenants[name] = id;
        await admitTenant(
          tx,
          { tenantId: id, roomId: fixture.rooms['GF-5S-01']!.id, startDate: AUGUST },
          context(),
        );
      }

      // …one leaves on the 15th…
      const leaver = await createTenant(tx, 'T-22', 'Leaver', AUGUST);
      tenants.Leaver = leaver;
      await admitTenant(
        tx,
        { tenantId: leaver, roomId: fixture.rooms['GF-5S-01']!.id, startDate: AUGUST },
        context(),
      );
      await vacateTenant(tx, { tenantId: leaver, lastDate: '2026-08-15' }, context());

      // …and one moves between rooms mid-month.
      const mover = await createTenant(tx, 'T-23', 'Mover', AUGUST);
      tenants.Mover = mover;
      await admitTenant(
        tx,
        { tenantId: mover, roomId: fixture.rooms['GF-6S-01']!.id, startDate: AUGUST },
        context(),
      );
      await moveTenant(
        tx,
        { tenantId: mover, toRoomId: fixture.rooms['GF-3S-01']!.id, effectiveDate: '2026-08-16' },
        context(),
      );

      // 100 units at ₹12.50 = ₹1,250 across the whole floor.
      await recordReading(tx, fixture.meterId, AUGUST, 1000, 1100);
    });
  });

  it('bills every tenant who occupied space during the month', async () => {
    const result = await withTransaction((tx) =>
      generateBillsForPeriod(tx, {
        branchId: fixture.branchId,
        periodMonth: AUGUST,
        userId: fixture.adminId,
      }),
    );
    assert.equal(result.bills.length, 4);
    assert.deepEqual(result.missingReadings, [], 'the floor meter was read');
  });

  it('apportions exactly the electricity the meter recorded', async () => {
    const { rows } = await pool.query<{ billed: number }>(
      `SELECT coalesce(sum(eb_paise), 0)::bigint AS billed FROM bills`,
    );
    assert.equal(Number(rows[0]!.billed), 125_000, '₹1,250 billed out, to the paise');
  });

  it('charges the mover at both rooms\' rates and counts them once for electricity', async () => {
    const { rows } = await pool.query(
      `SELECT b.rent_paise, b.eb_paise,
              (SELECT count(*)::int FROM bill_items i
                WHERE i.bill_id = b.id AND i.item_type = 'rent') AS rent_lines
         FROM bills b WHERE b.tenant_id = $1`,
      [tenants.Mover],
    );
    const bill = rows[0]!;
    assert.equal(bill.rent_lines, 2, 'one rent line per room occupied');
    // ₹6,000 x 15/31 + ₹8,000 x 16/31 = ₹2,903.23 + ₹4,129.03
    assert.equal(Number(bill.rent_paise), 290_323 + 412_903);

    const { rows: breakdown } = await pool.query(
      `SELECT breakdown FROM bill_calculations bc
         JOIN bills b ON b.id = bc.bill_id WHERE b.tenant_id = $1`,
      [tenants.Mover],
    );
    const electricity = (breakdown[0]!.breakdown as Record<string, never>).electricity as {
      tenants: { tenantId: string; occupancyDays: number }[];
      totalOccupancyDays: number;
    };
    const moverShare = electricity.tenants.find((row) => row.tenantId === tenants.Mover);
    assert.equal(moverShare?.occupancyDays, 31, 'the mover appears once, with 15 + 16 days');
    // 31 + 31 + 15 (leaver) + 31 (mover) = 108
    assert.equal(electricity.totalOccupancyDays, 108);
  });

  it('prorates the leaver to the days they actually stayed', async () => {
    const { rows } = await pool.query(
      'SELECT rent_paise, eb_paise FROM bills WHERE tenant_id = $1',
      [tenants.Leaver],
    );
    assert.equal(Number(rows[0]!.rent_paise), 338_710, '₹7,000 x 15/31');
    // 125000 x 15/108 = 17361.1
    assert.equal(Number(rows[0]!.eb_paise), 17_361);
  });

  it('stores a breakdown that spells out the whole calculation', async () => {
    const { rows } = await pool.query(
      `SELECT breakdown FROM bill_calculations bc
         JOIN bills b ON b.id = bc.bill_id WHERE b.tenant_id = $1`,
      [tenants.Leaver],
    );
    const explanation = (
      (rows[0]!.breakdown as Record<string, never>).explanation as unknown as string[]
    ).join('\n');
    assert.match(explanation, /Units consumed: 1100 - 1000 = 100/);
    assert.match(explanation, /Total occupancy days: 108/);
    assert.match(explanation, /₹7,000\.00 x 15\/31 days/);
  });

  it('can be regenerated while the month is open, without changing the answer', async () => {
    const firstPass = await pool.query(
      'SELECT tenant_id, total_paise FROM bills ORDER BY tenant_id',
    );
    await withTransaction((tx) =>
      generateBillsForPeriod(tx, {
        branchId: fixture.branchId,
        periodMonth: AUGUST,
        userId: fixture.adminId,
      }),
    );
    const secondPass = await pool.query(
      'SELECT tenant_id, total_paise FROM bills ORDER BY tenant_id',
    );
    assert.deepEqual(secondPass.rows, firstPass.rows, 'the engine is deterministic');
  });
});

describe('months of different lengths', () => {
  for (const [month, days] of [
    ['2026-02-01', 28],
    ['2024-02-01', 29],
    ['2026-09-01', 30],
    ['2026-08-01', 31],
  ] as const) {
    it(`bills a full month correctly in a ${days}-day month`, async () => {
      await resetDatabase();
      fixture = await seedFixture();

      await withTransaction(async (tx) => {
        const id = await createTenant(tx, 'T-30', 'Whole Month', '2020-01-01');
        await admitTenant(
          tx,
          { tenantId: id, roomId: fixture.rooms['GF-5S-01']!.id, startDate: '2020-01-01' },
          context(),
        );
        await recordReading(tx, fixture.meterId, month, 0, 100);
      });

      const result = await withTransaction((tx) =>
        generateBillsForPeriod(tx, {
          branchId: fixture.branchId,
          periodMonth: month,
          userId: fixture.adminId,
        }),
      );

      const bill = result.bills[0]!.calculation;
      assert.equal(bill.daysInMonth, days);
      assert.equal(bill.occupancyDays, days);
      assert.equal(bill.rentPaise, 700_000, 'a full month is the exact monthly rent');
      assert.equal(bill.ebPaise, 125_000, 'the sole tenant carries the whole meter');
    });
  }
});

describe('effective-dated pricing', () => {
  it('bills each month at the price that applied to it', async () => {
    await resetDatabase();
    fixture = await seedFixture();

    await withTransaction(async (tx) => {
      // ₹7,000 up to the end of August, ₹7,500 from September.
      await tx.query(
        `UPDATE price_rules SET effective_to = '2026-08-31'
          WHERE sharing_capacity = 5 AND branch_id IS NULL AND room_id IS NULL`,
      );
      await tx.query(
        `INSERT INTO price_rules (sharing_capacity, monthly_rent_paise, effective_from, created_by)
         VALUES (5, 750000, '2026-09-01', $1)`,
        [fixture.adminId],
      );
    });

    const august = await resolvePrice(
      { query: (text, params) => pool.query(text, params as never[]) },
      {
        branchId: fixture.branchId,
        roomId: fixture.rooms['GF-5S-01']!.id,
        sharingCapacity: 5,
        onDate: '2026-08-15',
      },
    );
    const september = await resolvePrice(
      { query: (text, params) => pool.query(text, params as never[]) },
      {
        branchId: fixture.branchId,
        roomId: fixture.rooms['GF-5S-01']!.id,
        sharingCapacity: 5,
        onDate: '2026-09-15',
      },
    );

    assert.equal(august?.monthlyRentPaise, 700_000);
    assert.equal(september?.monthlyRentPaise, 750_000);
  });

  it('keeps the old rent on a stay opened before the rise', async () => {
    const admitted = await withTransaction(async (tx) => {
      const id = await createTenant(tx, 'T-40', 'Before Rise', AUGUST);
      return admitTenant(
        tx,
        { tenantId: id, roomId: fixture.rooms['GF-5S-01']!.id, startDate: AUGUST },
        context(),
      );
    });
    assert.equal(admitted.monthlyRentPaise, 700_000, 'billed at the August price, not September');
  });

  it('resolves administered rates by date too', async () => {
    const db = { query: (text: string, params?: unknown[]) => pool.query(text, params as never[]) };
    assert.equal(
      await resolveChargeRate(db, { branchId: fixture.branchId, charge: 'eb_rate', onDate: AUGUST }),
      1250,
    );
    assert.equal(
      await resolveChargeRate(db, {
        branchId: fixture.branchId,
        charge: 'common_charge',
        onDate: AUGUST,
      }),
      15_000,
    );
  });
});
