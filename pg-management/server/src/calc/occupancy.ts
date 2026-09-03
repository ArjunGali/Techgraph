import { clampRange, inclusiveDays, periodBounds, type IsoDate } from './dates.js';
import type { OccupancySegment, StaySegment, TenantOccupancy } from './types.js';

/**
 * Turns raw stay history into the occupancy the billing month actually saw.
 *
 * Everything downstream — rent proration, electricity apportionment, vacancy
 * counts — is derived from the output of this function, so occupancy is
 * computed once, from recorded history, and never estimated. A tenant who
 * joined mid-month, moved rooms twice and left before the month ended produces
 * three segments here and is billed for exactly the days each one covered.
 */
export function segmentsForPeriod(stays: StaySegment[], periodMonth: IsoDate): OccupancySegment[] {
  const bounds = periodBounds(periodMonth);
  const segments: OccupancySegment[] = [];

  for (const stay of stays) {
    const clipped = clampRange({ start: stay.startDate, end: stay.endDate }, bounds);
    if (!clipped) continue; // stay does not touch this month at all

    segments.push({
      stayId: stay.stayId,
      tenantId: stay.tenantId,
      tenantName: stay.tenantName,
      roomId: stay.roomId,
      roomCode: stay.roomCode,
      meterId: stay.meterId,
      sharingCapacity: stay.sharingCapacity,
      monthlyRentPaise: stay.monthlyRentPaise,
      from: clipped.start,
      to: clipped.end,
      days: inclusiveDays(clipped.start, clipped.end),
    });
  }

  // Stable ordering keeps every recomputation of a historical bill identical.
  segments.sort(
    (a, b) =>
      a.tenantName.localeCompare(b.tenantName) ||
      a.tenantId.localeCompare(b.tenantId) ||
      a.from.localeCompare(b.from),
  );

  return segments;
}

/**
 * Groups segments into one occupancy total per tenant.
 *
 * A tenant who moved rooms mid-month appears once, with their days summed
 * across every room they occupied — the generalisation of the traditional
 * "days stayed by the person who left, plus everyone else's full month".
 */
export function occupancyByTenant(segments: OccupancySegment[]): TenantOccupancy[] {
  const byTenant = new Map<string, TenantOccupancy>();

  for (const segment of segments) {
    const existing = byTenant.get(segment.tenantId);
    if (existing) {
      existing.days += segment.days;
      existing.segments.push(segment);
    } else {
      byTenant.set(segment.tenantId, {
        tenantId: segment.tenantId,
        tenantName: segment.tenantName,
        days: segment.days,
        segments: [segment],
      });
    }
  }

  return [...byTenant.values()].sort(
    (a, b) => a.tenantName.localeCompare(b.tenantName) || a.tenantId.localeCompare(b.tenantId),
  );
}

/** Total occupancy days across every tenant — step 3 of the EB formula. */
export function totalOccupancyDays(occupancies: TenantOccupancy[]): number {
  return occupancies.reduce((total, occupancy) => total + occupancy.days, 0);
}

/** Splits segments by the meter that bills them, so each meter is apportioned separately. */
export function groupByMeter(segments: OccupancySegment[]): Map<string, OccupancySegment[]> {
  const byMeter = new Map<string, OccupancySegment[]>();
  for (const segment of segments) {
    if (segment.meterId === null) continue; // room has no meter; billed no electricity
    const bucket = byMeter.get(segment.meterId);
    if (bucket) bucket.push(segment);
    else byMeter.set(segment.meterId, [segment]);
  }
  return byMeter;
}
