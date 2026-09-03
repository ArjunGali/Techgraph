import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { query, withTransaction } from '../../db/pool.js';
import { handler, isoDateSchema, paginationSchema, parse, uuidSchema } from '../../lib/http.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { AUDIT, writeAudit } from '../../lib/audit.js';
import { PERMISSIONS } from '../../lib/permissions.js';
import {
  assertBranchAccess,
  authenticate,
  currentUser,
  requirePermission,
} from '../../middleware/auth.js';
import { maskIdentifier, readFileStream, storeFile } from '../../lib/storage.js';
import { admitTenant, moveTenant, vacateTenant } from './stays.service.js';

export const tenantsRouter = Router();
tenantsRouter.use(authenticate);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_BYTES },
});

// ---------------------------------------------------------------------------
// Search and listing
// ---------------------------------------------------------------------------
/**
 * Global tenant search by name, phone or tenant code, with the current
 * location resolved from the open stay.
 *
 * Deliberately returns no document details: identity documents are reachable
 * only through their own permission-checked, audited endpoint.
 */
tenantsRouter.get(
  '/',
  requirePermission(PERMISSIONS.TENANT_READ),
  handler(async (req, res) => {
    const user = currentUser(req);
    const filters = parse(
      paginationSchema.extend({
        q: z.string().trim().max(120).optional(),
        branchId: uuidSchema.optional(),
        floorId: uuidSchema.optional(),
        roomId: uuidSchema.optional(),
        status: z.enum(['prospect', 'active', 'notice', 'vacated', 'blacklisted']).optional(),
      }),
      req.query,
      'tenant filters',
    );
    if (filters.branchId) assertBranchAccess(user, filters.branchId);

    const canSeeMoney = user.permissions.has(PERMISSIONS.PAYMENT_READ);

    const { rows } = await query(
      `SELECT t.id, t.tenant_code, t.full_name, t.phone, t.status, t.joining_date, t.exit_date,
              s.id AS stay_id, s.start_date AS stay_start, s.sharing_capacity, s.monthly_rent_paise,
              r.id AS room_id, r.code AS room_code, f.id AS floor_id, f.name AS floor_name,
              b.id AS branch_id, b.name AS branch_name,
              CASE WHEN $7::boolean THEN coalesce(ledger.outstanding_paise, 0) ELSE NULL END
                AS outstanding_paise
         FROM tenants t
         LEFT JOIN tenant_stays s
           ON s.tenant_id = t.id AND s.status = 'active' AND s.end_date IS NULL
         LEFT JOIN rooms r ON r.id = s.room_id
         LEFT JOIN floors f ON f.id = s.floor_id
         LEFT JOIN branches b ON b.id = s.branch_id
         LEFT JOIN LATERAL (
           SELECT coalesce(sum(bl.outstanding_paise), 0)::bigint AS outstanding_paise
             FROM bills bl WHERE bl.tenant_id = t.id AND bl.status <> 'void'
         ) ledger ON TRUE
        WHERE ($1::text IS NULL
               OR t.full_name ILIKE '%' || $1 || '%'
               OR t.phone ILIKE '%' || $1 || '%'
               OR t.tenant_code ILIKE '%' || $1 || '%')
          AND ($2::uuid IS NULL OR s.branch_id = $2)
          AND ($3::uuid IS NULL OR s.floor_id = $3)
          AND ($4::uuid IS NULL OR s.room_id = $4)
          AND ($5::text IS NULL OR t.status::text = $5)
          AND ($6::uuid[] IS NULL OR s.branch_id = ANY($6) OR s.branch_id IS NULL)
        ORDER BY t.full_name
        LIMIT $8 OFFSET $9`,
      [
        filters.q ?? null, filters.branchId ?? null, filters.floorId ?? null,
        filters.roomId ?? null, filters.status ?? null, user.branchIds, canSeeMoney,
        filters.limit, filters.offset,
      ],
    );

    res.json({ tenants: rows, limit: filters.limit, offset: filters.offset });
  }),
);

/** One tenant with their full stay history, bills and payment history. */
tenantsRouter.get(
  '/:id',
  requirePermission(PERMISSIONS.TENANT_READ),
  handler(async (req, res) => {
    const user = currentUser(req);
    const tenantId = parse(uuidSchema, req.params.id, 'tenant id');

    const { rows } = await query('SELECT * FROM tenants WHERE id = $1', [tenantId]);
    const tenant = rows[0];
    if (!tenant) throw notFound('Tenant');

    const { rows: stays } = await query(
      `SELECT s.*, r.code AS room_code, r.name AS room_name, f.name AS floor_name,
              b.name AS branch_name, bd.label AS bed_label
         FROM tenant_stays s
         JOIN rooms r ON r.id = s.room_id
         JOIN floors f ON f.id = s.floor_id
         JOIN branches b ON b.id = s.branch_id
         LEFT JOIN beds bd ON bd.id = s.bed_id
        WHERE s.tenant_id = $1
        ORDER BY s.start_date DESC`,
      [tenantId],
    );

    const currentStay = stays.find((stay) => stay.end_date === null && stay.status === 'active');
    if (currentStay) assertBranchAccess(user, currentStay.branch_id as string);

    const canSeeMoney = user.permissions.has(PERMISSIONS.PAYMENT_READ);
    const bills = canSeeMoney
      ? (
          await query(
            `SELECT bl.*, bp.period_month
               FROM bills bl JOIN billing_periods bp ON bp.id = bl.billing_period_id
              WHERE bl.tenant_id = $1 ORDER BY bp.period_month DESC`,
            [tenantId],
          )
        ).rows
      : [];
    const payments = canSeeMoney
      ? (
          await query(
            `SELECT id, kind, amount_paise, approved_amount_paise, direction, method, reference,
                    paid_at, state, notes, created_at
               FROM payments WHERE tenant_id = $1 ORDER BY created_at DESC`,
            [tenantId],
          )
        ).rows
      : [];

    // Only the masked identifier and metadata; never the file itself.
    const { rows: documents } = await query(
      `SELECT id, doc_type, original_name, mime_type, size_bytes, masked_identifier,
              is_verified, created_at
         FROM tenant_documents WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    );

    res.json({ tenant, stays, currentStay: currentStay ?? null, bills, payments, documents });
  }),
);

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------
const tenantSchema = z.object({
  fullName: z.string().min(1).max(120),
  phone: z.string().min(6).max(20),
  altPhone: z.string().max(20).nullish(),
  email: z.string().email().nullish(),
  gender: z.enum(['male', 'female', 'other']).nullish(),
  dateOfBirth: isoDateSchema.nullish(),
  occupation: z.string().max(120).nullish(),
  company: z.string().max(120).nullish(),
  permanentAddress: z.string().max(500).nullish(),
  emergencyContactName: z.string().max(120).nullish(),
  emergencyContactPhone: z.string().max(20).nullish(),
  joiningDate: isoDateSchema,
  depositPaise: z.number().int().nonnegative().default(0),
  notes: z.string().max(2000).nullish(),
  tenantCode: z.string().max(32).optional(),
  /** Room to admit into. Omit to create the tenant without placing them. */
  roomId: uuidSchema.optional(),
  bedId: uuidSchema.nullish(),
  monthlyRentPaise: z.number().int().nonnegative().optional(),
});

tenantsRouter.post(
  '/',
  requirePermission(PERMISSIONS.TENANT_WRITE),
  handler(async (req, res) => {
    const actor = currentUser(req);
    const input = parse(tenantSchema, req.body, 'tenant');

    const result = await withTransaction(async (tx) => {
      // A readable, collision-free code: PG-000001, PG-000002, ...
      const tenantCode =
        input.tenantCode ??
        (
          await tx.query<{ code: string }>(
            `SELECT 'PG-' || lpad((coalesce(max(substring(tenant_code from '[0-9]+$')::int), 0) + 1)::text, 6, '0') AS code
               FROM tenants WHERE tenant_code ~ '^PG-[0-9]+$'`,
          )
        ).rows[0]!.code;

      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO tenants
           (tenant_code, full_name, phone, alt_phone, email, gender, date_of_birth, occupation,
            company, permanent_address, emergency_contact_name, emergency_contact_phone,
            joining_date, deposit_paise, notes, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'active',$16)
         RETURNING id`,
        [
          tenantCode, input.fullName, input.phone, input.altPhone ?? null, input.email ?? null,
          input.gender ?? null, input.dateOfBirth ?? null, input.occupation ?? null,
          input.company ?? null, input.permanentAddress ?? null,
          input.emergencyContactName ?? null, input.emergencyContactPhone ?? null,
          input.joiningDate, input.depositPaise, input.notes ?? null, actor.id,
        ],
      );
      const tenantId = rows[0]!.id;

      let stayId: string | null = null;
      if (input.roomId) {
        const { rows: roomRows } = await tx.query<{ branch_id: string }>(
          'SELECT branch_id FROM rooms WHERE id = $1',
          [input.roomId],
        );
        if (!roomRows[0]) throw notFound('Room');
        assertBranchAccess(actor, roomRows[0].branch_id);

        const admitted = await admitTenant(
          tx,
          {
            tenantId,
            roomId: input.roomId,
            startDate: input.joiningDate,
            bedId: input.bedId ?? null,
            monthlyRentPaise: input.monthlyRentPaise,
          },
          { userId: actor.id, ipAddress: req.ip, userAgent: req.header('user-agent') },
        );
        stayId = admitted.stayId;
      }

      await writeAudit(tx, {
        userId: actor.id,
        action: AUDIT.TENANT_CREATED,
        entityType: 'tenant',
        entityId: tenantId,
        after: { ...input, tenantCode, stayId },
        ipAddress: req.ip,
        userAgent: req.header('user-agent'),
      });

      return { tenantId, tenantCode, stayId };
    });

    res.status(201).json(result);
  }),
);

tenantsRouter.patch(
  '/:id',
  requirePermission(PERMISSIONS.TENANT_WRITE),
  handler(async (req, res) => {
    const actor = currentUser(req);
    const tenantId = parse(uuidSchema, req.params.id, 'tenant id');
    const input = parse(
      tenantSchema
        .partial()
        .omit({ roomId: true, bedId: true, monthlyRentPaise: true, tenantCode: true })
        .extend({ status: z.enum(['prospect', 'active', 'notice', 'vacated', 'blacklisted']).optional() }),
      req.body,
      'tenant',
    );

    await withTransaction(async (tx) => {
      const { rows } = await tx.query('SELECT * FROM tenants WHERE id = $1', [tenantId]);
      const before = rows[0];
      if (!before) throw notFound('Tenant');

      await tx.query(
        `UPDATE tenants SET
           full_name = coalesce($2, full_name), phone = coalesce($3, phone),
           alt_phone = coalesce($4, alt_phone), email = coalesce($5, email),
           gender = coalesce($6, gender), date_of_birth = coalesce($7, date_of_birth),
           occupation = coalesce($8, occupation), company = coalesce($9, company),
           permanent_address = coalesce($10, permanent_address),
           emergency_contact_name = coalesce($11, emergency_contact_name),
           emergency_contact_phone = coalesce($12, emergency_contact_phone),
           joining_date = coalesce($13, joining_date), deposit_paise = coalesce($14, deposit_paise),
           notes = coalesce($15, notes), status = coalesce($16, status), updated_at = now()
         WHERE id = $1`,
        [
          tenantId, input.fullName ?? null, input.phone ?? null, input.altPhone ?? null,
          input.email ?? null, input.gender ?? null, input.dateOfBirth ?? null,
          input.occupation ?? null, input.company ?? null, input.permanentAddress ?? null,
          input.emergencyContactName ?? null, input.emergencyContactPhone ?? null,
          input.joiningDate ?? null, input.depositPaise ?? null, input.notes ?? null,
          input.status ?? null,
        ],
      );

      await writeAudit(tx, {
        userId: actor.id, action: AUDIT.TENANT_UPDATED, entityType: 'tenant',
        entityId: tenantId, before, after: input,
        ipAddress: req.ip, userAgent: req.header('user-agent'),
      });
    });

    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// Movement and vacating
// ---------------------------------------------------------------------------
tenantsRouter.post(
  '/:id/admit',
  requirePermission(PERMISSIONS.TENANT_MOVE),
  handler(async (req, res) => {
    const actor = currentUser(req);
    const tenantId = parse(uuidSchema, req.params.id, 'tenant id');
    const input = parse(
      z.object({
        roomId: uuidSchema,
        startDate: isoDateSchema,
        bedId: uuidSchema.nullish(),
        monthlyRentPaise: z.number().int().nonnegative().optional(),
        reason: z.string().max(500).nullish(),
      }),
      req.body,
      'admission',
    );

    const result = await withTransaction(async (tx) => {
      const { rows } = await tx.query<{ branch_id: string }>(
        'SELECT branch_id FROM rooms WHERE id = $1',
        [input.roomId],
      );
      if (!rows[0]) throw notFound('Room');
      assertBranchAccess(actor, rows[0].branch_id);

      const admitted = await admitTenant(
        tx,
        {
          tenantId, roomId: input.roomId, startDate: input.startDate,
          bedId: input.bedId ?? null, monthlyRentPaise: input.monthlyRentPaise,
          moveReason: input.reason ?? null,
        },
        { userId: actor.id, ipAddress: req.ip, userAgent: req.header('user-agent') },
      );
      await tx.query(`UPDATE tenants SET status = 'active', exit_date = NULL WHERE id = $1`, [tenantId]);
      return admitted;
    });

    res.status(201).json(result);
  }),
);

/**
 * Moves a tenant to another room from a given date. Closes the current stay
 * and opens a new one; the tenant's previous location is preserved.
 */
tenantsRouter.post(
  '/:id/move',
  requirePermission(PERMISSIONS.TENANT_MOVE),
  handler(async (req, res) => {
    const actor = currentUser(req);
    const tenantId = parse(uuidSchema, req.params.id, 'tenant id');
    const input = parse(
      z.object({
        toRoomId: uuidSchema,
        effectiveDate: isoDateSchema,
        bedId: uuidSchema.nullish(),
        monthlyRentPaise: z.number().int().nonnegative().optional(),
        reason: z.string().max(500).nullish(),
      }),
      req.body,
      'move',
    );

    const result = await withTransaction(async (tx) => {
      const { rows } = await tx.query<{ branch_id: string }>(
        'SELECT branch_id FROM rooms WHERE id = $1',
        [input.toRoomId],
      );
      if (!rows[0]) throw notFound('Room');
      assertBranchAccess(actor, rows[0].branch_id);

      return moveTenant(
        tx,
        {
          tenantId, toRoomId: input.toRoomId, effectiveDate: input.effectiveDate,
          bedId: input.bedId ?? null, monthlyRentPaise: input.monthlyRentPaise,
          reason: input.reason ?? null,
        },
        { userId: actor.id, ipAddress: req.ip, userAgent: req.header('user-agent') },
      );
    });

    res.json(result);
  }),
);

tenantsRouter.post(
  '/:id/vacate',
  requirePermission(PERMISSIONS.TENANT_MOVE),
  handler(async (req, res) => {
    const actor = currentUser(req);
    const tenantId = parse(uuidSchema, req.params.id, 'tenant id');
    const input = parse(
      z.object({ lastDate: isoDateSchema, reason: z.string().max(500).nullish() }),
      req.body,
      'vacate',
    );

    const result = await withTransaction((tx) =>
      vacateTenant(
        tx,
        { tenantId, lastDate: input.lastDate, reason: input.reason ?? null },
        { userId: actor.id, ipAddress: req.ip, userAgent: req.header('user-agent') },
      ),
    );

    res.json(result);
  }),
);

// ---------------------------------------------------------------------------
// Identity documents (sensitive)
// ---------------------------------------------------------------------------
tenantsRouter.post(
  '/:id/documents',
  requirePermission(PERMISSIONS.TENANT_DOCUMENT_WRITE),
  upload.single('file'),
  handler(async (req, res) => {
    const actor = currentUser(req);
    const tenantId = parse(uuidSchema, req.params.id, 'tenant id');
    const input = parse(
      z.object({
        docType: z.enum(['aadhaar', 'office_id', 'pan', 'photo', 'agreement', 'other']),
        /** Full number, used only to derive the masked form; never stored raw. */
        identifier: z.string().max(40).optional(),
      }),
      req.body,
      'document',
    );
    if (!req.file) throw badRequest('Attach a file under the "file" field');

    const stored = await storeFile(`tenant-documents/${tenantId}`, req.file);

    const id = await withTransaction(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO tenant_documents
           (tenant_id, doc_type, storage_key, original_name, mime_type, size_bytes,
            masked_identifier, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [
          tenantId, input.docType, stored.storageKey, stored.originalName, stored.mimeType,
          stored.sizeBytes, input.identifier ? maskIdentifier(input.identifier) : null, actor.id,
        ],
      );
      await writeAudit(tx, {
        userId: actor.id,
        action: AUDIT.TENANT_DOCUMENT_UPLOADED,
        entityType: 'tenant_document',
        entityId: rows[0]!.id,
        // The raw identifier is not recorded in the audit trail either.
        after: { tenantId, docType: input.docType, originalName: stored.originalName },
        ipAddress: req.ip, userAgent: req.header('user-agent'),
      });
      return rows[0]!.id;
    });

    res.status(201).json({ id });
  }),
);

/**
 * Streams an identity document to an authorised caller.
 *
 * Every access is written to the audit trail before a byte is sent, so who
 * looked at whose Aadhaar, and when, is always answerable.
 */
tenantsRouter.get(
  '/:id/documents/:documentId/file',
  requirePermission(PERMISSIONS.TENANT_DOCUMENT_READ),
  handler(async (req, res) => {
    const actor = currentUser(req);
    const tenantId = parse(uuidSchema, req.params.id, 'tenant id');
    const documentId = parse(uuidSchema, req.params.documentId, 'document id');

    const { rows } = await query<{
      storage_key: string;
      mime_type: string;
      original_name: string;
      doc_type: string;
    }>(
      'SELECT storage_key, mime_type, original_name, doc_type FROM tenant_documents WHERE id = $1 AND tenant_id = $2',
      [documentId, tenantId],
    );
    const document = rows[0];
    if (!document) throw notFound('Document');

    await withTransaction((tx) =>
      writeAudit(tx, {
        userId: actor.id,
        action: AUDIT.TENANT_DOCUMENT_ACCESSED,
        entityType: 'tenant_document',
        entityId: documentId,
        meta: { tenantId, docType: document.doc_type },
        ipAddress: req.ip, userAgent: req.header('user-agent'),
      }),
    );

    res.setHeader('Content-Type', document.mime_type);
    res.setHeader('Content-Disposition', `inline; filename="${document.original_name}"`);
    res.setHeader('Cache-Control', 'no-store');
    readFileStream(document.storage_key).pipe(res);
  }),
);
