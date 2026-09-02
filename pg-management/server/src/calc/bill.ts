import { periodBounds, type IsoDate } from './dates.js';
import { formatPaise, sumPaise, type Paise } from './money.js';
import { calculateRent, explainRent, type RentCalculationResult } from './rent.js';
import { explainEb, type EbCalculationResult, type TenantEbShare } from './eb.js';
import type { OccupancySegment } from './types.js';
import { ENGINE_VERSION } from './version.js';

/**
 * Assembles one tenant's monthly bill from the parts the engine has already
 * computed: prorated rent from stay history, the tenant's share of
 * electricity, the flat common charge, plus any charges, credits and brought
 * forward dues.
 *
 * Pure and deterministic, like the rest of the engine. Nothing here reads the
 * clock or the database, so recomputing a bill from its stored inputs always
 * reproduces the stored figures.
 */

export type ExtraCharge = {
  description: string;
  amountPaise: Paise;
};

export type BillCalculationInput = {
  periodMonth: IsoDate;
  tenantId: string;
  tenantName: string;
  /** This tenant's stay segments, already clipped to the billing month. */
  segments: OccupancySegment[];
  /** This tenant's row from the meter apportionment, if their room is metered. */
  ebShare: TenantEbShare | null;
  /** Additional one-off charges (laundry, damages, ...). */
  otherCharges?: ExtraCharge[];
  /** Reductions applied before payment. */
  discounts?: ExtraCharge[];
  /** Corrections, positive or negative. */
  adjustments?: ExtraCharge[];
  /** Balance carried in from earlier bills. */
  previousDuesPaise?: Paise;
  /** Payments already approved against this bill. */
  paidPaise?: Paise;
};

export type BillLine = {
  itemType: 'rent' | 'eb' | 'common_charge' | 'other' | 'discount' | 'adjustment' | 'previous_dues';
  description: string;
  amountPaise: Paise;
  sortOrder: number;
  meta: Record<string, unknown>;
};

export type BillCalculationResult = {
  engineVersion: string;
  periodMonth: IsoDate;
  tenantId: string;
  tenantName: string;
  daysInMonth: number;
  occupancyDays: number;
  rent: RentCalculationResult;
  rentPaise: Paise;
  ebPaise: Paise;
  commonChargePaise: Paise;
  otherChargesPaise: Paise;
  discountPaise: Paise;
  adjustmentPaise: Paise;
  previousDuesPaise: Paise;
  /** Everything owed for this month plus anything brought forward. */
  totalPaise: Paise;
  paidPaise: Paise;
  outstandingPaise: Paise;
  lines: BillLine[];
};

export function calculateBill(input: BillCalculationInput): BillCalculationResult {
  const bounds = periodBounds(input.periodMonth);
  const rent = calculateRent(input.segments, input.periodMonth);

  const otherCharges = input.otherCharges ?? [];
  const discounts = input.discounts ?? [];
  const adjustments = input.adjustments ?? [];
  const previousDuesPaise = input.previousDuesPaise ?? 0;
  const paidPaise = input.paidPaise ?? 0;

  const ebPaise = input.ebShare?.ebPaise ?? 0;
  const commonChargePaise = input.ebShare?.commonChargePaise ?? 0;
  const otherChargesPaise = sumPaise(otherCharges.map((charge) => charge.amountPaise));
  const discountPaise = sumPaise(discounts.map((discount) => discount.amountPaise));
  const adjustmentPaise = sumPaise(adjustments.map((adjustment) => adjustment.amountPaise));

  const lines: BillLine[] = [];
  let sortOrder = 0;

  for (const segment of rent.segments) {
    lines.push({
      itemType: 'rent',
      description: segment.isFullMonth
        ? `Rent ${segment.from} to ${segment.to} — ${segment.roomCode} (${segment.sharingCapacity} sharing), full month`
        : `Rent ${segment.from} to ${segment.to} — ${segment.roomCode} (${segment.sharingCapacity} sharing), ${segment.days}/${segment.daysInMonth} days`,
      amountPaise: segment.amountPaise,
      sortOrder: (sortOrder += 1),
      meta: {
        stayId: segment.stayId,
        roomCode: segment.roomCode,
        sharingCapacity: segment.sharingCapacity,
        days: segment.days,
        daysInMonth: segment.daysInMonth,
        monthlyRentPaise: segment.monthlyRentPaise,
      },
    });
  }

  if (input.ebShare) {
    lines.push({
      itemType: 'eb',
      description: `Electricity — ${input.ebShare.occupancyDays} occupancy day(s)`,
      amountPaise: ebPaise,
      sortOrder: (sortOrder += 1),
      meta: {
        occupancyDays: input.ebShare.occupancyDays,
        stayPeriods: input.ebShare.stayPeriods,
        exactEbPaise: input.ebShare.exactEbPaise,
      },
    });
    lines.push({
      itemType: 'common_charge',
      description: 'Common charge',
      amountPaise: commonChargePaise,
      sortOrder: (sortOrder += 1),
      meta: {},
    });
  }

  for (const charge of otherCharges) {
    lines.push({
      itemType: 'other',
      description: charge.description,
      amountPaise: charge.amountPaise,
      sortOrder: (sortOrder += 1),
      meta: {},
    });
  }

  for (const discount of discounts) {
    lines.push({
      itemType: 'discount',
      description: discount.description,
      // Stored as a positive figure and subtracted in the total, so the ledger
      // reads "discount ₹500" rather than "charge -₹500".
      amountPaise: discount.amountPaise,
      sortOrder: (sortOrder += 1),
      meta: {},
    });
  }

  for (const adjustment of adjustments) {
    lines.push({
      itemType: 'adjustment',
      description: adjustment.description,
      amountPaise: adjustment.amountPaise,
      sortOrder: (sortOrder += 1),
      meta: {},
    });
  }

  if (previousDuesPaise !== 0) {
    lines.push({
      itemType: 'previous_dues',
      description: 'Balance brought forward',
      amountPaise: previousDuesPaise,
      sortOrder: (sortOrder += 1),
      meta: {},
    });
  }

  const totalPaise =
    rent.totalPaise +
    ebPaise +
    commonChargePaise +
    otherChargesPaise -
    discountPaise +
    adjustmentPaise +
    previousDuesPaise;

  return {
    engineVersion: ENGINE_VERSION,
    periodMonth: bounds.start,
    tenantId: input.tenantId,
    tenantName: input.tenantName,
    daysInMonth: bounds.days,
    occupancyDays: input.segments.reduce((sum, segment) => sum + segment.days, 0),
    rent,
    rentPaise: rent.totalPaise,
    ebPaise,
    commonChargePaise,
    otherChargesPaise,
    discountPaise,
    adjustmentPaise,
    previousDuesPaise,
    totalPaise,
    paidPaise,
    outstandingPaise: totalPaise - paidPaise,
    lines,
  };
}

/**
 * The full working for one bill, as shown in the app and sent to the tenant.
 * Includes the whole electricity apportionment, not just this tenant's share,
 * so the split can be checked rather than taken on trust.
 */
export function explainBill(
  bill: BillCalculationResult,
  ebCalculation: EbCalculationResult | null,
): string[] {
  const lines: string[] = [
    `${bill.tenantName} — bill for ${bill.periodMonth.slice(0, 7)}`,
    '',
    ...explainRent(bill.rent),
  ];

  if (ebCalculation && bill.ebPaise > 0) {
    lines.push('', ...explainEb(ebCalculation));
  }

  lines.push('', 'Summary:');
  lines.push(`  Rent: ${formatPaise(bill.rentPaise)}`);
  if (bill.ebPaise > 0) lines.push(`  Electricity: ${formatPaise(bill.ebPaise)}`);
  if (bill.commonChargePaise > 0) {
    lines.push(`  Common charge: ${formatPaise(bill.commonChargePaise)}`);
  }
  if (bill.otherChargesPaise > 0) {
    lines.push(`  Other charges: ${formatPaise(bill.otherChargesPaise)}`);
  }
  if (bill.discountPaise > 0) lines.push(`  Discount: -${formatPaise(bill.discountPaise)}`);
  if (bill.adjustmentPaise !== 0) {
    lines.push(`  Adjustment: ${formatPaise(bill.adjustmentPaise)}`);
  }
  if (bill.previousDuesPaise !== 0) {
    lines.push(`  Previous dues: ${formatPaise(bill.previousDuesPaise)}`);
  }
  lines.push(`  Total payable: ${formatPaise(bill.totalPaise)}`);
  if (bill.paidPaise > 0) {
    lines.push(`  Paid: ${formatPaise(bill.paidPaise)}`);
    lines.push(`  Outstanding: ${formatPaise(bill.outstandingPaise)}`);
  }

  return lines;
}
