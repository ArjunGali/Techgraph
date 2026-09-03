import type { Db } from '../../db/pool.js';
import { unprocessable } from '../../lib/errors.js';
import {
  calculateBill,
  calculateEb,
  explainBill,
  explainEb,
  groupByMeter,
  segmentsForPeriod,
  ENGINE_VERSION,
  type BillCalculationResult,
  type EbCalculationResult,
  type OccupancySegment,
  type StaySegment,
  type TenantEbShare,
} from '../../calc/index.js';
import { resolveChargeRate } from '../pricing/pricing.service.js';

/**
 * Turns a month of recorded history into bills.
 *
 * The service's job is only to gather inputs and persist results — every
 * figure is produced by the locked calculation engine, from stay records and
 * meter readings. Nothing is estimated and nothing is entered by hand.
 */

type StayRow = {
  stay_id: string;
  tenant_id: string;
  tenant_name: string;
  room_id: string;
  room_code: string;
  meter_id: string | null;
  sharing_capacity: number;
  monthly_rent_paise: number;
  start_date: string;
  end_date: string | null;
};

/** Every stay in the branch that overlaps the billing month. */
export async function loadStaysForPeriod(
  db: Db,
  branchId: string,
  periodMonth: string,
): Promise<StaySegment[]> {
  const { rows } = await db.query<StayRow>(
    `SELECT s.id AS stay_id, s.tenant_id, t.full_name AS tenant_name,
            s.room_id, r.code AS room_code, r.meter_id,
            s.sharing_capacity, s.monthly_rent_paise, s.start_date, s.end_date
       FROM tenant_stays s
       JOIN tenants t ON t.id = s.tenant_id
       JOIN rooms r ON r.id = s.room_id
      WHERE s.branch_id = $1
        AND s.status <> 'cancelled'
        AND daterange(s.start_date, s.end_date, '[]')
            && daterange($2::date, ($2::date + INTERVAL '1 month' - INTERVAL '1 day')::date, '[]')
      ORDER BY t.full_name, s.start_date`,
    [branchId, periodMonth],
  );

  return rows.map((row) => ({
    stayId: row.stay_id,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    roomId: row.room_id,
    roomCode: row.room_code,
    meterId: row.meter_id,
    sharingCapacity: row.sharing_capacity,
    monthlyRentPaise: row.monthly_rent_paise,
    startDate: row.start_date,
    endDate: row.end_date,
  }));
}

export type MeterApportionment = {
  calculation: EbCalculationResult;
  readingId: string;
  /** Each tenant's share, keyed by tenant id. */
  shares: Map<string, TenantEbShare>;
};

/**
 * Runs the electricity apportionment for every metered room in the branch.
 *
 * Each meter is apportioned on its own, over exactly the tenants whose stay
 * segments sat behind that meter during the month. A tenant who moved between
 * two differently metered floors therefore contributes days to both, in the
 * right proportion.
 */
export async function apportionElectricity(
  db: Db,
  branchId: string,
  periodMonth: string,
  segments: OccupancySegment[],
): Promise<MeterApportionment[]> {
  const byMeter = groupByMeter(segments);
  if (byMeter.size === 0) return [];

  const { rows: readings } = await db.query<{
    id: string;
    meter_id: string;
    meter_code: string;
    previous_reading: number;
    current_reading: number;
    eb_rate_paise: number;
  }>(
    `SELECT er.id, er.meter_id, m.code AS meter_code, er.previous_reading,
            er.current_reading, er.eb_rate_paise
       FROM eb_readings er
       JOIN eb_meters m ON m.id = er.meter_id
      WHERE m.branch_id = $1 AND er.period_month = $2`,
    [branchId, periodMonth],
  );

  const commonChargePaise = await resolveChargeRate(db, {
    branchId,
    charge: 'common_charge',
    onDate: periodMonth,
  });

  const results: MeterApportionment[] = [];

  for (const reading of readings) {
    const meterSegments = byMeter.get(reading.meter_id);
    if (!meterSegments || meterSegments.length === 0) continue;

    const calculation = calculateEb({
      periodMonth,
      meterId: reading.meter_id,
      meterCode: reading.meter_code,
      previousReading: reading.previous_reading,
      currentReading: reading.current_reading,
      ebRatePaise: reading.eb_rate_paise,
      commonChargePaise,
      segments: meterSegments,
    });

    results.push({
      calculation,
      readingId: reading.id,
      shares: new Map(calculation.tenants.map((share) => [share.tenantId, share])),
    });
  }

  return results;
}

/** Which metered rooms have no reading for the month — bills cannot be final without them. */
export async function findMissingReadings(
  db: Db,
  branchId: string,
  periodMonth: string,
): Promise<{ meterId: string; meterCode: string }[]> {
  const { rows } = await db.query<{ meter_id: string; meter_code: string }>(
    `SELECT DISTINCT m.id AS meter_id, m.code AS meter_code
       FROM eb_meters m
       JOIN rooms r ON r.meter_id = m.id AND r.status = 'active'
      WHERE m.branch_id = $1 AND m.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM eb_readings er WHERE er.meter_id = m.id AND er.period_month = $2
        )
      ORDER BY m.code`,
    [branchId, periodMonth],
  );
  return rows.map((row) => ({ meterId: row.meter_id, meterCode: row.meter_code }));
}

/**
 * The balance a tenant brings into this month: what earlier bills still leave
 * outstanding, so nothing quietly disappears between months.
 */
async function loadPreviousDues(
  db: Db,
  tenantId: string,
  periodMonth: string,
): Promise<number> {
  const { rows } = await db.query<{ outstanding: number }>(
    `SELECT coalesce(sum(b.outstanding_paise), 0)::bigint AS outstanding
       FROM bills b
       JOIN billing_periods bp ON bp.id = b.billing_period_id
      WHERE b.tenant_id = $1 AND bp.period_month < $2 AND b.status <> 'void'`,
    [tenantId, periodMonth],
  );
  return Number(rows[0]?.outstanding ?? 0);
}

export type GeneratedBill = {
  billId: string;
  tenantId: string;
  tenantName: string;
  calculation: BillCalculationResult;
  ebCalculation: EbCalculationResult | null;
};

/**
 * Generates or regenerates every bill for a branch's billing month.
 *
 * Safe to run repeatedly while the month is open: existing draft bills are
 * recomputed in place, keeping their bill numbers and any payments already
 * recorded against them. A closed month is refused outright.
 */
export async function generateBillsForPeriod(
  db: Db,
  params: { branchId: string; periodMonth: string; userId: string },
): Promise<{ periodId: string; bills: GeneratedBill[]; missingReadings: { meterId: string; meterCode: string }[] }> {
  const { branchId, periodMonth, userId } = params;

  const { rows: periodRows } = await db.query<{ id: string; status: string }>(
    `INSERT INTO billing_periods (branch_id, period_month, status, created_by)
     VALUES ($1, $2, 'draft', $3)
     ON CONFLICT (branch_id, period_month) DO UPDATE SET updated_at = now()
     RETURNING id, status`,
    [branchId, periodMonth, userId],
  );
  const period = periodRows[0]!;

  if (period.status === 'closed') {
    throw unprocessable(
      'That billing month is closed. An admin must reopen it before bills can be regenerated.',
    );
  }

  const stays = await loadStaysForPeriod(db, branchId, periodMonth);
  const segments = segmentsForPeriod(stays, periodMonth);
  const apportionments = await apportionElectricity(db, branchId, periodMonth, segments);
  const missingReadings = await findMissingReadings(db, branchId, periodMonth);

  // Persist each meter's working, so the split can be shown and re-checked
  // later exactly as it was computed.
  await db.query('DELETE FROM eb_calculations WHERE billing_period_id = $1', [period.id]);
  for (const apportionment of apportionments) {
    await db.query(
      `INSERT INTO eb_calculations
         (billing_period_id, meter_id, reading_id, engine_version, total_units, eb_rate_paise,
          total_eb_paise, total_occupancy_days, breakdown)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        period.id, apportionment.calculation.meterId, apportionment.readingId, ENGINE_VERSION,
        apportionment.calculation.totalUnits, apportionment.calculation.ebRatePaise,
        apportionment.calculation.totalEbPaise, apportionment.calculation.totalOccupancyDays,
        JSON.stringify({
          ...apportionment.calculation,
          explanation: explainEb(apportionment.calculation),
        }),
      ],
    );
  }

  const shareFor = (tenantId: string): { share: TenantEbShare; calculation: EbCalculationResult } | null => {
    for (const apportionment of apportionments) {
      const share = apportionment.shares.get(tenantId);
      if (share) return { share, calculation: apportionment.calculation };
    }
    return null;
  };

  const tenantIds = [...new Set(segments.map((segment) => segment.tenantId))];
  const bills: GeneratedBill[] = [];

  for (const tenantId of tenantIds) {
    const tenantSegments = segments.filter((segment) => segment.tenantId === tenantId);
    const tenantName = tenantSegments[0]!.tenantName;
    const ebShare = shareFor(tenantId);
    const previousDuesPaise = await loadPreviousDues(db, tenantId, periodMonth);

    // Approved payments already banked against this month's bill are carried
    // through, so regenerating never resets what a tenant has paid.
    const { rows: paidRows } = await db.query<{ paid: number }>(
      // Same rule as refreshBillTotals: a reversed entry and its contra entry
      // are both counted, so they net to zero rather than subtracting twice.
      `SELECT coalesce(sum(p.direction * coalesce(p.approved_amount_paise, p.amount_paise)), 0)::bigint AS paid
         FROM payments p
         JOIN bills b ON b.id = p.bill_id
        WHERE b.billing_period_id = $1 AND p.tenant_id = $2
          AND p.state IN ('approved', 'reversed')`,
      [period.id, tenantId],
    );
    const paidPaise = Number(paidRows[0]?.paid ?? 0);

    const calculation = calculateBill({
      periodMonth,
      tenantId,
      tenantName,
      segments: tenantSegments,
      ebShare: ebShare?.share ?? null,
      previousDuesPaise,
      paidPaise,
    });

    const { rows: billRows } = await db.query<{ id: string }>(
      `INSERT INTO bills
         (billing_period_id, tenant_id, bill_number, status, rent_paise, eb_paise,
          common_charge_paise, other_charges_paise, discount_paise, adjustment_paise,
          previous_dues_paise, total_paise, paid_paise, outstanding_paise, engine_version,
          generated_at, due_date)
       VALUES ($1,$2,$3,'calculated',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now(),
               ($15::date + INTERVAL '9 days')::date)
       ON CONFLICT (billing_period_id, tenant_id) DO UPDATE SET
         status = 'calculated',
         rent_paise = EXCLUDED.rent_paise, eb_paise = EXCLUDED.eb_paise,
         common_charge_paise = EXCLUDED.common_charge_paise,
         other_charges_paise = EXCLUDED.other_charges_paise,
         discount_paise = EXCLUDED.discount_paise, adjustment_paise = EXCLUDED.adjustment_paise,
         previous_dues_paise = EXCLUDED.previous_dues_paise, total_paise = EXCLUDED.total_paise,
         paid_paise = EXCLUDED.paid_paise, outstanding_paise = EXCLUDED.outstanding_paise,
         engine_version = EXCLUDED.engine_version, generated_at = now(), updated_at = now()
       RETURNING id`,
      [
        period.id, tenantId,
        `${periodMonth.slice(0, 7).replace('-', '')}-${tenantId.slice(0, 8)}`,
        calculation.rentPaise, calculation.ebPaise, calculation.commonChargePaise,
        calculation.otherChargesPaise, calculation.discountPaise, calculation.adjustmentPaise,
        calculation.previousDuesPaise, calculation.totalPaise, calculation.paidPaise,
        calculation.outstandingPaise, ENGINE_VERSION, periodMonth,
      ],
    );
    const billId = billRows[0]!.id;

    await db.query('DELETE FROM bill_items WHERE bill_id = $1', [billId]);
    for (const line of calculation.lines) {
      await db.query(
        `INSERT INTO bill_items (bill_id, item_type, description, amount_paise, sort_order, meta)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [billId, line.itemType, line.description, line.amountPaise, line.sortOrder, JSON.stringify(line.meta)],
      );
    }

    await db.query(
      `INSERT INTO bill_calculations (bill_id, engine_version, breakdown)
       VALUES ($1,$2,$3)
       ON CONFLICT (bill_id) DO UPDATE SET
         engine_version = EXCLUDED.engine_version,
         breakdown = EXCLUDED.breakdown,
         created_at = now()`,
      [
        billId, ENGINE_VERSION,
        JSON.stringify({
          bill: calculation,
          electricity: ebShare?.calculation ?? null,
          explanation: explainBill(calculation, ebShare?.calculation ?? null),
        }),
      ],
    );

    bills.push({
      billId, tenantId, tenantName, calculation,
      ebCalculation: ebShare?.calculation ?? null,
    });
  }

  await db.query(
    `UPDATE billing_periods SET status = 'calculated', calculated_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'draft'`,
    [period.id],
  );

  return { periodId: period.id, bills, missingReadings };
}

/** Recomputes a bill's paid and outstanding figures from the approved ledger. */
export async function refreshBillTotals(db: Db, billId: string): Promise<void> {
  await db.query(
    `UPDATE bills b
        SET paid_paise = ledger.paid,
            outstanding_paise = b.total_paise - ledger.paid,
            payment_status = CASE
              WHEN b.total_paise <= 0 THEN 'paid'::bill_payment_status
              WHEN ledger.paid >= b.total_paise THEN 'paid'::bill_payment_status
              WHEN ledger.paid > 0 THEN 'partially_paid'::bill_payment_status
              WHEN pending.count > 0 THEN 'pending_approval'::bill_payment_status
              ELSE 'not_paid'::bill_payment_status
            END,
            updated_at = now()
       FROM (
         -- A reversal does not erase the payment it cancels: the original entry
         -- stays on the ledger and a contra entry with the opposite direction is
         -- posted beside it. Both must be summed, or the reversal would be
         -- counted twice — once by dropping the original and once by the contra
         -- entry — and the balance would be wrong by the amount reversed.
         SELECT coalesce(sum(p.direction * coalesce(p.approved_amount_paise, p.amount_paise)), 0)::bigint AS paid
           FROM payments p
          WHERE p.bill_id = $1 AND p.state IN ('approved', 'reversed')
       ) ledger,
       (
         SELECT count(*)::int AS count FROM payments p
          WHERE p.bill_id = $1 AND p.state = 'pending_approval'
       ) pending
      WHERE b.id = $1`,
    [billId],
  );
}
