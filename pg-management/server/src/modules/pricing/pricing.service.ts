import type { Db } from '../../db/pool.js';
import { query } from '../../db/pool.js';
import { unprocessable } from '../../lib/errors.js';

/**
 * Resolves the rent and the administered rates that applied on a given date.
 *
 * Prices are effective-dated and never overwritten, so asking for "the rate on
 * 5 August" always returns what was actually in force then — which is what
 * makes a bill from a closed month reproducible after a price rise.
 */

export type ResolvedPrice = {
  priceRuleId: string;
  monthlyRentPaise: number;
  /** Which kind of rule matched, for the breakdown. */
  matchedOn: 'room' | 'branch_sharing' | 'sharing' | 'branch';
};

/**
 * The most specific rule in force on `onDate`, in this order:
 * the room itself, then the sharing size within the branch, then that sharing
 * size anywhere, then the branch default.
 */
export async function resolvePrice(
  db: Db | { query: typeof query },
  params: { branchId: string; roomId: string; sharingCapacity: number; onDate: string },
): Promise<ResolvedPrice | null> {
  const { rows } = await db.query<{
    id: string;
    monthly_rent_paise: number;
    matched_on: ResolvedPrice['matchedOn'];
  }>(
    `SELECT id, monthly_rent_paise,
            CASE
              WHEN room_id IS NOT NULL THEN 'room'
              WHEN branch_id IS NOT NULL AND sharing_capacity IS NOT NULL THEN 'branch_sharing'
              WHEN sharing_capacity IS NOT NULL THEN 'sharing'
              ELSE 'branch'
            END AS matched_on
       FROM price_rules
      WHERE effective_from <= $4::date
        AND (effective_to IS NULL OR effective_to >= $4::date)
        AND (
          room_id = $2
          OR (room_id IS NULL AND branch_id = $1 AND sharing_capacity = $3)
          OR (room_id IS NULL AND branch_id IS NULL AND sharing_capacity = $3)
          OR (room_id IS NULL AND branch_id = $1 AND sharing_capacity IS NULL)
        )
      ORDER BY
        CASE
          WHEN room_id IS NOT NULL THEN 1
          WHEN branch_id IS NOT NULL AND sharing_capacity IS NOT NULL THEN 2
          WHEN sharing_capacity IS NOT NULL THEN 3
          ELSE 4
        END,
        effective_from DESC
      LIMIT 1`,
    [params.branchId, params.roomId, params.sharingCapacity, params.onDate],
  );

  const row = rows[0];
  if (!row) return null;
  return {
    priceRuleId: row.id,
    monthlyRentPaise: row.monthly_rent_paise,
    matchedOn: row.matched_on,
  };
}

export async function requirePrice(
  db: Db | { query: typeof query },
  params: { branchId: string; roomId: string; sharingCapacity: number; onDate: string },
): Promise<ResolvedPrice> {
  const price = await resolvePrice(db, params);
  if (!price) {
    throw unprocessable(
      `No rent is configured for ${params.sharingCapacity} sharing on ${params.onDate}. ` +
        'Set a price for this sharing size before admitting a tenant.',
    );
  }
  return price;
}

export type ChargeKind = 'eb_rate' | 'common_charge';

/** Sensible defaults, used only when no rate has been configured at all. */
const FALLBACK_RATES: Record<ChargeKind, number> = {
  eb_rate: 1250, // ₹12.50 per unit
  common_charge: 15_000, // ₹150
};

/**
 * The administered rate in force on a date — branch-specific if one exists,
 * otherwise the business-wide value.
 */
export async function resolveChargeRate(
  db: Db | { query: typeof query },
  params: { branchId: string; charge: ChargeKind; onDate: string },
): Promise<number> {
  const { rows } = await db.query<{ value_paise: number }>(
    `SELECT value_paise FROM charge_rates
      WHERE charge = $2
        AND (branch_id = $1 OR branch_id IS NULL)
        AND effective_from <= $3::date
        AND (effective_to IS NULL OR effective_to >= $3::date)
      ORDER BY (branch_id IS NOT NULL) DESC, effective_from DESC
      LIMIT 1`,
    [params.branchId, params.charge, params.onDate],
  );
  return rows[0]?.value_paise ?? FALLBACK_RATES[params.charge];
}
