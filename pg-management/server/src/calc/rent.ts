import { periodBounds, type IsoDate } from './dates.js';
import { formatPaise, proRate, type Paise } from './money.js';
import type { OccupancySegment } from './types.js';
import { ENGINE_VERSION } from './version.js';

/**
 * Rent for a billing month, computed segment by segment from stay history.
 *
 * A tenant who spent 1–15 August in a 6-sharing room at ₹6,000 and 16–31
 * August in a 5-sharing room at ₹7,000 is charged for both periods at the rate
 * that applied to each, not at whichever rate happens to be current when the
 * bill is generated. Each segment carries the rent that was snapshotted onto
 * the stay record, so a repricing later never rewrites an old bill.
 */

export type RentSegmentLine = {
  stayId: string;
  roomCode: string;
  sharingCapacity: number;
  from: IsoDate;
  to: IsoDate;
  days: number;
  daysInMonth: number;
  monthlyRentPaise: Paise;
  /** True when the segment covers the whole month and is charged in full. */
  isFullMonth: boolean;
  amountPaise: Paise;
};

export type RentCalculationResult = {
  engineVersion: string;
  periodMonth: IsoDate;
  daysInMonth: number;
  totalDays: number;
  segments: RentSegmentLine[];
  totalPaise: Paise;
};

export function calculateRent(
  segments: OccupancySegment[],
  periodMonth: IsoDate,
): RentCalculationResult {
  const bounds = periodBounds(periodMonth);
  const daysInMonth = bounds.days;

  const lines: RentSegmentLine[] = segments
    .slice()
    .sort((a, b) => a.from.localeCompare(b.from))
    .map((segment) => {
      const isFullMonth = segment.days === daysInMonth;
      return {
        stayId: segment.stayId,
        roomCode: segment.roomCode,
        sharingCapacity: segment.sharingCapacity,
        from: segment.from,
        to: segment.to,
        days: segment.days,
        daysInMonth,
        monthlyRentPaise: segment.monthlyRentPaise,
        isFullMonth,
        // A full month is charged at the exact monthly rent rather than being
        // routed through the proration arithmetic, so a tenant who never moved
        // is billed the round figure they expect.
        amountPaise: proRate(segment.monthlyRentPaise, segment.days, daysInMonth),
      };
    });

  return {
    engineVersion: ENGINE_VERSION,
    periodMonth: bounds.start,
    daysInMonth,
    totalDays: lines.reduce((sum, line) => sum + line.days, 0),
    segments: lines,
    totalPaise: lines.reduce((sum, line) => sum + line.amountPaise, 0),
  };
}

export function explainRent(result: RentCalculationResult): string[] {
  if (result.segments.length === 0) return ['No rent: the tenant did not occupy a room this month.'];

  const lines = [`Rent — ${result.periodMonth.slice(0, 7)} (${result.daysInMonth} days)`];
  for (const segment of result.segments) {
    if (segment.isFullMonth) {
      lines.push(
        `  ${segment.from} to ${segment.to} — ${segment.roomCode} ` +
          `(${segment.sharingCapacity} sharing): full month at ${formatPaise(segment.monthlyRentPaise)} ` +
          `= ${formatPaise(segment.amountPaise)}`,
      );
    } else {
      lines.push(
        `  ${segment.from} to ${segment.to} — ${segment.roomCode} ` +
          `(${segment.sharingCapacity} sharing): ${formatPaise(segment.monthlyRentPaise)} x ` +
          `${segment.days}/${segment.daysInMonth} days = ${formatPaise(segment.amountPaise)}`,
      );
    }
  }
  lines.push(`  Total rent: ${formatPaise(result.totalPaise)}`);
  return lines;
}
