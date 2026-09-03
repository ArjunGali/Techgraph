import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CalculationError, calculateEb, explainEb } from './eb.js';
import { segmentsForPeriod } from './occupancy.js';
import { formatPaise, sumPaise } from './money.js';
import type { StaySegment } from './types.js';

const EB_RATE = 1250; // ₹12.50 per unit
const COMMON_CHARGE = 15_000; // ₹150

let sequence = 0;

/** Builds a stay in a single metered room, with sensible defaults. */
function stay(
  tenantName: string,
  startDate: string,
  endDate: string | null,
  overrides: Partial<StaySegment> = {},
): StaySegment {
  sequence += 1;
  return {
    stayId: `stay-${sequence}`,
    tenantId: overrides.tenantId ?? `tenant-${tenantName}`,
    tenantName,
    roomId: 'room-1',
    roomCode: 'GF-5S-01',
    meterId: 'meter-1',
    sharingCapacity: 5,
    monthlyRentPaise: 700_000,
    startDate,
    endDate,
    ...overrides,
  };
}

function runEb(stays: StaySegment[], periodMonth: string, previous = 100, current = 200) {
  return calculateEb({
    periodMonth,
    meterId: 'meter-1',
    meterCode: 'MTR-GF',
    previousReading: previous,
    currentReading: current,
    ebRatePaise: EB_RATE,
    commonChargePaise: COMMON_CHARGE,
    segments: segmentsForPeriod(stays, periodMonth),
  });
}

describe('the worked example from the specification', () => {
  // Previous 100, current 200, 100 units at ₹12.50 = ₹1,250.
  // Tenants of 31, 31 and 15 days give 77 total occupancy days.
  const result = runEb(
    [
      stay('Tenant A', '2026-08-01', null),
      stay('Tenant B', '2026-08-01', null),
      stay('Tenant C', '2026-08-01', '2026-08-15'),
    ],
    '2026-08-01',
  );

  it('step 1: total EB is units x rate', () => {
    assert.equal(result.totalUnits, 100);
    assert.equal(result.ebRatePaise, 1250);
    assert.equal(result.totalEbPaise, 125_000);
    assert.equal(formatPaise(result.totalEbPaise), '₹1,250.00');
  });

  it('steps 2 and 3: occupancy days are 31, 31 and 15, totalling 77', () => {
    assert.deepEqual(
      result.tenants.map((tenant) => [tenant.tenantName, tenant.occupancyDays]),
      [
        ['Tenant A', 31],
        ['Tenant B', 31],
        ['Tenant C', 15],
      ],
    );
    assert.equal(result.totalOccupancyDays, 77);
  });

  it('step 4: EB per occupancy day is the total over 77', () => {
    assert.equal(result.ebPerOccupancyDayExact, 125_000 / 77);
    assert.equal(result.ebPerOccupancyDayPaise, 1623); // ₹16.23
  });

  it('step 5: each tenant pays for the days they were there', () => {
    assert.deepEqual(
      result.tenants.map((tenant) => tenant.ebPaise),
      [50_325, 50_325, 24_350],
    );
  });

  it('step 6: the flat common charge is added per tenant', () => {
    assert.deepEqual(
      result.tenants.map((tenant) => tenant.totalPaise),
      [65_325, 65_325, 39_350],
    );
    assert.equal(formatPaise(result.tenants[0]!.totalPaise), '₹653.25');
  });

  it('apportions the electricity exactly, with nothing left over', () => {
    assert.equal(result.distributedEbPaise, result.totalEbPaise);
    assert.equal(sumPaise(result.tenants.map((tenant) => tenant.ebPaise)), 125_000);
  });

  it('produces a breakdown that shows every figure in the formula', () => {
    const text = explainEb(result).join('\n');
    assert.match(text, /Previous reading: 100/);
    assert.match(text, /Current reading: 200/);
    assert.match(text, /Units consumed: 200 - 100 = 100/);
    assert.match(text, /Total EB amount: 100 x ₹12\.50 = ₹1,250\.00/);
    assert.match(text, /Total occupancy days: 77/);
    assert.match(text, /EB per occupancy day: ₹1,250\.00 \/ 77 = ₹16\.23/);
    assert.match(text, /Tenant C: 15 days/);
  });
});

describe('the traditional shortcut is the general formula in a special case', () => {
  it('matches "days of the person who left + remaining members x days in month"', () => {
    // Four tenants; one leaves on the 12th of a 30-day month.
    const stays = [
      stay('Full One', '2026-09-01', null),
      stay('Full Two', '2026-09-01', null),
      stay('Full Three', '2026-09-01', null),
      stay('Leaver', '2026-09-01', '2026-09-12'),
    ];
    const result = runEb(stays, '2026-09-01');
    const traditional = 12 + 3 * 30;
    assert.equal(result.totalOccupancyDays, traditional);
    assert.equal(result.totalOccupancyDays, 102);
  });

  it('stays correct with several people joining and leaving at once', () => {
    const stays = [
      stay('Stayer', '2026-08-01', null), // 31
      stay('Leaver One', '2026-08-01', '2026-08-10'), // 10
      stay('Leaver Two', '2026-08-01', '2026-08-20'), // 20
      stay('Joiner One', '2026-08-11', null), // 21
      stay('Joiner Two', '2026-08-25', null), // 7
    ];
    const result = runEb(stays, '2026-08-01');
    assert.equal(result.totalOccupancyDays, 31 + 10 + 20 + 21 + 7);
    assert.equal(result.totalOccupancyDays, 89);
    assert.equal(result.distributedEbPaise, result.totalEbPaise);
  });
});

describe('tenant movement inside a billing month', () => {
  it('sums a tenant\'s days across every room they occupied', () => {
    // Arun moves from the 6-sharing to the 5-sharing on 16 August. Both rooms
    // are on the same meter, so his occupancy is the full month.
    const arunStays = [
      stay('Arun', '2026-08-01', '2026-08-15', {
        tenantId: 'tenant-arun',
        roomId: 'room-6s',
        roomCode: 'GF-6S-01',
        sharingCapacity: 6,
      }),
      stay('Arun', '2026-08-16', null, {
        tenantId: 'tenant-arun',
        roomId: 'room-5s',
        roomCode: 'GF-5S-01',
        sharingCapacity: 5,
      }),
    ];
    const result = runEb([...arunStays, stay('Other', '2026-08-01', null)], '2026-08-01');

    const arun = result.tenants.find((tenant) => tenant.tenantName === 'Arun');
    assert.ok(arun);
    assert.equal(arun.occupancyDays, 31, 'appears once, with 15 + 16 days');
    assert.equal(arun.stayPeriods.length, 2, 'both rooms are shown in the breakdown');
    assert.deepEqual(
      arun.stayPeriods.map((period) => period.roomCode),
      ['GF-6S-01', 'GF-5S-01'],
    );
    assert.equal(result.tenants.length, 2, 'a move does not create a second tenant');
    assert.equal(result.totalOccupancyDays, 62);
  });

  it('handles more than one move in the same month', () => {
    const stays = [
      stay('Mover', '2026-08-01', '2026-08-09', { tenantId: 'm', roomCode: 'R1' }),
      stay('Mover', '2026-08-10', '2026-08-19', { tenantId: 'm', roomCode: 'R2' }),
      stay('Mover', '2026-08-20', null, { tenantId: 'm', roomCode: 'R3' }),
    ];
    const result = runEb(stays, '2026-08-01');
    assert.equal(result.tenants.length, 1);
    assert.equal(result.tenants[0]!.occupancyDays, 31);
    assert.equal(result.tenants[0]!.stayPeriods.length, 3);
  });
});

describe('months of every length', () => {
  const cases: { month: string; days: number; label: string }[] = [
    { month: '2026-02-01', days: 28, label: 'February, common year' },
    { month: '2024-02-01', days: 29, label: 'February, leap year' },
    { month: '2026-09-01', days: 30, label: 'a 30-day month' },
    { month: '2026-08-01', days: 31, label: 'a 31-day month' },
  ];

  for (const { month, days, label } of cases) {
    it(`bills a full month correctly in ${label}`, () => {
      // Both tenants started long before any of the months under test, so
      // each one is present for every day of whichever month is billed.
      const result = runEb(
        [stay('A', '2020-01-01', null), stay('B', '2020-01-01', null)],
        month,
      );
      assert.equal(result.daysInMonth, days);
      assert.equal(result.totalOccupancyDays, days * 2);
      assert.equal(result.distributedEbPaise, 125_000);
      // Two identical tenants split the bill evenly.
      assert.equal(result.tenants[0]!.ebPaise, 62_500);
      assert.equal(result.tenants[1]!.ebPaise, 62_500);
    });
  }

  it('counts the 29th of a leap February', () => {
    const result = runEb([stay('A', '2024-02-01', '2024-02-29')], '2024-02-01');
    assert.equal(result.tenants[0]!.occupancyDays, 29);
  });
});

describe('edge cases and validation', () => {
  it('refuses to bill when the current reading is below the previous one', () => {
    assert.throws(
      () => runEb([stay('A', '2026-08-01', null)], '2026-08-01', 500, 400),
      (error: unknown) => {
        assert.ok(error instanceof CalculationError);
        assert.equal(error.code, 'reading_regressed');
        return true;
      },
    );
  });

  it('apportions nothing when no one occupied the rooms', () => {
    const result = runEb([], '2026-08-01');
    assert.equal(result.totalOccupancyDays, 0);
    assert.deepEqual(result.tenants, []);
    assert.equal(result.distributedEbPaise, 0);
    assert.equal(result.totalEbPaise, 125_000, 'units are still recorded for reporting');
  });

  it('gives a single tenant the whole bill', () => {
    const result = runEb([stay('Alone', '2026-08-01', null)], '2026-08-01');
    assert.equal(result.tenants[0]!.ebPaise, 125_000);
    assert.equal(result.tenants[0]!.totalPaise, 140_000);
  });

  it('charges nothing for electricity when no units were used', () => {
    const result = runEb([stay('A', '2026-08-01', null)], '2026-08-01', 500, 500);
    assert.equal(result.totalUnits, 0);
    assert.equal(result.totalEbPaise, 0);
    assert.equal(result.tenants[0]!.ebPaise, 0);
    assert.equal(result.tenants[0]!.totalPaise, COMMON_CHARGE, 'the common charge still applies');
  });

  it('handles fractional meter readings', () => {
    const result = runEb([stay('A', '2026-08-01', null)], '2026-08-01', 100.5, 240.75);
    assert.equal(result.totalUnits, 140.25);
    assert.equal(result.totalEbPaise, 175_313); // 140.25 x 1250 = 175312.5, rounded up
  });

  it('ignores a stay that ended before the billing month began', () => {
    const result = runEb(
      [stay('Past', '2026-06-01', '2026-07-15'), stay('Present', '2026-08-01', null)],
      '2026-08-01',
    );
    assert.equal(result.tenants.length, 1);
    assert.equal(result.tenants[0]!.tenantName, 'Present');
  });

  it('ignores a stay that starts after the billing month', () => {
    const result = runEb(
      [stay('Present', '2026-08-01', null), stay('Future', '2026-09-01', null)],
      '2026-08-01',
    );
    assert.equal(result.tenants.length, 1);
    assert.equal(result.tenants[0]!.tenantName, 'Present');
  });

  it('counts a one-day stay as one day', () => {
    const result = runEb(
      [stay('Long', '2026-08-01', null), stay('Overnight', '2026-08-15', '2026-08-15')],
      '2026-08-01',
    );
    const overnight = result.tenants.find((tenant) => tenant.tenantName === 'Overnight');
    assert.equal(overnight?.occupancyDays, 1);
    assert.equal(result.totalOccupancyDays, 32);
  });

  it('always apportions the exact total, across many random months', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const tenantCount = 1 + (seed % 7);
      const stays = Array.from({ length: tenantCount }, (_, index) => {
        const startDay = 1 + ((seed * (index + 3)) % 28);
        const endDay = startDay + ((seed * (index + 5)) % 20);
        return stay(
          `T${index}`,
          `2026-08-${String(startDay).padStart(2, '0')}`,
          endDay > 31 ? null : `2026-08-${String(endDay).padStart(2, '0')}`,
          { tenantId: `t-${index}` },
        );
      });
      const units = 10 + (seed % 500);
      const result = runEb(stays, '2026-08-01', 0, units);
      assert.equal(
        result.distributedEbPaise,
        result.totalEbPaise,
        `seed ${seed}: apportioned total must equal the bill`,
      );
    }
  });
});
