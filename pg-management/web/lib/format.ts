/**
 * Display formatting.
 *
 * All money crosses the API as integer paise; it becomes a rupee string only
 * at the point of display, so no rounding ever happens in the client.
 */
export function formatPaise(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return '—';
  const negative = paise < 0;
  const absolute = Math.abs(paise);
  const whole = Math.floor(absolute / 100);
  const fraction = String(absolute % 100).padStart(2, '0');
  const digits = String(whole);
  const head = digits.length > 3 ? digits.slice(0, -3) : '';
  const tail = digits.slice(-3);
  // Indian grouping: the last three digits, then pairs — 12,34,567.
  const grouped = head ? `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${tail}` : tail;
  return `${negative ? '-' : ''}₹${grouped}.${fraction}`;
}

/** Rupees only, for tight spaces such as stat tiles on a small phone. */
export function formatRupees(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return '—';
  return formatPaise(Math.round(paise / 100) * 100).replace('.00', '');
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = iso.slice(0, 10);
  const [year, month, day] = date.split('-');
  if (!year || !month || !day) return date;
  return `${Number(day)} ${MONTHS[Number(month) - 1]?.slice(0, 3)} ${year}`;
}

export function formatMonth(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [year, month] = iso.slice(0, 7).split('-');
  return `${MONTHS[Number(month) - 1]} ${year}`;
}

export function currentPeriodMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
}

export function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
}

export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}
