/**
 * Date-only arithmetic for the calculation engine.
 *
 * Billing is entirely calendar-driven: a stay from 1 August to 15 August is
 * fifteen days regardless of what time of day anything happened, and
 * regardless of the server's timezone. Dates are therefore handled as plain
 * `YYYY-MM-DD` strings converted to whole day numbers, and no JS `Date` with a
 * local-time component is ever used in a calculation.
 */

/** A calendar date in `YYYY-MM-DD` form. */
export type IsoDate = string;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

export function assertIsoDate(value: string, label = 'date'): IsoDate {
  if (!ISO_DATE.test(value)) {
    throw new RangeError(`${label} must be a YYYY-MM-DD date, received "${value}"`);
  }
  const days = toDayNumber(value);
  if (!Number.isFinite(days) || fromDayNumber(days) !== value) {
    throw new RangeError(`${label} is not a real calendar date: "${value}"`);
  }
  return value;
}

/** Days since the Unix epoch. Uses UTC so no timezone can shift the result. */
export function toDayNumber(date: IsoDate): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  return Date.UTC(year, month - 1, day) / MS_PER_DAY;
}

export function fromDayNumber(days: number): IsoDate {
  return new Date(days * MS_PER_DAY).toISOString().slice(0, 10);
}

export function addDays(date: IsoDate, delta: number): IsoDate {
  return fromDayNumber(toDayNumber(date) + delta);
}

export function compareDates(a: IsoDate, b: IsoDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function minDate(a: IsoDate, b: IsoDate): IsoDate {
  return a <= b ? a : b;
}

export function maxDate(a: IsoDate, b: IsoDate): IsoDate {
  return a >= b ? a : b;
}

/** First day of the month containing `date`. */
export function monthStart(date: IsoDate): IsoDate {
  return `${date.slice(0, 7)}-01`;
}

/** Last day of the month containing `date` — 28, 29, 30 or 31 as appropriate. */
export function monthEnd(date: IsoDate): IsoDate {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  // Day 0 of the following month is the last day of this one, which gives the
  // correct answer for February in leap and non-leap years alike.
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

/** Number of days in the month containing `date` (28/29/30/31). */
export function daysInMonth(date: IsoDate): number {
  return Number(monthEnd(date).slice(8, 10));
}

/** An inclusive date range. A null `end` means "still open". */
export type DateRange = { start: IsoDate; end: IsoDate | null };

/**
 * Number of days two inclusive ranges have in common.
 *
 * Both endpoints count, so 1 Aug to 15 Aug overlapping the whole of August is
 * 15 days, and a single-day stay is 1 day. Returns 0 when they do not meet.
 */
export function overlapDays(a: DateRange, bounded: { start: IsoDate; end: IsoDate }): number {
  const start = maxDate(a.start, bounded.start);
  const end = a.end === null ? bounded.end : minDate(a.end, bounded.end);
  if (start > end) return 0;
  return toDayNumber(end) - toDayNumber(start) + 1;
}

/** The portion of `range` that falls inside `bounded`, or null if disjoint. */
export function clampRange(
  range: DateRange,
  bounded: { start: IsoDate; end: IsoDate },
): { start: IsoDate; end: IsoDate } | null {
  const start = maxDate(range.start, bounded.start);
  const end = range.end === null ? bounded.end : minDate(range.end, bounded.end);
  if (start > end) return null;
  return { start, end };
}

/** Inclusive day count of a bounded range. */
export function inclusiveDays(start: IsoDate, end: IsoDate): number {
  return toDayNumber(end) - toDayNumber(start) + 1;
}

/** Bounds of a billing month given its first day, e.g. `2026-08-01`. */
export function periodBounds(periodMonth: IsoDate): { start: IsoDate; end: IsoDate; days: number } {
  const start = monthStart(periodMonth);
  const end = monthEnd(periodMonth);
  return { start, end, days: inclusiveDays(start, end) };
}
