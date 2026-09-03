import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateBill, explainBill } from './bill.js';
import { calculateEb } from './eb.js';
import { segmentsForPeriod, occupancyByTenant, groupByMeter } from './occupancy.js';
import { formatPaise } from './money.js';
import type { StaySegment } from './types.js';

const EB_RATE = 1250;
const COMMON_CHARGE = 15_000;

let sequence = 0;

function stay(
  tenantId: string,
  tenantName: string,
  startDate: string,
  endDate: string | null,
  rentPaise: number,
  roomCode = 'GF-5S-01',
  sharingCapacity = 5,
): StaySegment {
  sequence += 1;
  return {
    stayId: `stay-${sequence}`,
    tenantId,
    tenantName,
    roomId: `room-${roomCode}`,
    roomCode,
    meterId: 'meter-1',
    sharingCapacity,
    monthlyRentPaise: rentPaise,
    startDate,
    endDate,
  };
}

describe('assembling a bill', () => {
  it('adds rent, electricity and the common charge into one total', () => {
    const month = '2026-08-01';
    const stays = [stay('t1', 'Arun', '2026-01-01', null, 700_000)];
    const segments = segmentsForPeriod(stays, month);

    const eb = calculateEb({
      periodMonth: month,
      meterId: 'meter-1',
      meterCode: 'MTR-GF',
      previousReading: 100,
      currentReading: 200,
      ebRatePaise: EB_RATE,
      commonChargePaise: COMMON_CHARGE,
      segments,
    });

    const bill = calculateBill({
      periodMonth: month,
      tenantId: 't1',
      tenantName: 'Arun',
      segments,
      ebShare: eb.tenants[0]!,
    });

    assert.equal(bill.rentPaise, 700_000);
    assert.equal(bill.ebPaise, 125_000, 'the only tenant carries the whole meter');
    assert.equal(bill.commonChargePaise, 15_000);
    assert.equal(bill.totalPaise, 840_000);
    assert.equal(formatPaise(bill.totalPaise), '₹8,400.00');
  });

  it('applies charges, discounts, adjustments and dues brought forward', () => {
    const month = '2026-08-01';
    const segments = segmentsForPeriod(
      [stay('t1', 'Arun', '2026-01-01', null, 700_000)],
      month,
    );

    const bill = calculateBill({
      periodMonth: month,
      tenantId: 't1',
      tenantName: 'Arun',
      segments,
      ebShare: null,
      otherCharges: [{ description: 'Laundry', amountPaise: 30_000 }],
      discounts: [{ description: 'Referral credit', amountPaise: 20_000 }],
      adjustments: [{ description: 'Rounding correction', amountPaise: -500 }],
      previousDuesPaise: 50_000,
      paidPaise: 500_000,
    });

    // 7000 + 300 - 200 - 5 + 500 = 7595
    assert.equal(bill.totalPaise, 759_500);
    assert.equal(bill.paidPaise, 500_000);
    assert.equal(bill.outstandingPaise, 259_500);
    assert.equal(formatPaise(bill.outstandingPaise), '₹2,595.00');
  });

  it('tracks a partial payment as an outstanding balance', () => {
    const segments = segmentsForPeriod(
      [stay('t1', 'Arun', '2026-01-01', null, 700_000)],
      '2026-08-01',
    );
    const bill = calculateBill({
      periodMonth: '2026-08-01',
      tenantId: 't1',
      tenantName: 'Arun',
      segments,
      ebShare: null,
      previousDuesPaise: 50_000,
      paidPaise: 500_000,
    });
    // Opening due ₹500 + bill ₹7,000 = ₹7,500, paid ₹5,000, outstanding ₹2,500.
    assert.equal(bill.totalPaise, 750_000);
    assert.equal(bill.outstandingPaise, 250_000);
  });

  it('itemises every line for the breakdown', () => {
    const segments = segmentsForPeriod(
      [
        stay('t1', 'Arun', '2026-08-01', '2026-08-15', 600_000, 'GF-6S-01', 6),
        stay('t1', 'Arun', '2026-08-16', null, 700_000, 'GF-5S-01', 5),
      ],
      '2026-08-01',
    );
    const bill = calculateBill({
      periodMonth: '2026-08-01',
      tenantId: 't1',
      tenantName: 'Arun',
      segments,
      ebShare: null,
    });

    const rentLines = bill.lines.filter((line) => line.itemType === 'rent');
    assert.equal(rentLines.length, 2, 'one line per stay period');
    assert.match(rentLines[0]!.description, /GF-6S-01 \(6 sharing\), 15\/31 days/);
    assert.match(rentLines[1]!.description, /GF-5S-01 \(5 sharing\), 16\/31 days/);
    assert.equal(bill.occupancyDays, 31);
  });
});

describe('a full month of the Ekkatuthangal 5-sharing room', () => {
  // Three tenants; one leaves on the 15th. This is the scenario from the
  // specification, carried all the way through to per-tenant bills.
  const month = '2026-08-01';
  const stays = [
    stay('a', 'Tenant A', '2026-01-01', null, 700_000),
    stay('b', 'Tenant B', '2026-01-01', null, 700_000),
    stay('c', 'Tenant C', '2026-01-01', '2026-08-15', 700_000),
  ];
  const segments = segmentsForPeriod(stays, month);
  const eb = calculateEb({
    periodMonth: month,
    meterId: 'meter-1',
    meterCode: 'MTR-GF',
    previousReading: 100,
    currentReading: 200,
    ebRatePaise: EB_RATE,
    commonChargePaise: COMMON_CHARGE,
    segments,
  });

  const bills = eb.tenants.map((share) =>
    calculateBill({
      periodMonth: month,
      tenantId: share.tenantId,
      tenantName: share.tenantName,
      segments: segments.filter((segment) => segment.tenantId === share.tenantId),
      ebShare: share,
    }),
  );

  it('bills the two full-month tenants identically', () => {
    const [a, b] = bills;
    assert.equal(a!.rentPaise, 700_000);
    assert.equal(a!.ebPaise, 50_325);
    assert.equal(a!.commonChargePaise, 15_000);
    assert.equal(a!.totalPaise, 765_325); // ₹7,653.25
    assert.deepEqual(a!.totalPaise, b!.totalPaise);
  });

  it('bills the departing tenant for half the rent and half the days', () => {
    const c = bills[2]!;
    assert.equal(c.rentPaise, 338_710, 'rent prorated to 15 of 31 days');
    assert.equal(c.ebPaise, 24_350, 'electricity for 15 occupancy days');
    assert.equal(c.totalPaise, 378_060); // ₹3,780.60
  });

  it('bills out exactly the electricity the meter recorded', () => {
    const billedEb = bills.reduce((sum, bill) => sum + bill.ebPaise, 0);
    assert.equal(billedEb, eb.totalEbPaise);
    assert.equal(billedEb, 125_000);
  });

  it('produces a breakdown a tenant can check by hand', () => {
    const text = explainBill(bills[2]!, eb).join('\n');
    assert.match(text, /Tenant C — bill for 2026-08/);
    assert.match(text, /₹7,000\.00 x 15\/31 days/);
    assert.match(text, /Total occupancy days: 77/);
    assert.match(text, /Total payable: ₹3,780\.60/);
  });
});

describe('grouping occupancy by meter', () => {
  it('keeps each meter\'s tenants separate', () => {
    const month = '2026-08-01';
    const stays: StaySegment[] = [
      { ...stay('a', 'A', '2026-01-01', null, 700_000), meterId: 'meter-gf' },
      { ...stay('b', 'B', '2026-01-01', null, 700_000), meterId: 'meter-f1' },
    ];
    const byMeter = groupByMeter(segmentsForPeriod(stays, month));
    assert.equal(byMeter.size, 2);
    assert.equal(byMeter.get('meter-gf')!.length, 1);
    assert.equal(byMeter.get('meter-f1')!.length, 1);
  });

  it('leaves unmetered rooms out of any apportionment', () => {
    const stays: StaySegment[] = [
      { ...stay('a', 'A', '2026-01-01', null, 700_000), meterId: null },
    ];
    const byMeter = groupByMeter(segmentsForPeriod(stays, '2026-08-01'));
    assert.equal(byMeter.size, 0);
  });

  it('counts one tenant on both meters if they moved between them', () => {
    const stays: StaySegment[] = [
      { ...stay('a', 'A', '2026-08-01', '2026-08-15', 700_000), meterId: 'meter-gf' },
      { ...stay('a', 'A', '2026-08-16', null, 700_000), meterId: 'meter-f1' },
    ];
    const byMeter = groupByMeter(segmentsForPeriod(stays, '2026-08-01'));
    assert.equal(occupancyByTenant(byMeter.get('meter-gf')!)[0]!.days, 15);
    assert.equal(occupancyByTenant(byMeter.get('meter-f1')!)[0]!.days, 16);
  });
});
