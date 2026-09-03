import bcrypt from 'bcryptjs';
import { env } from '../../config/env.js';
import { closePool, withTransaction, type Db } from '../pool.js';
import {
  ALANDUR, AUTOMATION_JOBS, BRANCHES, COMMON_CHARGE_PAISE, EB_RATE_PAISE,
  EKKATUTHANGAL, MESSAGE_TEMPLATES, REMINDER_RULES, SHARING_PRICES,
  type BranchSeed,
} from './data.js';

/**
 * Seeds a fresh database with the business as it stands: the two branches,
 * their floors and rooms, opening prices, the administered rates, the message
 * templates and the automation schedule.
 *
 * Idempotent — every insert either creates the row or leaves the existing one
 * alone, so re-running it after adding a branch does not disturb live data.
 * Pass `--demo` to add sample tenants, readings and a billing month for
 * walking through the app.
 */

const DEMO = process.argv.includes('--demo');
/** Prices and rates take effect from the start of the seeding year. */
const EFFECTIVE_FROM = `${new Date().getFullYear()}-01-01`;

async function seedUsers(tx: Db): Promise<string> {
  const password = process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe!2026';
  const hash = await bcrypt.hash(password, env.BCRYPT_ROUNDS);

  const accounts = [
    { email: 'admin@pgmanagement.local', name: 'PG Owner', role: 'admin' },
    { email: 'manager@pgmanagement.local', name: 'Branch Manager', role: 'manager' },
    { email: 'staff@pgmanagement.local', name: 'Front Desk', role: 'staff' },
  ];

  let adminId = '';
  for (const account of accounts) {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO users (email, full_name, password_hash, role)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (lower(email)) DO UPDATE SET full_name = EXCLUDED.full_name
       RETURNING id`,
      [account.email, account.name, hash, account.role],
    );
    if (account.role === 'admin') adminId = rows[0]!.id;
  }

  console.log(`  users: admin@pgmanagement.local / ${password}`);
  return adminId;
}

async function seedBranch(tx: Db, seed: BranchSeed, adminId: string): Promise<string> {
  const { rows: branchRows } = await tx.query<{ id: string }>(
    `INSERT INTO branches (code, name, address_line1, city, state, pincode, contact_name, contact_phone)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (lower(code)) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [
      seed.code, seed.name, seed.addressLine1 ?? null, seed.city ?? null, seed.state ?? null,
      seed.pincode ?? null, seed.contactName ?? null, seed.contactPhone ?? null,
    ],
  );
  const branchId = branchRows[0]!.id;

  let roomCount = 0;
  let bedCount = 0;

  for (const floorSeed of seed.floors) {
    const { rows: floorRows } = await tx.query<{ id: string }>(
      `INSERT INTO floors (branch_id, code, name, sort_order)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (branch_id, lower(code)) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [branchId, floorSeed.code, floorSeed.name, floorSeed.sortOrder],
    );
    const floorId = floorRows[0]!.id;

    let meterId: string | null = null;
    if (floorSeed.meterCode) {
      const { rows: meterRows } = await tx.query<{ id: string }>(
        `INSERT INTO eb_meters (branch_id, floor_id, code, label, scope)
         VALUES ($1,$2,$3,$4,'floor')
         ON CONFLICT (branch_id, lower(code)) DO UPDATE SET label = EXCLUDED.label
         RETURNING id`,
        [branchId, floorId, floorSeed.meterCode, `${seed.name} — ${floorSeed.name}`],
      );
      meterId = meterRows[0]!.id;
    }

    for (const roomSeed of floorSeed.rooms) {
      const { rows: roomRows } = await tx.query<{ id: string }>(
        `INSERT INTO rooms (branch_id, floor_id, meter_id, code, name, sharing_capacity)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (branch_id, lower(code)) DO UPDATE SET
           sharing_capacity = EXCLUDED.sharing_capacity, meter_id = EXCLUDED.meter_id
         RETURNING id`,
        [
          branchId, floorId, meterId, roomSeed.code,
          roomSeed.name ?? `${roomSeed.sharingCapacity} Sharing`, roomSeed.sharingCapacity,
        ],
      );
      const roomId = roomRows[0]!.id;
      roomCount += 1;

      // One bed per place in the room, so bed-level occupancy works from day one.
      for (let index = 1; index <= roomSeed.sharingCapacity; index += 1) {
        await tx.query(
          `INSERT INTO beds (room_id, label, sort_order) VALUES ($1,$2,$3)
           ON CONFLICT (room_id, lower(label)) DO NOTHING`,
          [roomId, `Bed ${index}`, index],
        );
        bedCount += 1;
      }
    }
  }

  console.log(
    `  ${seed.name}: ${seed.floors.length} floor(s), ${roomCount} room(s), ${bedCount} bed(s)`,
  );

  await tx.query(
    `INSERT INTO user_branches (user_id, branch_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [adminId, branchId],
  );

  return branchId;
}

async function seedPricing(tx: Db, adminId: string): Promise<void> {
  for (const price of SHARING_PRICES) {
    await tx.query(
      `INSERT INTO price_rules (sharing_capacity, monthly_rent_paise, effective_from, note, created_by)
       SELECT $1, $2, $3, 'Opening price', $4
        WHERE NOT EXISTS (
          SELECT 1 FROM price_rules
           WHERE sharing_capacity = $1 AND branch_id IS NULL AND room_id IS NULL
        )`,
      [price.sharingCapacity, price.monthlyRentPaise, EFFECTIVE_FROM, adminId],
    );
  }

  for (const rate of [
    { charge: 'eb_rate', value: EB_RATE_PAISE },
    { charge: 'common_charge', value: COMMON_CHARGE_PAISE },
  ]) {
    await tx.query(
      `INSERT INTO charge_rates (charge, value_paise, effective_from, note, created_by)
       SELECT $1::charge_type, $2, $3, 'Opening rate', $4
        WHERE NOT EXISTS (
          SELECT 1 FROM charge_rates WHERE charge = $1::charge_type AND branch_id IS NULL
        )`,
      [rate.charge, rate.value, EFFECTIVE_FROM, adminId],
    );
  }

  console.log(
    `  pricing: ${SHARING_PRICES.length} sharing prices, EB ₹${EB_RATE_PAISE / 100}/unit, ` +
      `common charge ₹${COMMON_CHARGE_PAISE / 100}`,
  );
}

async function seedMessagingAndAutomation(tx: Db): Promise<void> {
  for (const template of MESSAGE_TEMPLATES) {
    await tx.query(
      `INSERT INTO message_templates (code, name, body) VALUES ($1,$2,$3)
       ON CONFLICT (lower(code)) DO NOTHING`,
      [template.code, template.name, template.body],
    );
  }

  for (const rule of REMINDER_RULES) {
    await tx.query(
      `INSERT INTO reminder_rules (day_of_month, template_code, label) VALUES ($1,$2,$3)
       ON CONFLICT (coalesce(branch_id::text, 'default'), day_of_month) DO NOTHING`,
      [rule.dayOfMonth, rule.templateCode, rule.label],
    );
  }

  for (const job of AUTOMATION_JOBS) {
    await tx.query(
      `INSERT INTO automation_jobs (code, name, description, schedule_cron)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (lower(code)) DO UPDATE SET
         name = EXCLUDED.name, description = EXCLUDED.description`,
      [job.code, job.name, job.description, job.scheduleCron],
    );
  }

  await tx.query(
    `INSERT INTO payment_qr_configs (display_name, payment_identifier, notes)
     SELECT 'PG Management', 'pgmanagement@upi', 'Replace with the real UPI ID and QR image'
      WHERE NOT EXISTS (SELECT 1 FROM payment_qr_configs WHERE branch_id IS NULL)`,
  );

  console.log(
    `  operations: ${MESSAGE_TEMPLATES.length} templates, ${REMINDER_RULES.length} reminder rules, ` +
      `${AUTOMATION_JOBS.length} automation jobs`,
  );
}

/**
 * Sample data for exercising the app: tenants across several rooms, one who
 * moves mid-month and one who leaves, plus meter readings — enough to show the
 * electricity apportionment doing real work.
 */
async function seedDemoData(tx: Db, branchId: string, adminId: string): Promise<void> {
  const now = new Date();
  const periodMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const monthStart = periodMonth;
  const midMonth = `${periodMonth.slice(0, 8)}16`;
  const dayFifteen = `${periodMonth.slice(0, 8)}15`;

  const { rows: rooms } = await tx.query<{ id: string; code: string; sharing_capacity: number; floor_id: string }>(
    `SELECT id, code, sharing_capacity, floor_id FROM rooms WHERE branch_id = $1 ORDER BY code`,
    [branchId],
  );
  const roomByCode = new Map(rooms.map((room) => [room.code, room]));

  const people: {
    name: string; phone: string; roomCode: string; from: string; to?: string; moveTo?: string;
  }[] = [
    { name: 'Arun Kumar', phone: '9840000001', roomCode: 'GF-6S-01', from: monthStart, moveTo: 'GF-5S-01' },
    { name: 'Bala Subramanian', phone: '9840000002', roomCode: 'GF-6S-01', from: monthStart },
    { name: 'Chandran Raj', phone: '9840000003', roomCode: 'GF-6S-01', from: monthStart, to: dayFifteen },
    { name: 'Dinesh Kannan', phone: '9840000004', roomCode: 'GF-5S-01', from: monthStart },
    { name: 'Elango Murthy', phone: '9840000005', roomCode: 'GF-3S-01', from: monthStart },
    { name: 'Farhan Ali', phone: '9840000006', roomCode: 'F1-5S-01', from: monthStart },
    { name: 'Gopal Krishnan', phone: '9840000007', roomCode: 'F1-4S-01', from: midMonth },
  ];

  let created = 0;
  for (const [index, person] of people.entries()) {
    const room = roomByCode.get(person.roomCode);
    if (!room) continue;

    const tenantCode = `PG-${String(index + 1).padStart(6, '0')}`;
    const { rows: existing } = await tx.query<{ id: string }>(
      'SELECT id FROM tenants WHERE lower(tenant_code) = lower($1)',
      [tenantCode],
    );
    if (existing[0]) continue;

    const { rows: tenantRows } = await tx.query<{ id: string }>(
      `INSERT INTO tenants (tenant_code, full_name, phone, joining_date, status, deposit_paise, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        tenantCode, person.name, person.phone, person.from,
        person.to ? 'vacated' : 'active', 1_000_000, adminId,
      ],
    );
    const tenantId = tenantRows[0]!.id;
    created += 1;

    const { rows: priceRows } = await tx.query<{ id: string; monthly_rent_paise: number }>(
      `SELECT id, monthly_rent_paise FROM price_rules
        WHERE sharing_capacity = $1 AND branch_id IS NULL AND room_id IS NULL LIMIT 1`,
      [room.sharing_capacity],
    );
    const price = priceRows[0]!;

    // First stay. A mover's first stay is closed on the 15th and a second one
    // opens on the 16th, exactly as the movement workflow would do it.
    const firstEnd = person.moveTo ? dayFifteen : (person.to ?? null);
    const { rows: stayRows } = await tx.query<{ id: string }>(
      `INSERT INTO tenant_stays
         (tenant_id, branch_id, floor_id, room_id, start_date, end_date, sharing_capacity,
          monthly_rent_paise, price_rule_id, status, ended_reason, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [
        tenantId, branchId, room.floor_id, room.id, person.from, firstEnd,
        room.sharing_capacity, price.monthly_rent_paise, price.id,
        firstEnd ? 'ended' : 'active',
        person.moveTo ? 'moved' : person.to ? 'vacated' : null,
        adminId,
      ],
    );

    if (person.moveTo) {
      const target = roomByCode.get(person.moveTo);
      if (target) {
        const { rows: targetPrice } = await tx.query<{ id: string; monthly_rent_paise: number }>(
          `SELECT id, monthly_rent_paise FROM price_rules
            WHERE sharing_capacity = $1 AND branch_id IS NULL AND room_id IS NULL LIMIT 1`,
          [target.sharing_capacity],
        );
        await tx.query(
          `INSERT INTO tenant_stays
             (tenant_id, branch_id, floor_id, room_id, start_date, sharing_capacity,
              monthly_rent_paise, price_rule_id, status, move_reason, previous_stay_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active','Requested a smaller room',$9,$10)`,
          [
            tenantId, branchId, target.floor_id, target.id, midMonth, target.sharing_capacity,
            targetPrice[0]!.monthly_rent_paise, targetPrice[0]!.id, stayRows[0]!.id, adminId,
          ],
        );
      }
    }
  }

  // Meter readings for the month, so bills can actually be generated.
  const { rows: meters } = await tx.query<{ id: string; code: string }>(
    `SELECT id, code FROM eb_meters WHERE branch_id = $1 ORDER BY code`,
    [branchId],
  );
  for (const [index, meter] of meters.entries()) {
    await tx.query(
      `INSERT INTO eb_readings
         (meter_id, period_month, reading_date, previous_reading, current_reading, eb_rate_paise, entered_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (meter_id, period_month) DO NOTHING`,
      [
        meter.id, periodMonth, `${periodMonth.slice(0, 8)}28`,
        1000 + index * 500, 1000 + index * 500 + (index === 0 ? 100 : 180),
        EB_RATE_PAISE, adminId,
      ],
    );
  }

  console.log(`  demo: ${created} tenant(s), ${meters.length} meter reading(s) for ${periodMonth.slice(0, 7)}`);
}

async function main(): Promise<void> {
  console.log('[seed] seeding PG Management');

  await withTransaction(async (tx) => {
    const adminId = await seedUsers(tx);

    const branchIds = new Map<string, string>();
    for (const branch of BRANCHES) {
      branchIds.set(branch.code, await seedBranch(tx, branch, adminId));
    }

    await seedPricing(tx, adminId);
    await seedMessagingAndAutomation(tx);

    if (DEMO) {
      await seedDemoData(tx, branchIds.get(EKKATUTHANGAL.code)!, adminId);
    }
  });

  console.log('[seed] done');
  console.log(
    `[seed] ${EKKATUTHANGAL.name} configured with ` +
      `${EKKATUTHANGAL.floors.reduce((sum, floor) => sum + floor.rooms.length, 0)} rooms and ` +
      `${EKKATUTHANGAL.floors.reduce(
        (sum, floor) => sum + floor.rooms.reduce((beds, room) => beds + room.sharingCapacity, 0),
        0,
      )} beds. ` +
      `${ALANDUR.name} has ${ALANDUR.floors.length} areas ready for rooms to be added.`,
  );
}

try {
  await main();
} catch (error) {
  console.error('[seed] failed:', (error as Error).message);
  process.exitCode = 1;
} finally {
  await closePool();
}
