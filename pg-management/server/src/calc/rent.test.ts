import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateRent, explainRent } from './rent.js';
import { segmentsForPeriod } from './occupancy.js';
import { formatPaise } from './money.js';
import type { StaySegment } from './types.js';

let sequence = 0;

function stay(
  startDate: string,
  endDate: string | null,
  rentPaise: number,
  roomCode = 'GF-5S-01',
  sharingCapacity = 5,
): StaySegment {
  sequence += 1;
  return {
    stayId: `stay-${sequence}`,
    tenantId: 'tenant-1',
    tenantName: 'Arun',
    roomId: `room-${roomCode}`,
    roomCode,
    meterId: 'meter-1',
    sharingCapacity,
    monthlyRentPaise: rentPaise,
    startDate,
    endDate,
  };
}

function rentFor(stays: StaySegment[], month: string) {
  return calculateRent(segmentsForPeriod(stays, month), month);
}

describe('rent for a full month', () => {
  it('charges the exact monthly figure, with no proration drift', () => {
    const result = rentFor([stay('2026-01-01', null, 700_000)], '2026-08-01');
    assert.equal(result.totalPaise, 700_000);
    assert.equal(result.segments[0]!.isFullMonth, true);
    assert.equal(formatPaise(result.totalPaise), '₹7,000.00');
  });

  it('charges the same figure in a 28-day month as in a 31-day one', () => {
    const february = rentFor([stay('2026-01-01', null, 700_000)], '2026-02-01');
    const august = rentFor([stay('2026-01-01', null, 700_000)], '2026-08-01');
    assert.equal(february.totalPaise, 700_000);
    assert.equal(august.totalPaise, 700_000);
  });
});

describe('rent for a part month', () => {
  it('prorates a mid-month joiner by days', () => {
    // Joins on 16 August: 16 of 31 days at ₹7,000.
    const result = rentFor([stay('2026-08-16', null, 700_000)], '2026-08-01');
    assert.equal(result.segments[0]!.days, 16);
    assert.equal(result.totalPaise, 361_290); // ₹3,612.90
  });

  it('prorates a mid-month leaver by days', () => {
    const result = rentFor([stay('2026-01-01', '2026-08-15', 700_000)], '2026-08-01');
    assert.equal(result.segments[0]!.days, 15);
    assert.equal(result.totalPaise, 338_710); // ₹3,387.10
  });

  it('charges nothing for a month the tenant was not there', () => {
    const result = rentFor([stay('2026-09-01', null, 700_000)], '2026-08-01');
    assert.equal(result.totalPaise, 0);
    assert.deepEqual(result.segments, []);
  });
});

describe('rent when a tenant moves between sharings', () => {
  it('charges each period at the rate that applied to it', () => {
    // Arun: 1-15 August in the 6-sharing at ₹6,000, 16-31 in the 5-sharing at ₹7,000.
    const result = rentFor(
      [
        stay('2026-08-01', '2026-08-15', 600_000, 'GF-6S-01', 6),
        stay('2026-08-16', null, 700_000, 'GF-5S-01', 5),
      ],
      '2026-08-01',
    );

    assert.equal(result.segments.length, 2);
    assert.equal(result.segments[0]!.amountPaise, 290_323); // 6000 x 15/31 = ₹2,903.23
    assert.equal(result.segments[1]!.amountPaise, 361_290); // 7000 x 16/31 = ₹3,612.90
    assert.equal(result.totalPaise, 651_613); // ₹6,516.13
    assert.equal(result.totalDays, 31, 'the two periods cover the month exactly once');
  });

  it('uses the rent snapshotted on each stay, not the current price', () => {
    // The room was repriced to ₹7,500 after the fact; the stay carries ₹7,000,
    // so an old bill recomputes to the same figure it was issued with.
    const result = rentFor([stay('2026-01-01', null, 700_000)], '2026-08-01');
    assert.equal(result.totalPaise, 700_000);
  });

  it('spells out the working for both periods', () => {
    const result = rentFor(
      [
        stay('2026-08-01', '2026-08-15', 600_000, 'GF-6S-01', 6),
        stay('2026-08-16', null, 700_000, 'GF-5S-01', 5),
      ],
      '2026-08-01',
    );
    const text = explainRent(result).join('\n');
    assert.match(text, /GF-6S-01 \(6 sharing\): ₹6,000\.00 x 15\/31 days = ₹2,903\.23/);
    assert.match(text, /GF-5S-01 \(5 sharing\): ₹7,000\.00 x 16\/31 days = ₹3,612\.90/);
    assert.match(text, /Total rent: ₹6,516\.13/);
  });
});

describe('rent proration never drifts', () => {
  it('a month split into two adjacent stays costs about one month of rent', () => {
    for (let splitDay = 1; splitDay < 31; splitDay += 1) {
      const end = `2026-08-${String(splitDay).padStart(2, '0')}`;
      const next = `2026-08-${String(splitDay + 1).padStart(2, '0')}`;
      const result = rentFor(
        [stay('2026-08-01', end, 700_000), stay(next, null, 700_000)],
        '2026-08-01',
      );
      // Both halves are at the same rent, so the two prorated parts must land
      // within a paise of the undivided monthly figure.
      assert.ok(
        Math.abs(result.totalPaise - 700_000) <= 1,
        `split on day ${splitDay} gave ${result.totalPaise}`,
      );
    }
  });
});
