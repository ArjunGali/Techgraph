import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../../db/pool.js';
import { handler, parse, periodMonthSchema, uuidSchema } from '../../lib/http.js';
import { notFound } from '../../lib/errors.js';
import { PERMISSIONS } from '../../lib/permissions.js';
import { assertBranchAccess, authenticate, currentUser, requirePermission } from '../../middleware/auth.js';
import { buildBillMessage, sendMessage, retryFailedMessages } from './messaging.service.js';

export const messagingRouter = Router();
messagingRouter.use(authenticate);

messagingRouter.get(
  '/templates',
  requirePermission(PERMISSIONS.MESSAGE_READ),
  handler(async (_req, res) => {
    const { rows } = await query('SELECT * FROM message_templates ORDER BY code');
    res.json({ templates: rows });
  }),
);

messagingRouter.put(
  '/templates/:code',
  requirePermission(PERMISSIONS.SETTINGS_WRITE),
  handler(async (req, res) => {
    const code = z.string().min(1).max(60).parse(req.params.code);
    const input = parse(
      z.object({
        name: z.string().min(1).max(120),
        body: z.string().min(1).max(4000),
        channel: z.enum(['whatsapp', 'sms', 'email']).default('whatsapp'),
        isActive: z.boolean().default(true),
      }),
      req.body,
      'template',
    );

    const { rows } = await query<{ id: string }>(
      `INSERT INTO message_templates (code, name, channel, body, is_active)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (lower(code)) DO UPDATE SET
         name = EXCLUDED.name, channel = EXCLUDED.channel, body = EXCLUDED.body,
         is_active = EXCLUDED.is_active, updated_at = now()
       RETURNING id`,
      [code, input.name, input.channel, input.body, input.isActive],
    );
    res.json({ id: rows[0]!.id });
  }),
);

messagingRouter.get(
  '/messages',
  requirePermission(PERMISSIONS.MESSAGE_READ),
  handler(async (req, res) => {
    const user = currentUser(req);
    const filters = parse(
      z.object({
        branchId: uuidSchema.optional(),
        tenantId: uuidSchema.optional(),
        status: z.enum(['queued', 'sent', 'delivered', 'read', 'failed', 'cancelled']).optional(),
      }),
      req.query,
      'message filters',
    );

    const { rows } = await query(
      `SELECT m.*, t.full_name AS tenant_name, b.name AS branch_name
         FROM whatsapp_messages m
         LEFT JOIN tenants t ON t.id = m.tenant_id
         LEFT JOIN branches b ON b.id = m.branch_id
        WHERE ($1::uuid IS NULL OR m.branch_id = $1)
          AND ($2::uuid IS NULL OR m.tenant_id = $2)
          AND ($3::text IS NULL OR m.status::text = $3)
          AND ($4::uuid[] IS NULL OR m.branch_id = ANY($4) OR m.branch_id IS NULL)
        ORDER BY m.created_at DESC LIMIT 200`,
      [filters.branchId ?? null, filters.tenantId ?? null, filters.status ?? null, user.branchIds],
    );
    res.json({ messages: rows });
  }),
);

/** Sends one bill's payment request, with the branch's payment QR identifier. */
messagingRouter.post(
  '/bills/:billId/send',
  requirePermission(PERMISSIONS.MESSAGE_SEND),
  handler(async (req, res) => {
    const actor = currentUser(req);
    const billId = parse(uuidSchema, req.params.billId, 'bill id');

    const { rows } = await query<{
      id: string; tenant_id: string; branch_id: string; period_month: string;
      tenant_name: string; phone: string; rent_paise: number; eb_paise: number;
      common_charge_paise: number; other_charges_paise: number; previous_dues_paise: number;
      total_paise: number; outstanding_paise: number;
    }>(
      `SELECT bl.id, bl.tenant_id, bp.branch_id, bp.period_month, t.full_name AS tenant_name,
              t.phone, bl.rent_paise, bl.eb_paise, bl.common_charge_paise, bl.other_charges_paise,
              bl.previous_dues_paise, bl.total_paise, bl.outstanding_paise
         FROM bills bl
         JOIN billing_periods bp ON bp.id = bl.billing_period_id
         JOIN tenants t ON t.id = bl.tenant_id
        WHERE bl.id = $1`,
      [billId],
    );
    const bill = rows[0];
    if (!bill) throw notFound('Bill');
    assertBranchAccess(actor, bill.branch_id);

    const { rows: qrRows } = await query<{ payment_identifier: string }>(
      `SELECT payment_identifier FROM payment_qr_configs
        WHERE is_active AND (branch_id = $1 OR branch_id IS NULL)
        ORDER BY (branch_id IS NOT NULL) DESC LIMIT 1`,
      [bill.branch_id],
    );

    const body = buildBillMessage({
      tenantName: bill.tenant_name,
      periodMonth: bill.period_month,
      rentPaise: bill.rent_paise,
      ebPaise: bill.eb_paise,
      commonChargePaise: bill.common_charge_paise,
      otherChargesPaise: bill.other_charges_paise,
      previousDuesPaise: bill.previous_dues_paise,
      totalPaise: bill.total_paise,
      outstandingPaise: bill.outstanding_paise,
      paymentIdentifier: qrRows[0]?.payment_identifier ?? null,
    });

    const result = await withTransaction((tx) =>
      sendMessage(
        tx,
        {
          tenantId: bill.tenant_id, billId: bill.id, branchId: bill.branch_id,
          phone: bill.phone, body, templateCode: 'monthly_bill',
        },
        { userId: actor.id },
      ),
    );

    res.json(result);
  }),
);

/** Sends every bill for a branch's month in one run. */
messagingRouter.post(
  '/periods/send',
  requirePermission(PERMISSIONS.MESSAGE_SEND),
  handler(async (req, res) => {
    const actor = currentUser(req);
    const input = parse(
      z.object({ branchId: uuidSchema, periodMonth: periodMonthSchema }),
      req.body,
      'bulk send',
    );
    assertBranchAccess(actor, input.branchId);

    const { rows: bills } = await query<{
      id: string; tenant_id: string; tenant_name: string; phone: string;
      rent_paise: number; eb_paise: number; common_charge_paise: number;
      other_charges_paise: number; previous_dues_paise: number; total_paise: number;
      outstanding_paise: number;
    }>(
      `SELECT bl.id, bl.tenant_id, t.full_name AS tenant_name, t.phone,
              bl.rent_paise, bl.eb_paise, bl.common_charge_paise, bl.other_charges_paise,
              bl.previous_dues_paise, bl.total_paise, bl.outstanding_paise
         FROM bills bl
         JOIN billing_periods bp ON bp.id = bl.billing_period_id
         JOIN tenants t ON t.id = bl.tenant_id
        WHERE bp.branch_id = $1 AND bp.period_month = $2 AND bl.status <> 'void'
        ORDER BY t.full_name`,
      [input.branchId, input.periodMonth],
    );

    const { rows: qrRows } = await query<{ payment_identifier: string }>(
      `SELECT payment_identifier FROM payment_qr_configs
        WHERE is_active AND (branch_id = $1 OR branch_id IS NULL)
        ORDER BY (branch_id IS NOT NULL) DESC LIMIT 1`,
      [input.branchId],
    );

    const results = [];
    for (const bill of bills) {
      const body = buildBillMessage({
        tenantName: bill.tenant_name,
        periodMonth: input.periodMonth,
        rentPaise: bill.rent_paise,
        ebPaise: bill.eb_paise,
        commonChargePaise: bill.common_charge_paise,
        otherChargesPaise: bill.other_charges_paise,
        previousDuesPaise: bill.previous_dues_paise,
        totalPaise: bill.total_paise,
        outstandingPaise: bill.outstanding_paise,
        paymentIdentifier: qrRows[0]?.payment_identifier ?? null,
      });

      const result = await withTransaction((tx) =>
        sendMessage(
          tx,
          {
            tenantId: bill.tenant_id, billId: bill.id, branchId: input.branchId,
            phone: bill.phone, body, templateCode: 'monthly_bill',
          },
          { userId: actor.id },
        ),
      );
      results.push({ billId: bill.id, tenantName: bill.tenant_name, ...result });
    }

    res.json({
      sent: results.filter((result) => result.status === 'sent').length,
      failed: results.filter((result) => result.status === 'failed').length,
      results,
    });
  }),
);

messagingRouter.post(
  '/retry-failed',
  requirePermission(PERMISSIONS.MESSAGE_SEND),
  handler(async (_req, res) => {
    const sent = await withTransaction((tx) => retryFailedMessages(tx));
    res.json({ sent });
  }),
);
