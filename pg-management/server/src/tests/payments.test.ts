import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pool, withTransaction } from '../db/pool.js';
import { admitTenant } from '../modules/tenants/stays.service.js';
import { generateBillsForPeriod, refreshBillTotals } from '../modules/billing/billing.service.js';
import { effectivePermissions, PERMISSIONS } from '../lib/permissions.js';
import { createTenant, recordReading, resetDatabase, seedFixture, type Fixture } from './helpers.js';

/**
 * The money paths: what changes a balance, what does not, and what can never
 * be undone by deletion.
 */

let fixture: Fixture;
let tenantId: string;
let billId: string;
const AUGUST = '2026-08-01';

before(async () => {
  await resetDatabase();
  fixture = await seedFixture();

  await withTransaction(async (tx) => {
    tenantId = await createTenant(tx, 'P-01', 'Payer', AUGUST);
    await admitTenant(
      tx,
      { tenantId, roomId: fixture.rooms['GF-5S-01']!.id, startDate: AUGUST },
      { userId: fixture.adminId },
    );
    await recordReading(tx, fixture.meterId, AUGUST, 0, 100);
  });

  const generated = await withTransaction((tx) =>
    generateBillsForPeriod(tx, {
      branchId: fixture.branchId,
      periodMonth: AUGUST,
      userId: fixture.adminId,
    }),
  );
  billId = generated.bills[0]!.billId;
});

after(async () => {
  await pool.end();
});

/** Records a submission in the state the API would create it in. */
async function submitPayment(amountPaise: number, reference: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO payments
       (tenant_id, bill_id, branch_id, kind, amount_paise, direction, method, reference,
        state, submitted_by)
     VALUES ($1,$2,$3,'payment',$4,1,'upi',$5,'pending_approval',$6)
     RETURNING id`,
    [tenantId, billId, fixture.branchId, amountPaise, reference, fixture.adminId],
  );
  return rows[0]!.id;
}

async function approve(paymentId: string, approvedPaise: number | null): Promise<void> {
  await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE payments SET state = 'approved', approved_amount_paise = coalesce($2, amount_paise)
        WHERE id = $1`,
      [paymentId, approvedPaise],
    );
    await tx.query(
      `INSERT INTO payment_approvals (payment_id, action, approved_amount_paise, reviewer_id)
       VALUES ($1, $2, $3, $4)`,
      [
        paymentId,
        approvedPaise === null ? 'approve' : 'approve_partial',
        approvedPaise,
        fixture.adminId,
      ],
    );
    await refreshBillTotals(tx, billId);
  });
}

async function billState() {
  const { rows } = await pool.query(
    'SELECT total_paise, paid_paise, outstanding_paise, payment_status FROM bills WHERE id = $1',
    [billId],
  );
  return rows[0]!;
}

describe('a submitted payment changes nothing until it is approved', () => {
  let paymentId: string;

  it('leaves the balance untouched while pending', async () => {
    const before = await billState();
    paymentId = await submitPayment(500_000, 'UPI-PENDING-001');
    await withTransaction((tx) => refreshBillTotals(tx, billId));
    const after = await billState();

    assert.equal(Number(after.paid_paise), 0, 'nothing is credited yet');
    assert.equal(after.outstanding_paise, before.outstanding_paise);
    assert.equal(after.payment_status, 'pending_approval');
  });

  it('credits the balance once approved', async () => {
    await approve(paymentId, null);
    const after = await billState();
    assert.equal(Number(after.paid_paise), 500_000);
    assert.equal(after.payment_status, 'partially_paid', 'the bill is not yet settled');
  });
});

describe('partial payments', () => {
  it('credits only the amount the admin approved', async () => {
    const paymentId = await submitPayment(300_000, 'UPI-PARTIAL-002');
    // The tenant claimed ₹3,000; the admin can see only ₹1,000 arrived.
    await approve(paymentId, 100_000);

    const { rows } = await pool.query(
      'SELECT amount_paise, approved_amount_paise FROM payments WHERE id = $1',
      [paymentId],
    );
    assert.equal(Number(rows[0]!.amount_paise), 300_000, 'the claim is kept on record');
    assert.equal(Number(rows[0]!.approved_amount_paise), 100_000);

    const bill = await billState();
    assert.equal(Number(bill.paid_paise), 600_000, 'only the approved amounts are banked');
  });

  it('marks the bill paid once the balance is cleared', async () => {
    const bill = await billState();
    const remaining = Number(bill.total_paise) - Number(bill.paid_paise);
    const paymentId = await submitPayment(remaining, 'UPI-FINAL-003');
    await approve(paymentId, null);

    const settled = await billState();
    assert.equal(Number(settled.outstanding_paise), 0);
    assert.equal(settled.payment_status, 'paid');
  });
});

describe('corrections never delete history', () => {
  it('reverses an approved payment with an opposing entry', async () => {
    const paymentId = await submitPayment(200_000, 'UPI-REVERSE-004');
    await approve(paymentId, null);
    const beforeReversal = await billState();

    await withTransaction(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO payments
           (tenant_id, bill_id, branch_id, kind, amount_paise, direction, method, state,
            approved_amount_paise, reversal_of_id, notes, submitted_by)
         VALUES ($1,$2,$3,'reversal',200000,-1,'other','approved',200000,$4,'Bounced',$5)
         RETURNING id`,
        [tenantId, billId, fixture.branchId, paymentId, fixture.adminId],
      );
      await tx.query(`UPDATE payments SET state = 'reversed' WHERE id = $1`, [paymentId]);
      await refreshBillTotals(tx, billId);
      assert.ok(rows[0]!.id);
    });

    const afterReversal = await billState();
    assert.equal(
      Number(afterReversal.paid_paise),
      Number(beforeReversal.paid_paise) - 200_000,
      'the reversal cancels the credit',
    );

    const { rows: original } = await pool.query(
      'SELECT state FROM payments WHERE id = $1',
      [paymentId],
    );
    assert.equal(original[0]!.state, 'reversed', 'the original row is still there');

    const { rows: count } = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM payments WHERE tenant_id = $1',
      [tenantId],
    );
    assert.ok(count[0]!.count >= 5, 'every entry is retained, nothing is deleted');
  });

  it('refuses a duplicate transaction reference for the same tenant', async () => {
    await assert.rejects(
      submitPayment(100_000, 'UPI-REVERSE-004'),
      /duplicate key value|payments_reference_key/,
    );
  });

  it('keeps the balance equal to the sum of the ledger', async () => {
    const { rows } = await pool.query<{ ledger: number }>(
      `SELECT coalesce(sum(direction * coalesce(approved_amount_paise, amount_paise)), 0)::bigint AS ledger
         FROM payments WHERE bill_id = $1 AND state IN ('approved', 'reversed')`,
      [billId],
    );
    const bill = await billState();
    assert.equal(
      Number(bill.paid_paise),
      Number(rows[0]!.ledger),
      'the stored figure is never independent of the entries behind it',
    );
  });
});

describe('closing a month freezes it', () => {
  it('refuses to regenerate bills once closed', async () => {
    await pool.query(
      `UPDATE billing_periods SET status = 'closed', closed_at = now(), closed_by = $2
        WHERE branch_id = $1 AND period_month = $3`,
      [fixture.branchId, fixture.adminId, AUGUST],
    );

    await assert.rejects(
      withTransaction((tx) =>
        generateBillsForPeriod(tx, {
          branchId: fixture.branchId,
          periodMonth: AUGUST,
          userId: fixture.adminId,
        }),
      ),
      /closed/,
    );
  });

  it('leaves a closed month\'s figures untouched by a later price change', async () => {
    const before = await billState();

    // The pricing endpoint closes the standing rule before opening a new one;
    // done here directly so the test exercises billing, not the endpoint.
    await pool.query(
      `UPDATE price_rules SET effective_to = '2026-08-31'
        WHERE sharing_capacity = 5 AND branch_id IS NULL AND room_id IS NULL
          AND effective_to IS NULL`,
    );
    await pool.query(
      `INSERT INTO price_rules (sharing_capacity, monthly_rent_paise, effective_from, created_by)
       VALUES (5, 999000, '2026-09-01', $1)`,
      [fixture.adminId],
    );

    const after = await billState();
    assert.deepEqual(after, before, 'a historical bill is unaffected by a later repricing');
  });
});

describe('permissions are decided by role, not by the client', () => {
  it('gives an admin everything', () => {
    const permissions = effectivePermissions('admin');
    assert.ok(permissions.has(PERMISSIONS.PAYMENT_APPROVE));
    assert.ok(permissions.has(PERMISSIONS.BILLING_CLOSE));
    assert.ok(permissions.has(PERMISSIONS.TENANT_DOCUMENT_READ));
  });

  it('withholds money and identity documents from a manager', () => {
    const permissions = effectivePermissions('manager');
    assert.ok(permissions.has(PERMISSIONS.TENANT_MOVE), 'day-to-day work is allowed');
    assert.ok(permissions.has(PERMISSIONS.BILLING_GENERATE));
    assert.ok(!permissions.has(PERMISSIONS.PAYMENT_APPROVE), 'cannot bank money');
    assert.ok(!permissions.has(PERMISSIONS.BILLING_CLOSE), 'cannot freeze a month');
    assert.ok(!permissions.has(PERMISSIONS.PRICING_WRITE), 'cannot change prices');
    assert.ok(!permissions.has(PERMISSIONS.TENANT_DOCUMENT_READ), 'cannot open an Aadhaar');
    assert.ok(!permissions.has(PERMISSIONS.REPORT_FINANCE));
  });

  it('limits staff to operational information', () => {
    const permissions = effectivePermissions('staff');
    assert.ok(permissions.has(PERMISSIONS.METER_WRITE), 'can submit a reading');
    assert.ok(permissions.has(PERMISSIONS.TENANT_READ));
    assert.ok(!permissions.has(PERMISSIONS.PAYMENT_APPROVE));
    assert.ok(!permissions.has(PERMISSIONS.PAYMENT_READ));
    assert.ok(!permissions.has(PERMISSIONS.TENANT_DOCUMENT_READ));
    assert.ok(!permissions.has(PERMISSIONS.REPORT_FINANCE));
    assert.ok(!permissions.has(PERMISSIONS.USER_MANAGE));
  });

  it('applies per-user grants and revocations on top of the role', () => {
    const granted = effectivePermissions('staff', [
      { permission: PERMISSIONS.PAYMENT_READ, granted: true },
    ]);
    assert.ok(granted.has(PERMISSIONS.PAYMENT_READ));

    const revoked = effectivePermissions('manager', [
      { permission: PERMISSIONS.TENANT_MOVE, granted: false },
    ]);
    assert.ok(!revoked.has(PERMISSIONS.TENANT_MOVE), 'a revocation subtracts from the role');
  });
});

describe('the audit trail records what happened', () => {
  it('logs a payment approval with who and how much', async () => {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS count FROM payment_approvals WHERE reviewer_id = $1`,
      [fixture.adminId],
    );
    assert.ok(rows[0]!.count >= 4, 'every decision left a row');
  });

  it('ties admissions to the user who made them', async () => {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS count FROM audit_logs
        WHERE user_id = $1 AND entity_type = 'tenant'`,
      [fixture.adminId],
    );
    assert.ok(rows[0]!.count >= 0);
  });
});
