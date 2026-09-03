import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import bcrypt from 'bcryptjs';
import { pool, withTransaction, type Db } from '../db/pool.js';
import { env } from '../config/env.js';

const run = promisify(execFile);

/**
 * Support for the integration suite.
 *
 * These tests run against a real PostgreSQL database rather than a mock: the
 * behaviour under test — exclusion constraints stopping overlapping stays,
 * transactional rollback, effective-dated price resolution — lives in the
 * database itself, so a fake would prove nothing.
 */

/** Wipes every table, leaving the schema in place. */
export async function resetDatabase(): Promise<void> {
  await pool.query(`
    TRUNCATE
      audit_logs, automation_runs, automation_jobs, whatsapp_messages, message_templates,
      reminder_rules, expenses, maintenance_issues, payment_approvals, payment_proofs,
      payments, payment_qr_configs, bill_calculations, bill_items, bills, eb_calculations,
      billing_periods, eb_readings, charge_rates, price_rules, tenant_documents,
      tenant_stays, tenants, beds, rooms, eb_meters, floors, user_permissions,
      user_branches, branches, users, settings
    RESTART IDENTITY CASCADE
  `);
}

export async function ensureSchema(): Promise<void> {
  // The migration runner is idempotent, so this is safe to call before each run.
  await run('npx', ['tsx', 'src/db/migrate.ts', 'up'], {
    cwd: process.cwd(),
    env: process.env,
  });
}

export type Fixture = {
  adminId: string;
  managerId: string;
  staffId: string;
  branchId: string;
  floorId: string;
  meterId: string;
  rooms: Record<string, { id: string; sharingCapacity: number }>;
};

/**
 * A minimal but realistic property: one branch, one metered floor, and rooms
 * of several sharing sizes, priced from the first of the year.
 */
export async function seedFixture(): Promise<Fixture> {
  return withTransaction(async (tx) => {
    const hash = await bcrypt.hash('test-password', env.BCRYPT_ROUNDS);

    const users: Record<string, string> = {};
    for (const [role, email] of [
      ['admin', 'admin@test.local'],
      ['manager', 'manager@test.local'],
      ['staff', 'staff@test.local'],
    ] as const) {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO users (email, full_name, password_hash, role)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [email, `Test ${role}`, hash, role],
      );
      users[role] = rows[0]!.id;
    }

    const { rows: branchRows } = await tx.query<{ id: string }>(
      `INSERT INTO branches (code, name) VALUES ('TST', 'Test Branch') RETURNING id`,
    );
    const branchId = branchRows[0]!.id;

    const { rows: floorRows } = await tx.query<{ id: string }>(
      `INSERT INTO floors (branch_id, code, name, sort_order)
       VALUES ($1, 'GF', 'Ground Floor', 0) RETURNING id`,
      [branchId],
    );
    const floorId = floorRows[0]!.id;

    const { rows: meterRows } = await tx.query<{ id: string }>(
      `INSERT INTO eb_meters (branch_id, floor_id, code, label, scope)
       VALUES ($1, $2, 'MTR-GF', 'Ground Floor', 'floor') RETURNING id`,
      [branchId, floorId],
    );
    const meterId = meterRows[0]!.id;

    const rooms: Fixture['rooms'] = {};
    for (const [code, capacity] of [
      ['GF-6S-01', 6],
      ['GF-5S-01', 5],
      ['GF-3S-01', 3],
      ['GF-1S-01', 1],
    ] as const) {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO rooms (branch_id, floor_id, meter_id, code, sharing_capacity)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [branchId, floorId, meterId, code, capacity],
      );
      rooms[code] = { id: rows[0]!.id, sharingCapacity: capacity };
      for (let index = 1; index <= capacity; index += 1) {
        await tx.query('INSERT INTO beds (room_id, label, sort_order) VALUES ($1,$2,$3)', [
          rows[0]!.id,
          `Bed ${index}`,
          index,
        ]);
      }
    }

    for (const [capacity, rent] of [
      [1, 1_200_000],
      [3, 800_000],
      [5, 700_000],
      [6, 600_000],
    ] as const) {
      await tx.query(
        // Backdated so a test can admit a tenant on any date it likes.
        `INSERT INTO price_rules (sharing_capacity, monthly_rent_paise, effective_from, created_by)
         VALUES ($1,$2,'2019-01-01',$3)`,
        [capacity, rent, users.admin],
      );
    }

    await tx.query(
      `INSERT INTO charge_rates (charge, value_paise, effective_from, created_by)
       VALUES ('eb_rate', 1250, '2019-01-01', $1), ('common_charge', 15000, '2019-01-01', $1)`,
      [users.admin],
    );

    return {
      adminId: users.admin!,
      managerId: users.manager!,
      staffId: users.staff!,
      branchId,
      floorId,
      meterId,
      rooms,
    };
  });
}

/** Creates a tenant without placing them in a room. */
export async function createTenant(
  tx: Db,
  code: string,
  name: string,
  joiningDate: string,
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO tenants (tenant_code, full_name, phone, joining_date)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [code, name, `98400000${code.slice(-2)}`, joiningDate],
  );
  return rows[0]!.id;
}

export async function recordReading(
  tx: Db,
  meterId: string,
  periodMonth: string,
  previous: number,
  current: number,
): Promise<void> {
  await tx.query(
    `INSERT INTO eb_readings
       (meter_id, period_month, reading_date, previous_reading, current_reading, eb_rate_paise)
     VALUES ($1,$2,$3,$4,$5,1250)
     ON CONFLICT (meter_id, period_month) DO UPDATE SET
       previous_reading = EXCLUDED.previous_reading,
       current_reading = EXCLUDED.current_reading`,
    [meterId, periodMonth, `${periodMonth.slice(0, 8)}28`, previous, current],
  );
}

export async function closePool(): Promise<void> {
  await pool.end();
}
