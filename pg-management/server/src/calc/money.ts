/**
 * Money handling for the calculation engine.
 *
 * Every amount in this system is an integer number of **paise** (1 rupee =
 * 100 paise). Rupees are only ever produced for display. Doing arithmetic in
 * integers means a bill total is exact: no float can turn ₹8,475.00 into
 * ₹8,474.999999.
 */

/** An integer number of paise. */
export type Paise = number;

export function assertPaise(value: number, label = 'amount'): Paise {
  if (!Number.isInteger(value)) {
    throw new RangeError(`${label} must be a whole number of paise, received ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} is outside the safe integer range: ${value}`);
  }
  return value;
}

export function rupeesToPaise(rupees: number): Paise {
  return Math.round(rupees * 100);
}

export function paiseToRupees(paise: Paise): number {
  return paise / 100;
}

/** Formats paise as `₹8,475.00` for display and message bodies. */
export function formatPaise(paise: Paise): string {
  const negative = paise < 0;
  const absolute = Math.abs(paise);
  const whole = Math.floor(absolute / 100);
  const fraction = String(absolute % 100).padStart(2, '0');
  // Indian digit grouping: last three digits, then pairs (12,34,567).
  const digits = String(whole);
  const head = digits.length > 3 ? digits.slice(0, -3) : '';
  const tail = digits.slice(-3);
  const groupedHead = head.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  const grouped = head ? `${groupedHead},${tail}` : tail;
  return `${negative ? '-' : ''}₹${grouped}.${fraction}`;
}

/** Rounds half away from zero, so 0.5 paise becomes 1 and -0.5 becomes -1. */
export function roundHalfUp(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * Multiplies `paise` by the fraction `numerator / denominator`, rounding to
 * whole paise. Used for prorating a monthly rent across part of a month.
 */
export function proRate(paise: Paise, numerator: number, denominator: number): Paise {
  if (denominator === 0) return 0;
  if (numerator === denominator) return paise; // exact, no rounding drift
  return roundHalfUp((paise * numerator) / denominator);
}

export type Share<T> = { key: T; weight: number };
export type Allocation<T> = {
  key: T;
  weight: number;
  /** Exact unrounded share, kept for the audit breakdown. */
  exact: number;
  /** The whole-paise amount actually charged. */
  amount: Paise;
};

/**
 * Splits `total` paise across weighted shares so that the parts add back up to
 * `total` exactly.
 *
 * Rounding each share independently would leak or invent a paise or two — a
 * ₹1,250 electricity bill split three ways could bill out as ₹1,250.01. This
 * uses the largest-remainder method: every share takes its floor, then the
 * leftover paise go one each to the shares with the largest discarded
 * fractions. Ties are broken by input order, so the result is deterministic
 * and a recomputed historical bill always produces the same figures.
 */
export function distribute<T>(total: Paise, shares: Share<T>[]): Allocation<T>[] {
  assertPaise(total, 'total');
  const totalWeight = shares.reduce((sum, share) => sum + share.weight, 0);

  if (shares.length === 0) return [];
  if (totalWeight <= 0) {
    return shares.map((share) => ({ key: share.key, weight: share.weight, exact: 0, amount: 0 }));
  }

  const allocations = shares.map((share, index) => {
    const exact = (total * share.weight) / totalWeight;
    const floor = Math.floor(exact);
    return { index, key: share.key, weight: share.weight, exact, amount: floor, remainder: exact - floor };
  });

  const distributed = allocations.reduce((sum, item) => sum + item.amount, 0);
  let leftover = total - distributed;

  const byRemainder = [...allocations].sort(
    (a, b) => b.remainder - a.remainder || a.index - b.index,
  );
  for (let i = 0; leftover > 0 && i < byRemainder.length; i += 1, leftover -= 1) {
    byRemainder[i]!.amount += 1;
  }

  return allocations.map(({ key, weight, exact, amount }) => ({ key, weight, exact, amount }));
}

export function sumPaise(values: Paise[]): Paise {
  return values.reduce((total, value) => total + value, 0);
}
