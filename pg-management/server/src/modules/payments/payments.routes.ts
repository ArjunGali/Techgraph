import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { query, withTransaction } from '../../db/pool.js';
import { handler, paiseSchema, parse, uuidSchema } from '../../lib/http.js';
import { badRequest, notFound, unprocessable } from '../../lib/errors.js';
import { AUDIT, writeAudit } from '../../lib/audit.js';
import { PERMISSIONS } from '../../lib/permissions.js';
import { assertBranchAccess, authenticate, currentUser, requirePermission } from '../../middleware/auth.js';
import { readFileStream, storeFile } from '../../lib/storage.js';
import { refreshBillTotals } from '../billing/billing.service.js';
import { extractPaymentDetails } from './ocr.service.js';

/**
 * The payment ledger and the approval workflow.
 *
 * A submitted payment — even one with a convincing screenshot attached — is
 * never money in the bank. It sits as `pending_approval` and affects no
 * balance until an admin approves it. Corrections are made by reversing a
 * payment, never by deleting one, so the ledger always explains the balance it
 * shows.
 */
export const paymentsRouter = Router();
paymentsRouter.use(authenticate);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_BYTES },
});

paymentsRouter.get(
  '/',
  requirePermission(PERMISSIONS.PAYMENT_READ),
  handler(async (req, res) => {
    const user = currentUser(req);
    const filters = parse(
      z.object({
        branchId: uuidSchema.optional(),
        tenantId: uuidSchema.optional(),
        billId: uuidSchema.optional(),
        state: z.enum(['pending_approval', 'approved', 'rejected', 'reversed']).optional(),
      }),
      req.query,
      'payment filters',
    );
    if (filters.branchId) assertBranchAccess(user, filters.branchId);

    const { rows } = await query(
      `SELECT p.*, t.full_name AS tenant_name, t.tenant_code, t.phone AS tenant_phone,
              b.name AS branch_name, u.full_name AS submitted_by_name,
              (SELECT count(*)::int FROM payment_proofs pp WHERE pp.payment_id = p.id) AS proof_count
         FROM payments p
         JOIN tenants t ON t.id = p.tenant_id
         JOIN branches b ON b.id = p.branch_id
         LEFT JOIN users u ON u.id = p.submitted_by
        WHERE ($1::uuid IS NULL OR p.branch_id = $1)
          AND ($2::uuid IS NULL OR p.tenant_id = $2)
          AND ($3::uuid IS NULL OR p.bill_id = $3)
          AND ($4::text IS NULL OR p.state::text = $4)
          AND ($5::uuid[] IS NULL OR p.branch_id = ANY($5))
        ORDER BY p.created_at DESC
        LIMIT 200`,
      [
        filters.branchId ?? null, filters.tenantId ?? null, filters.billId ?? null,
        filters.state ?? null, user.branchIds,
      ],
    );
    res.json({ payments: rows });
  }),
);

/** Everything waiting on an admin decision — the owner's approval queue. */
paymentsRouter.get(
  '/pending',
  requirePermission(PERMISSIONS.PAYMENT_APPROVE),
  handler(async (req, res) => {
    const user = currentUser(req);
    const { rows } = await query(
      `SELECT p.*, t.full_name AS tenant_name, t.tenant_code, t.phone AS tenant_phone,
              b.name AS branch_name, bl.total_paise AS bill_total_paise,
              bl.outstanding_paise AS bill_outstanding_paise, bp.period_month,
              coalesce(
                (SELECT json_agg(json_build_object(
                   'id', pp.id, 'originalName', pp.original_name, 'mimeType', pp.mime_type,
                   'ocrStatus', pp.ocr_status, 'ocrAmountPaise', pp.ocr_amount_paise,
                   'ocrReference', pp.ocr_reference, 'ocrPaidAt', pp.ocr_paid_at,
                   'ocrProvider', pp.ocr_provider))
                   FROM payment_proofs pp WHERE pp.payment_id = p.id),
                '[]'::json
              ) AS proofs
         FROM payments p
         JOIN tenants t ON t.id = p.tenant_id
         JOIN branches b ON b.id = p.branch_id
         LEFT JOIN bills bl ON bl.id = p.bill_id
         LEFT JOIN billing_periods bp ON bp.id = bl.billing_period_id
        WHERE p.state = 'pending_approval'
          AND ($1::uuid[] IS NULL OR p.branch_id = ANY($1))
        ORDER BY p.created_at`,
      [user.branchIds],
    );
    res.json({ payments: rows });
  }),
);

const submitSchema = z.object({
  tenantId: uuidSchema,
  billId: uuidSchema.nullish(),
  amountPaise: paiseSchema.refine((value) => value > 0, 'Amount must be more than zero'),
  kind: z.enum(['payment', 'deposit', 'advance', 'refund', 'discount', 'adjustment']).default('payment'),
  method: z.enum(['upi', 'cash', 'bank_transfer', 'card', 'cheque', 'other']).default('upi'),
  reference: z.string().max(120).nullish(),
  paidAt: z.string().datetime().nullish(),
  notes: z.string().max(1000).nullish(),
  /** Repeat submissions with the same key resolve to the same payment. */
  idempotencyKey: z.string().max(120).nullish(),
});

/**
 * Records a payment submission. It enters the ledger as pending and changes no
 * balance until approved.
 */
paymentsRouter.post(
  '/',
  requirePermission(PERMISSIONS.PAYMENT_RECORD),
  handler(async (req, res) => {
    const actor = currentUser(req);
    const input = parse(submitSchema, req.body, 'payment');

    const result = await withTransaction(async (tx) => {
      if (input.idempotencyKey) {
        const { rows: existing } = await tx.query<{ id: string; state: string }>(
          'SELECT id, state FROM payments WHERE idempotency_key = $1',
          [input.idempotencyKey],
        );
        // A retried submit returns the original payment rather than banking a
        // second one.
        if (existing[0]) return { id: existing[0].id, duplicate: true };
      }

      // The branch comes from the tenant's current stay, so a payment is
      // always attributed to where they actually live.
      const { rows: stayRows } = await tx.query<{ branch_id: string }>(
        `SELECT branch_id FROM tenant_stays
          WHERE tenant_id = $1 AND status <> 'cancelled'
          ORDER BY (end_date IS NULL) DESC, start_date DESC LIMIT 1`,
        [input.tenantId],
      );
      const branchId = stayRows[0]?.branch_id;
      if (!branchId) throw unprocessable('This tenant has no stay on record, so no branch to bill.');
      assertBranchAccess(actor, branchId);

      if (input.billId) {
        const { rows: billRows } = await tx.query<{ status: string }>(
          'SELECT status FROM bills WHERE id = $1',
          [input.billId],
        );
        if (!billRows[0]) throw notFound('Bill');
        if (billRows[0].status === 'void') throw unprocessable('That bill has been voided.');
      }

      // Refunds move money the other way and so increase what is owed.
      const direction = input.kind === 'refund' ? -1 : 1;

      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO payments
           (tenant_id, bill_id, branch_id, kind, amount_paise, direction, method, reference,
            paid_at, state, idempotency_key, notes, submitted_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending_approval',$10,$11,$12)
         RETURNING id`,
        [
          input.tenantId, input.billId ?? null, branchId, input.kind, input.amountPaise,
          direction, input.method, input.reference ?? null, input.paidAt ?? null,
          input.idempotencyKey ?? null, input.notes ?? null, actor.id,
        ],
      );
      const paymentId = rows[0]!.id;

      if (input.billId) {
        await tx.query(
          `UPDATE bills SET payment_status = 'pending_approval', updated_at = now()
            WHERE id = $1 AND payment_status IN ('not_paid', 'proof_submitted')`,
          [input.billId],
        );
      }

      await writeAudit(tx, {
        userId: actor.id, action: AUDIT.PAYMENT_SUBMITTED, entityType: 'payment',
        entityId: paymentId, branchId, after: input,
        ipAddress: req.ip, userAgent: req.header('user-agent'),
      });

      return { id: paymentId, duplicate: false };
    });

    res.status(result.duplicate ? 200 : 201).json(result);
  }),
);

/**
 * Attaches a payment screenshot.
 *
 * The extractor reads what it can from the image to pre-fill the review, but
 * the payment stays pending regardless of what it finds — a proof is evidence
 * for a human decision, not the decision itself.
 */
paymentsRouter.post(
  '/:id/proof',
  requirePermission(PERMISSIONS.PAYMENT_RECORD),
  upload.single('file'),
  handler(async (req, res) => {
    const actor = currentUser(req);
    const paymentId = parse(uuidSchema, req.params.id, 'payment id');
    if (!req.file) throw badRequest('Attach a file under the "file" field');

    const { rows } = await query<{ branch_id: string; state: string }>(
      'SELECT branch_id, state FROM payments WHERE id = $1',
      [paymentId],
    );
    const payment = rows[0];
    if (!payment) throw notFound('Payment');
    assertBranchAccess(actor, payment.branch_id);

    const stored = await storeFile(`payment-proofs/${paymentId}`, req.file);
    const extracted = await extractPaymentDetails(req.file);

    const id = await withTransaction(async (tx) => {
      const { rows: proofRows } = await tx.query<{ id: string }>(
        `INSERT INTO payment_proofs
           (payment_id, storage_key, original_name, mime_type, size_bytes, ocr_status,
            ocr_amount_paise, ocr_reference, ocr_paid_at, ocr_provider, ocr_raw, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [
          paymentId, stored.storageKey, stored.originalName, stored.mimeType, stored.sizeBytes,
          extracted.status, extracted.amountPaise ?? null, extracted.reference ?? null,
          extracted.paidAt ?? null, extracted.provider ?? null,
          extracted.raw ? JSON.stringify(extracted.raw) : null, actor.id,
        ],
      );

      await tx.query(
        `UPDATE bills SET payment_status = 'proof_submitted', updated_at = now()
          WHERE id = (SELECT bill_id FROM payments WHERE id = $1)
            AND payment_status = 'not_paid'`,
        [paymentId],
      );

      await writeAudit(tx, {
        userId: actor.id, action: AUDIT.PAYMENT_PROOF_UPLOADED, entityType: 'payment',
        entityId: paymentId, branchId: payment.branch_id,
        after: { proofId: proofRows[0]!.id, extraction: extracted },
        ipAddress: req.ip, userAgent: req.header('user-agent'),
      });

      return proofRows[0]!.id;
    });

    res.status(201).json({ id, extraction: extracted });
  }),
);

paymentsRouter.get(
  '/proofs/:proofId/file',
  requirePermission(PERMISSIONS.PAYMENT_READ),
  handler(async (req, res) => {
    const user = currentUser(req);
    const proofId = parse(uuidSchema, req.params.proofId, 'proof id');

    const { rows } = await query<{
      storage_key: string;
      mime_type: string;
      original_name: string;
      branch_id: string;
    }>(
      `SELECT pp.storage_key, pp.mime_type, pp.original_name, p.branch_id
         FROM payment_proofs pp JOIN payments p ON p.id = pp.payment_id
        WHERE pp.id = $1`,
      [proofId],
    );
    const proof = rows[0];
    if (!proof) throw notFound('Proof');
    assertBranchAccess(user, proof.branch_id);

    res.setHeader('Content-Type', proof.mime_type);
    res.setHeader('Content-Disposition', `inline; filename="${proof.original_name}"`);
    res.setHeader('Cache-Control', 'no-store');
    readFileStream(proof.storage_key).pipe(res);
  }),
);

const decisionSchema = z.object({
  action: z.enum(['approve', 'approve_partial', 'reject']),
  /** Required for a partial approval: the amount actually banked. */
  approvedAmountPaise: paiseSchema.optional(),
  reason: z.string().max(500).optional(),
});

/**
 * The admin decision. Only this endpoint moves a balance: approval writes the
 * approved amount into the ledger and refreshes the bill's totals from it.
 */
paymentsRouter.post(
  '/:id/decision',
  requirePermission(PERMISSIONS.PAYMENT_APPROVE),
  handler(async (req, res) => {
    const actor = currentUser(req);
    const paymentId = parse(uuidSchema, req.params.id, 'payment id');
    const input = parse(decisionSchema, req.body, 'decision');

    if (input.action === 'approve_partial' && input.approvedAmountPaise === undefined) {
      throw badRequest('A partial approval needs the amount you are approving');
    }
    if (input.action === 'reject' && !input.reason) {
      throw badRequest('Give a reason when rejecting a payment');
    }

    const result = await withTransaction(async (tx) => {
      // Locked for the duration so two admins cannot approve the same payment
      // twice in parallel.
      const { rows } = await tx.query<{
        id: string; state: string; amount_paise: number; bill_id: string | null; branch_id: string;
      }>(
        'SELECT id, state, amount_paise, bill_id, branch_id FROM payments WHERE id = $1 FOR UPDATE',
        [paymentId],
      );
      const payment = rows[0];
      if (!payment) throw notFound('Payment');
      assertBranchAccess(actor, payment.branch_id);
      if (payment.state !== 'pending_approval') {
        throw unprocessable(`This payment has already been ${payment.state.replace('_', ' ')}.`);
      }

      const approvedAmountPaise =
        input.action === 'reject'
          ? null
          : (input.approvedAmountPaise ?? payment.amount_paise);

      if (approvedAmountPaise !== null && approvedAmountPaise > payment.amount_paise) {
        throw unprocessable(
          'The approved amount cannot exceed the amount the tenant submitted. ' +
            'Record a separate payment for the difference.',
        );
      }

      await tx.query(
        `UPDATE payments
            SET state = $2, approved_amount_paise = $3, updated_at = now()
          WHERE id = $1`,
        [paymentId, input.action === 'reject' ? 'rejected' : 'approved', approvedAmountPaise],
      );

      await tx.query(
        `INSERT INTO payment_approvals (payment_id, action, approved_amount_paise, reason, reviewer_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [paymentId, input.action, approvedAmountPaise, input.reason ?? null, actor.id],
      );

      if (payment.bill_id) await refreshBillTotals(tx, payment.bill_id);

      await writeAudit(tx, {
        userId: actor.id,
        action: input.action === 'reject' ? AUDIT.PAYMENT_REJECTED : AUDIT.PAYMENT_APPROVED,
        entityType: 'payment',
        entityId: paymentId,
        branchId: payment.branch_id,
        before: { state: 'pending_approval', amountPaise: payment.amount_paise },
        after: { state: input.action === 'reject' ? 'rejected' : 'approved', approvedAmountPaise },
        meta: { reason: input.reason ?? null },
        ipAddress: req.ip, userAgent: req.header('user-agent'),
      });

      return { state: input.action === 'reject' ? 'rejected' : 'approved', approvedAmountPaise };
    });

    res.json(result);
  }),
);

/**
 * Reverses an approved payment.
 *
 * Nothing is deleted: the original stays on record and a matching entry in the
 * opposite direction cancels its effect, so the ledger still explains itself.
 */
paymentsRouter.post(
  '/:id/reverse',
  requirePermission(PERMISSIONS.PAYMENT_APPROVE),
  handler(async (req, res) => {
    const actor = currentUser(req);
    const paymentId = parse(uuidSchema, req.params.id, 'payment id');
    const input = parse(z.object({ reason: z.string().min(5).max(500) }), req.body, 'reversal');

    const reversalId = await withTransaction(async (tx) => {
      const { rows } = await tx.query<{
        id: string; state: string; tenant_id: string; bill_id: string | null;
        branch_id: string; amount_paise: number; approved_amount_paise: number | null;
        direction: number;
      }>(
        `SELECT id, state, tenant_id, bill_id, branch_id, amount_paise, approved_amount_paise, direction
           FROM payments WHERE id = $1 FOR UPDATE`,
        [paymentId],
      );
      const payment = rows[0];
      if (!payment) throw notFound('Payment');
      assertBranchAccess(actor, payment.branch_id);
      if (payment.state !== 'approved') throw unprocessable('Only an approved payment can be reversed.');

      const amount = payment.approved_amount_paise ?? payment.amount_paise;

      const { rows: created } = await tx.query<{ id: string }>(
        `INSERT INTO payments
           (tenant_id, bill_id, branch_id, kind, amount_paise, direction, method, reference,
            state, approved_amount_paise, reversal_of_id, notes, submitted_by)
         VALUES ($1,$2,$3,'reversal',$4,$5,'other',NULL,'approved',$4,$6,$7,$8)
         RETURNING id`,
        [
          payment.tenant_id, payment.bill_id, payment.branch_id, amount,
          -payment.direction, paymentId, input.reason, actor.id,
        ],
      );

      await tx.query(`UPDATE payments SET state = 'reversed', updated_at = now() WHERE id = $1`, [
        paymentId,
      ]);
      await tx.query(
        `INSERT INTO payment_approvals (payment_id, action, reason, reviewer_id)
         VALUES ($1,'reverse',$2,$3)`,
        [paymentId, input.reason, actor.id],
      );

      if (payment.bill_id) await refreshBillTotals(tx, payment.bill_id);

      await writeAudit(tx, {
        userId: actor.id, action: AUDIT.PAYMENT_REVERSED, entityType: 'payment',
        entityId: paymentId, branchId: payment.branch_id,
        before: { state: 'approved', amountPaise: amount },
        after: { state: 'reversed', reversalPaymentId: created[0]!.id },
        meta: { reason: input.reason },
        ipAddress: req.ip, userAgent: req.header('user-agent'),
      });

      return created[0]!.id;
    });

    res.json({ reversalPaymentId: reversalId });
  }),
);

// ---------------------------------------------------------------------------
// Payment QR configuration
// ---------------------------------------------------------------------------
paymentsRouter.get(
  '/qr',
  requirePermission(PERMISSIONS.PAYMENT_READ),
  handler(async (req, res) => {
    const branchId = req.query.branchId ? parse(uuidSchema, req.query.branchId, 'branch id') : null;
    const { rows } = await query(
      `SELECT q.*, b.name AS branch_name FROM payment_qr_configs q
         LEFT JOIN branches b ON b.id = q.branch_id
        WHERE q.is_active AND ($1::uuid IS NULL OR q.branch_id = $1 OR q.branch_id IS NULL)
        ORDER BY (q.branch_id IS NOT NULL) DESC`,
      [branchId],
    );
    res.json({ configs: rows });
  }),
);

paymentsRouter.post(
  '/qr',
  requirePermission(PERMISSIONS.SETTINGS_WRITE),
  upload.single('file'),
  handler(async (req, res) => {
    const actor = currentUser(req);
    const input = parse(
      z.object({
        branchId: uuidSchema.nullish(),
        displayName: z.string().min(1).max(120),
        paymentIdentifier: z.string().min(1).max(120),
        notes: z.string().max(500).nullish(),
      }),
      req.body,
      'QR configuration',
    );

    const stored = req.file ? await storeFile('payment-qr', req.file) : null;

    const id = await withTransaction(async (tx) => {
      // Only one QR is active per scope, so a payment request can never offer
      // two different destinations.
      await tx.query(
        `UPDATE payment_qr_configs SET is_active = FALSE, updated_at = now()
          WHERE coalesce(branch_id::text, 'default') = coalesce($1::text, 'default') AND is_active`,
        [input.branchId ?? null],
      );

      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO payment_qr_configs
           (branch_id, display_name, payment_identifier, storage_key, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [
          input.branchId ?? null, input.displayName, input.paymentIdentifier,
          stored?.storageKey ?? null, input.notes ?? null, actor.id,
        ],
      );
      return rows[0]!.id;
    });

    res.status(201).json({ id });
  }),
);

paymentsRouter.get(
  '/qr/:id/image',
  requirePermission(PERMISSIONS.PAYMENT_READ),
  handler(async (req, res) => {
    const qrId = parse(uuidSchema, req.params.id, 'QR id');
    const { rows } = await query<{ storage_key: string | null }>(
      'SELECT storage_key FROM payment_qr_configs WHERE id = $1',
      [qrId],
    );
    const key = rows[0]?.storage_key;
    if (!key) throw notFound('QR image');
    res.setHeader('Content-Type', 'image/png');
    readFileStream(key).pipe(res);
  }),
);
