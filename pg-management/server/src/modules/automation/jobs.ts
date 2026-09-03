import type { Db } from '../../db/pool.js';
import { withTransaction } from '../../db/pool.js';
import { generateBillsForPeriod } from '../billing/billing.service.js';
import { buildBillMessage, sendMessage, retryFailedMessages } from '../messaging/messaging.service.js';
import { formatPaise } from '../../calc/index.js';

/**
 * The automation catalogue.
 *
 * Each job is a plain async function that reports what it did. Every run —
 * scheduled or triggered by hand — is recorded in `automation_runs` with its
 * status, result and any error, so an automation that quietly stopped working
 * is visible rather than invisible.
 */

export type JobContext = {
  userId: string | null;
  /** Overrides "today", so a run can be replayed for a past month. */
  referenceDate?: string;
};

export type JobResult = {
  summary: string;
  details: Record<string, unknown>;
};

export type JobHandler = (db: Db, context: JobContext) => Promise<JobResult>;

function today(context: JobContext): string {
  return context.referenceDate ?? new Date().toISOString().slice(0, 10);
}

function periodMonthOf(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** Generates bills for every active branch for the current month. */
const generateMonthlyBills: JobHandler = async (db, context) => {
  const periodMonth = periodMonthOf(today(context));
  const { rows: branches } = await db.query<{ id: string; name: string }>(
    `SELECT id, name FROM branches WHERE status = 'active' ORDER BY name`,
  );

  const details: Record<string, unknown> = {};
  let billCount = 0;

  for (const branch of branches) {
    try {
      const result = await generateBillsForPeriod(db, {
        branchId: branch.id,
        periodMonth,
        userId: context.userId ?? branches[0]!.id,
      });
      billCount += result.bills.length;
      details[branch.name] = {
        bills: result.bills.length,
        missingReadings: result.missingReadings.map((meter) => meter.meterCode),
      };
    } catch (error) {
      details[branch.name] = { error: (error as Error).message };
    }
  }

  return { summary: `Generated ${billCount} bill(s) for ${periodMonth.slice(0, 7)}`, details };
};

/** Sends the month's payment requests to every tenant with an unpaid bill. */
const sendMonthlyBills: JobHandler = async (db, context) => {
  const periodMonth = periodMonthOf(today(context));
  const { rows: bills } = await db.query<{
    id: string; tenant_id: string; branch_id: string; tenant_name: string; phone: string;
    rent_paise: number; eb_paise: number; common_charge_paise: number;
    other_charges_paise: number; previous_dues_paise: number; total_paise: number;
    outstanding_paise: number; payment_identifier: string | null;
  }>(
    `SELECT bl.id, bl.tenant_id, bp.branch_id, t.full_name AS tenant_name, t.phone,
            bl.rent_paise, bl.eb_paise, bl.common_charge_paise, bl.other_charges_paise,
            bl.previous_dues_paise, bl.total_paise, bl.outstanding_paise,
            qr.payment_identifier
       FROM bills bl
       JOIN billing_periods bp ON bp.id = bl.billing_period_id
       JOIN tenants t ON t.id = bl.tenant_id
       LEFT JOIN LATERAL (
         SELECT payment_identifier FROM payment_qr_configs q
          WHERE q.is_active AND (q.branch_id = bp.branch_id OR q.branch_id IS NULL)
          ORDER BY (q.branch_id IS NOT NULL) DESC LIMIT 1
       ) qr ON TRUE
      WHERE bp.period_month = $1 AND bl.status <> 'void' AND bl.outstanding_paise > 0
      ORDER BY t.full_name`,
    [periodMonth],
  );

  let sent = 0;
  let failed = 0;
  for (const bill of bills) {
    const body = buildBillMessage({
      tenantName: bill.tenant_name,
      periodMonth,
      rentPaise: bill.rent_paise,
      ebPaise: bill.eb_paise,
      commonChargePaise: bill.common_charge_paise,
      otherChargesPaise: bill.other_charges_paise,
      previousDuesPaise: bill.previous_dues_paise,
      totalPaise: bill.total_paise,
      outstandingPaise: bill.outstanding_paise,
      paymentIdentifier: bill.payment_identifier,
    });
    const result = await sendMessage(
      db,
      {
        tenantId: bill.tenant_id, billId: bill.id, branchId: bill.branch_id,
        phone: bill.phone, body, templateCode: 'monthly_bill',
      },
      { userId: context.userId },
    );
    if (result.status === 'sent') sent += 1;
    else failed += 1;
  }

  return { summary: `Sent ${sent} bill message(s), ${failed} failed`, details: { sent, failed } };
};

/**
 * Sends the reminder due today, to tenants whose bill is still unpaid.
 *
 * A tenant whose payment has been approved in full drops out of the query, so
 * reminders stop on their own without anyone disabling them. A partial payment
 * is reminded for the remaining balance only.
 */
const sendPaymentReminders: JobHandler = async (db, context) => {
  const reference = today(context);
  const dayOfMonth = Number(reference.slice(8, 10));
  const periodMonth = periodMonthOf(reference);

  const { rows: rules } = await db.query<{
    branch_id: string | null; template_code: string; label: string; body: string | null;
  }>(
    `SELECT rr.branch_id, rr.template_code, rr.label, mt.body
       FROM reminder_rules rr
       LEFT JOIN message_templates mt ON lower(mt.code) = lower(rr.template_code) AND mt.is_active
      WHERE rr.is_active AND rr.day_of_month = $1`,
    [dayOfMonth],
  );

  if (rules.length === 0) {
    return { summary: `No reminder configured for day ${dayOfMonth}`, details: { dayOfMonth } };
  }

  let sent = 0;
  for (const rule of rules) {
    const { rows: bills } = await db.query<{
      id: string; tenant_id: string; branch_id: string; tenant_name: string;
      phone: string; outstanding_paise: number;
    }>(
      `SELECT bl.id, bl.tenant_id, bp.branch_id, t.full_name AS tenant_name, t.phone,
              bl.outstanding_paise
         FROM bills bl
         JOIN billing_periods bp ON bp.id = bl.billing_period_id
         JOIN tenants t ON t.id = bl.tenant_id
        WHERE bp.period_month = $1
          AND bl.outstanding_paise > 0
          AND bl.status <> 'void'
          AND ($2::uuid IS NULL OR bp.branch_id = $2)`,
      [periodMonth, rule.branch_id],
    );

    for (const bill of bills) {
      const body = rule.body
        ? rule.body
            .replace(/\{\{\s*tenantName\s*\}\}/g, bill.tenant_name)
            .replace(/\{\{\s*outstanding\s*\}\}/g, formatPaise(bill.outstanding_paise))
            .replace(/\{\{\s*periodMonth\s*\}\}/g, periodMonth.slice(0, 7))
        : `Hello ${bill.tenant_name}, a balance of ${formatPaise(bill.outstanding_paise)} ` +
          `is pending for ${periodMonth.slice(0, 7)}. Please complete the payment when you can.`;

      const result = await sendMessage(
        db,
        {
          tenantId: bill.tenant_id, billId: bill.id, branchId: bill.branch_id,
          phone: bill.phone, body, templateCode: rule.template_code,
        },
        { userId: context.userId },
      );
      if (result.status === 'sent') sent += 1;
    }
  }

  return { summary: `Sent ${sent} reminder(s) for day ${dayOfMonth}`, details: { dayOfMonth, sent } };
};

/** Nudges staff about meters with no reading yet for the current month. */
const remindMeterReadings: JobHandler = async (db, context) => {
  const periodMonth = periodMonthOf(today(context));
  const { rows } = await db.query<{ meter_code: string; branch_name: string }>(
    `SELECT DISTINCT m.code AS meter_code, b.name AS branch_name
       FROM eb_meters m
       JOIN branches b ON b.id = m.branch_id
       JOIN rooms r ON r.meter_id = m.id AND r.status = 'active'
      WHERE m.status = 'active' AND b.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM eb_readings er WHERE er.meter_id = m.id AND er.period_month = $1
        )`,
    [periodMonth],
  );
  return {
    summary: `${rows.length} meter(s) still need a reading for ${periodMonth.slice(0, 7)}`,
    details: { meters: rows },
  };
};

/** Reports beds coming free in the next 30 days. */
const upcomingVacancyAlert: JobHandler = async (db, context) => {
  const reference = today(context);
  const { rows } = await db.query<{
    tenant_name: string; room_code: string; branch_name: string; available_from: string;
  }>(
    `SELECT t.full_name AS tenant_name, r.code AS room_code, b.name AS branch_name,
            (s.end_date + 1) AS available_from
       FROM tenant_stays s
       JOIN tenants t ON t.id = s.tenant_id
       JOIN rooms r ON r.id = s.room_id
       JOIN branches b ON b.id = s.branch_id
      WHERE s.status <> 'cancelled' AND s.end_date IS NOT NULL
        AND s.end_date >= $1::date AND s.end_date <= ($1::date + 30)
      ORDER BY s.end_date`,
    [reference],
  );
  return { summary: `${rows.length} bed(s) coming free within 30 days`, details: { upcoming: rows } };
};

/** Re-attempts messages the provider rejected. */
const retryMessages: JobHandler = async (db) => {
  const sent = await retryFailedMessages(db);
  return { summary: `Re-sent ${sent} previously failed message(s)`, details: { sent } };
};

/** A once-a-day snapshot for the owner. */
const dailySummary: JobHandler = async (db, context) => {
  const periodMonth = periodMonthOf(today(context));
  const { rows } = await db.query<{
    pending_approvals: number; overdue_bills: number; vacant_beds: number; open_issues: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM payments WHERE state = 'pending_approval') AS pending_approvals,
       (SELECT count(*)::int FROM bills bl
          WHERE bl.outstanding_paise > 0 AND bl.due_date < CURRENT_DATE AND bl.status <> 'void')
         AS overdue_bills,
       (SELECT coalesce(sum(greatest(r.sharing_capacity - occ.occupied, 0)), 0)::int
          FROM rooms r
          CROSS JOIN LATERAL (
            SELECT count(*)::int AS occupied FROM tenant_stays s
             WHERE s.room_id = r.id AND s.status <> 'cancelled'
               AND s.start_date <= CURRENT_DATE AND (s.end_date IS NULL OR s.end_date >= CURRENT_DATE)
          ) occ
         WHERE r.status = 'active') AS vacant_beds,
       (SELECT count(*)::int FROM maintenance_issues WHERE status IN ('open', 'in_progress'))
         AS open_issues`,
  );
  const summary = rows[0]!;
  return {
    summary:
      `${summary.pending_approvals} approval(s) pending, ${summary.overdue_bills} overdue bill(s), ` +
      `${summary.vacant_beds} vacant bed(s), ${summary.open_issues} open issue(s)`,
    details: { periodMonth, ...summary },
  };
};

export const JOB_HANDLERS: Record<string, JobHandler> = {
  generate_monthly_bills: generateMonthlyBills,
  send_monthly_bills: sendMonthlyBills,
  send_payment_reminders: sendPaymentReminders,
  remind_meter_readings: remindMeterReadings,
  upcoming_vacancy_alert: upcomingVacancyAlert,
  retry_failed_messages: retryMessages,
  daily_summary: dailySummary,
};

/**
 * Runs one job, recording the attempt whether it succeeds or fails.
 *
 * The run row is written in its own transaction before the work starts, so a
 * job that crashes still leaves evidence that it was attempted.
 */
export async function runJob(
  code: string,
  context: JobContext,
): Promise<{ runId: string; status: string; result?: JobResult; error?: string }> {
  const handler = JOB_HANDLERS[code];
  if (!handler) throw new Error(`Unknown automation job: ${code}`);

  const runId = await withTransaction(async (tx) => {
    const { rows: jobRows } = await tx.query<{ id: string }>(
      `INSERT INTO automation_jobs (code, name, is_enabled)
       VALUES ($1, $1, TRUE)
       ON CONFLICT (lower(code)) DO UPDATE SET last_run_at = now(), updated_at = now()
       RETURNING id`,
      [code],
    );
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO automation_runs (job_id, status, triggered_by) VALUES ($1, 'running', $2)
       RETURNING id`,
      [jobRows[0]!.id, context.userId],
    );
    return rows[0]!.id;
  });

  try {
    const result = await withTransaction((tx) => handler(tx, context));
    await withTransaction((tx) =>
      tx.query(
        `UPDATE automation_runs SET status = 'success', finished_at = now(), result = $2 WHERE id = $1`,
        [runId, JSON.stringify(result)],
      ),
    );
    return { runId, status: 'success', result };
  } catch (error) {
    const message = (error as Error).message;
    await withTransaction((tx) =>
      tx.query(
        `UPDATE automation_runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`,
        [runId, message],
      ),
    );
    return { runId, status: 'failed', error: message };
  }
}
