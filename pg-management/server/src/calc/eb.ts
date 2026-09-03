import { periodBounds, type IsoDate } from './dates.js';
import { assertPaise, distribute, formatPaise, roundHalfUp, type Paise } from './money.js';
import { occupancyByTenant, totalOccupancyDays } from './occupancy.js';
import type { OccupancySegment, TenantOccupancy } from './types.js';
import { ENGINE_VERSION } from './version.js';

/**
 * The electricity apportionment formula.
 *
 * This is the PG's actual working, implemented step for step:
 *
 *   1. Total EB amount        = total units x EB rate
 *   2. Occupancy days         = each tenant's real days, from stay history
 *   3. Total occupancy days   = the sum of every tenant's days
 *   4. EB per occupancy day   = total EB amount / total occupancy days
 *   5. Individual tenant EB   = EB per occupancy day x that tenant's days
 *   6. Final amount           = individual EB + the flat common charge
 *
 * Step 2 is deliberately general. The traditional shortcut — "days stayed by
 * the person who left, plus the remaining members times the days in the month"
 * — is just the special case of one mid-month departure. Summing each tenant's
 * actual days gives the same answer there and stays correct with several
 * people joining or leaving, tenants moving between rooms, and months of 28,
 * 29, 30 or 31 days.
 *
 * This module is pure and deterministic: same inputs, same output, no clock,
 * no database, no configuration. The rates it consumes are administered
 * values; the arithmetic itself is not editable from the application.
 */

export type EbCalculationInput = {
  periodMonth: IsoDate;
  meterId: string;
  meterCode: string;
  previousReading: number;
  currentReading: number;
  /** Administered rate per unit, in paise. Default ₹12.50 = 1250 paise. */
  ebRatePaise: Paise;
  /** Administered flat charge added per tenant, in paise. Default ₹150 = 15000 paise. */
  commonChargePaise: Paise;
  /** Stay segments already clipped to the billing month for this meter. */
  segments: OccupancySegment[];
};

export type TenantEbShare = {
  tenantId: string;
  tenantName: string;
  occupancyDays: number;
  stayPeriods: { from: IsoDate; to: IsoDate; days: number; roomCode: string }[];
  /** Unrounded share, retained so the breakdown can be audited. */
  exactEbPaise: number;
  /** Step 5 — the tenant's share of electricity, in whole paise. */
  ebPaise: Paise;
  /** Step 6 — the flat common charge. */
  commonChargePaise: Paise;
  /** Step 6 — what the tenant actually pays for electricity this month. */
  totalPaise: Paise;
};

export type EbCalculationResult = {
  engineVersion: string;
  periodMonth: IsoDate;
  meterId: string;
  meterCode: string;
  daysInMonth: number;
  previousReading: number;
  currentReading: number;
  /** Step 1 inputs. */
  totalUnits: number;
  ebRatePaise: Paise;
  /** Step 1 — total units x rate. */
  totalEbPaise: Paise;
  /** Step 3 — the denominator of the split. */
  totalOccupancyDays: number;
  /** Step 4, exact (paise per occupancy day, unrounded). */
  ebPerOccupancyDayExact: number;
  /** Step 4, rounded for display only — never used to compute a share. */
  ebPerOccupancyDayPaise: Paise;
  commonChargePaise: Paise;
  tenants: TenantEbShare[];
  /** Always equal to totalEbPaise: the split never loses or invents a paise. */
  distributedEbPaise: Paise;
  totalCommonChargePaise: Paise;
  grandTotalPaise: Paise;
};

export class CalculationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CalculationError';
    this.code = code;
  }
}

export function calculateEb(input: EbCalculationInput): EbCalculationResult {
  const {
    periodMonth,
    meterId,
    meterCode,
    previousReading,
    currentReading,
    ebRatePaise,
    commonChargePaise,
    segments,
  } = input;

  assertPaise(ebRatePaise, 'ebRatePaise');
  assertPaise(commonChargePaise, 'commonChargePaise');

  if (currentReading < previousReading) {
    throw new CalculationError(
      'reading_regressed',
      `Current meter reading (${currentReading}) is lower than the previous reading ` +
        `(${previousReading}) on meter ${meterCode}. Correct the reading before billing.`,
    );
  }

  const bounds = periodBounds(periodMonth);

  // ---- Step 1: total EB amount --------------------------------------------
  const totalUnits = round2(currentReading - previousReading);
  const totalEbPaise = roundHalfUp(totalUnits * ebRatePaise);

  // ---- Steps 2 and 3: occupancy days --------------------------------------
  const occupancies = occupancyByTenant(segments);
  const totalDays = totalOccupancyDays(occupancies);

  if (totalDays <= 0) {
    // No one occupied this meter's rooms; there is nothing to apportion. The
    // units are still recorded against the meter for the owner's reports.
    return {
      engineVersion: ENGINE_VERSION,
      periodMonth: bounds.start,
      meterId,
      meterCode,
      daysInMonth: bounds.days,
      previousReading,
      currentReading,
      totalUnits,
      ebRatePaise,
      totalEbPaise,
      totalOccupancyDays: 0,
      ebPerOccupancyDayExact: 0,
      ebPerOccupancyDayPaise: 0,
      commonChargePaise,
      tenants: [],
      distributedEbPaise: 0,
      totalCommonChargePaise: 0,
      grandTotalPaise: 0,
    };
  }

  // ---- Step 4: EB per occupancy day ---------------------------------------
  const ebPerOccupancyDayExact = totalEbPaise / totalDays;

  // ---- Step 5: each tenant's share ----------------------------------------
  // Shares are allocated with the largest-remainder method rather than by
  // rounding each one on its own, so the parts add back to the total exactly.
  const allocations = distribute(
    totalEbPaise,
    occupancies.map((occupancy) => ({ key: occupancy, weight: occupancy.days })),
  );

  const tenants: TenantEbShare[] = allocations.map(({ key: occupancy, exact, amount }) => ({
    tenantId: occupancy.tenantId,
    tenantName: occupancy.tenantName,
    occupancyDays: occupancy.days,
    stayPeriods: occupancy.segments.map((segment) => ({
      from: segment.from,
      to: segment.to,
      days: segment.days,
      roomCode: segment.roomCode,
    })),
    exactEbPaise: exact,
    ebPaise: amount,
    // ---- Step 6: add the flat common charge -------------------------------
    commonChargePaise,
    totalPaise: amount + commonChargePaise,
  }));

  const distributedEbPaise = tenants.reduce((sum, tenant) => sum + tenant.ebPaise, 0);

  return {
    engineVersion: ENGINE_VERSION,
    periodMonth: bounds.start,
    meterId,
    meterCode,
    daysInMonth: bounds.days,
    previousReading,
    currentReading,
    totalUnits,
    ebRatePaise,
    totalEbPaise,
    totalOccupancyDays: totalDays,
    ebPerOccupancyDayExact,
    ebPerOccupancyDayPaise: roundHalfUp(ebPerOccupancyDayExact),
    commonChargePaise,
    tenants,
    distributedEbPaise,
    totalCommonChargePaise: commonChargePaise * tenants.length,
    grandTotalPaise: distributedEbPaise + commonChargePaise * tenants.length,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Renders the calculation as the line-by-line working the owner and tenants
 * see. Every figure in the formula is shown, so any amount can be checked by
 * hand from the meter readings alone.
 */
export function explainEb(result: EbCalculationResult): string[] {
  if (result.totalOccupancyDays === 0) {
    return [
      `Meter ${result.meterCode} — ${result.periodMonth.slice(0, 7)}`,
      `Previous reading: ${result.previousReading}`,
      `Current reading: ${result.currentReading}`,
      `Units consumed: ${result.totalUnits}`,
      'No tenant occupied these rooms during the month, so nothing was apportioned.',
    ];
  }

  const lines = [
    `Meter ${result.meterCode} — ${result.periodMonth.slice(0, 7)} (${result.daysInMonth} days)`,
    `Previous reading: ${result.previousReading}`,
    `Current reading: ${result.currentReading}`,
    `Units consumed: ${result.currentReading} - ${result.previousReading} = ${result.totalUnits}`,
    `EB rate: ${formatPaise(result.ebRatePaise)} per unit`,
    `Total EB amount: ${result.totalUnits} x ${formatPaise(result.ebRatePaise)} = ${formatPaise(result.totalEbPaise)}`,
    '',
    'Occupancy days:',
  ];

  for (const tenant of result.tenants) {
    const periods = tenant.stayPeriods
      .map((period) => `${period.from} to ${period.to} in ${period.roomCode} (${period.days} days)`)
      .join('; ');
    lines.push(`  ${tenant.tenantName}: ${tenant.occupancyDays} days — ${periods}`);
  }

  lines.push(
    '',
    `Total occupancy days: ${result.totalOccupancyDays}`,
    `EB per occupancy day: ${formatPaise(result.totalEbPaise)} / ${result.totalOccupancyDays} = ` +
      `${formatPaise(result.ebPerOccupancyDayPaise)}`,
    '',
    'Amount per tenant:',
  );

  for (const tenant of result.tenants) {
    lines.push(
      `  ${tenant.tenantName}: ${tenant.occupancyDays} days x ` +
        `${formatPaise(result.ebPerOccupancyDayPaise)} = ${formatPaise(tenant.ebPaise)} ` +
        `+ ${formatPaise(tenant.commonChargePaise)} common charge = ${formatPaise(tenant.totalPaise)}`,
    );
  }

  lines.push(
    '',
    `Electricity apportioned: ${formatPaise(result.distributedEbPaise)} ` +
      `(matches the total EB amount exactly)`,
    `Common charge collected: ${formatPaise(result.totalCommonChargePaise)}`,
    `Grand total billed: ${formatPaise(result.grandTotalPaise)}`,
  );

  return lines;
}
