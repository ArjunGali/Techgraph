import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { distribute, formatPaise, proRate, rupeesToPaise, sumPaise } from './money.js';

describe('money formatting', () => {
  it('formats paise as rupees with Indian digit grouping', () => {
    assert.equal(formatPaise(0), '₹0.00');
    assert.equal(formatPaise(150), '₹1.50');
    assert.equal(formatPaise(15000), '₹150.00');
    assert.equal(formatPaise(847500), '₹8,475.00');
    assert.equal(formatPaise(125000), '₹1,250.00');
    assert.equal(formatPaise(1234567), '₹12,345.67');
    assert.equal(formatPaise(123456789), '₹12,34,567.89', 'lakhs group in pairs');
    assert.equal(formatPaise(-50000), '-₹500.00');
  });

  it('converts rupees to paise without float drift', () => {
    assert.equal(rupeesToPaise(12.5), 1250);
    assert.equal(rupeesToPaise(8475), 847500);
    assert.equal(rupeesToPaise(0.1 + 0.2), 30);
  });
});

describe('proration', () => {
  it('charges a full month at the exact monthly figure', () => {
    assert.equal(proRate(700000, 31, 31), 700000);
    assert.equal(proRate(700000, 28, 28), 700000);
  });

  it('prorates a part month by days', () => {
    // ₹7,000 for 15 of 31 days = ₹3,387.10
    assert.equal(proRate(700000, 15, 31), 338710);
    // ₹7,500 for 16 of 31 days = ₹3,870.97
    assert.equal(proRate(750000, 16, 31), 387097);
  });

  it('handles a zero-day segment', () => {
    assert.equal(proRate(700000, 0, 31), 0);
  });
});

describe('distributing an amount across weighted shares', () => {
  it('splits the electricity worked example so the parts add to the whole', () => {
    const result = distribute(125_000, [
      { key: 'A', weight: 31 },
      { key: 'B', weight: 31 },
      { key: 'C', weight: 15 },
    ]);
    assert.deepEqual(
      result.map((share) => share.amount),
      [50_325, 50_325, 24_350],
    );
    assert.equal(sumPaise(result.map((share) => share.amount)), 125_000);
  });

  it('never loses or invents a paise, whatever the split', () => {
    // Rounding each share on its own would drift; the largest-remainder method
    // must hold the invariant for every shape of input.
    for (let total = 0; total < 400; total += 7) {
      for (let people = 1; people <= 9; people += 1) {
        for (let spread = 1; spread <= 5; spread += 1) {
          const shares = Array.from({ length: people }, (_, index) => ({
            key: index,
            weight: 1 + ((index * spread) % 31),
          }));
          const allocated = distribute(total, shares);
          assert.equal(
            sumPaise(allocated.map((share) => share.amount)),
            total,
            `total ${total} across ${people} shares (spread ${spread})`,
          );
        }
      }
    }
  });

  it('gives each share within one paise of its exact entitlement', () => {
    const allocated = distribute(100_001, [
      { key: 'a', weight: 1 },
      { key: 'b', weight: 1 },
      { key: 'c', weight: 1 },
    ]);
    for (const share of allocated) {
      assert.ok(
        Math.abs(share.amount - share.exact) < 1,
        `${share.amount} should be within a paise of ${share.exact}`,
      );
    }
    assert.equal(sumPaise(allocated.map((share) => share.amount)), 100_001);
  });

  it('is deterministic when remainders tie', () => {
    const first = distribute(100, [
      { key: 'x', weight: 1 },
      { key: 'y', weight: 1 },
      { key: 'z', weight: 1 },
    ]);
    const second = distribute(100, [
      { key: 'x', weight: 1 },
      { key: 'y', weight: 1 },
      { key: 'z', weight: 1 },
    ]);
    assert.deepEqual(first, second);
    // 100 / 3 = 33.33 each; the two spare paise go to the first two by order.
    assert.deepEqual(first.map((share) => share.amount), [34, 33, 33]);
  });

  it('charges nobody when there are no occupancy days', () => {
    const allocated = distribute(125_000, [{ key: 'a', weight: 0 }]);
    assert.deepEqual(allocated.map((share) => share.amount), [0]);
  });

  it('returns nothing for an empty set of shares', () => {
    assert.deepEqual(distribute(125_000, []), []);
  });
});
