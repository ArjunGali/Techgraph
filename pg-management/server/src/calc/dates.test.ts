import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  clampRange,
  daysInMonth,
  inclusiveDays,
  monthEnd,
  monthStart,
  overlapDays,
  periodBounds,
  assertIsoDate,
} from './dates.js';

describe('calendar arithmetic', () => {
  it('reports the right length for 28, 29, 30 and 31 day months', () => {
    assert.equal(daysInMonth('2026-02-01'), 28, 'February in a common year');
    assert.equal(daysInMonth('2024-02-15'), 29, 'February in a leap year');
    assert.equal(daysInMonth('2000-02-01'), 29, 'a century divisible by 400 is a leap year');
    assert.equal(daysInMonth('1900-02-01'), 28, 'a century not divisible by 400 is not');
    assert.equal(daysInMonth('2026-04-10'), 30);
    assert.equal(daysInMonth('2026-08-31'), 31);
  });

  it('finds month boundaries', () => {
    assert.equal(monthStart('2026-08-17'), '2026-08-01');
    assert.equal(monthEnd('2026-08-17'), '2026-08-31');
    assert.equal(monthEnd('2024-02-05'), '2024-02-29');
  });

  it('counts inclusive days so a single day is one day', () => {
    assert.equal(inclusiveDays('2026-08-01', '2026-08-01'), 1);
    assert.equal(inclusiveDays('2026-08-01', '2026-08-15'), 15);
    assert.equal(inclusiveDays('2026-08-01', '2026-08-31'), 31);
  });

  it('is not affected by the process timezone', () => {
    // Date-only arithmetic must not shift across a DST or UTC-offset boundary.
    const original = process.env.TZ;
    try {
      process.env.TZ = 'Pacific/Kiritimati'; // UTC+14
      assert.equal(addDays('2026-08-31', 1), '2026-09-01');
      process.env.TZ = 'Pacific/Midway'; // UTC-11
      assert.equal(addDays('2026-08-31', 1), '2026-09-01');
      assert.equal(daysInMonth('2026-02-01'), 28);
    } finally {
      process.env.TZ = original;
    }
  });

  it('rejects malformed and impossible dates', () => {
    assert.throws(() => assertIsoDate('2026-8-1'), RangeError);
    assert.throws(() => assertIsoDate('2026-02-30'), RangeError);
    assert.throws(() => assertIsoDate('not-a-date'), RangeError);
    assert.equal(assertIsoDate('2026-02-28'), '2026-02-28');
  });
});

describe('range overlap', () => {
  const august = { start: '2026-08-01', end: '2026-08-31' };

  it('counts both endpoints', () => {
    assert.equal(overlapDays({ start: '2026-08-01', end: '2026-08-15' }, august), 15);
    assert.equal(overlapDays({ start: '2026-08-16', end: '2026-08-31' }, august), 16);
    assert.equal(overlapDays({ start: '2026-08-01', end: '2026-08-31' }, august), 31);
  });

  it('treats an open-ended stay as running to the end of the month', () => {
    assert.equal(overlapDays({ start: '2026-08-20', end: null }, august), 12);
    assert.equal(overlapDays({ start: '2026-07-01', end: null }, august), 31);
  });

  it('clips a stay that starts before or ends after the month', () => {
    assert.equal(overlapDays({ start: '2026-06-01', end: '2026-08-10' }, august), 10);
    assert.equal(overlapDays({ start: '2026-08-25', end: '2026-09-30' }, august), 7);
  });

  it('returns zero for a stay that never touches the month', () => {
    assert.equal(overlapDays({ start: '2026-09-01', end: '2026-09-30' }, august), 0);
    assert.equal(overlapDays({ start: '2026-06-01', end: '2026-07-31' }, august), 0);
    assert.equal(clampRange({ start: '2026-09-01', end: null }, august), null);
  });

  it('adjacent stays cover the month exactly once between them', () => {
    // A move on 16 August must not double-count or skip a day.
    const before = overlapDays({ start: '2026-08-01', end: '2026-08-15' }, august);
    const after = overlapDays({ start: '2026-08-16', end: null }, august);
    assert.equal(before + after, 31);
  });
});

describe('period bounds', () => {
  it('derives the month window from its first day', () => {
    assert.deepEqual(periodBounds('2026-02-01'), {
      start: '2026-02-01',
      end: '2026-02-28',
      days: 28,
    });
    assert.deepEqual(periodBounds('2024-02-01'), {
      start: '2024-02-01',
      end: '2024-02-29',
      days: 29,
    });
  });
});
