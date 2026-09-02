import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { handler, isoDateSchema, parse } from '../../lib/http.js';
import { badRequest } from '../../lib/errors.js';
import { PERMISSIONS } from '../../lib/permissions.js';
import { authenticate, currentUser, requirePermission } from '../../middleware/auth.js';
import { JOB_HANDLERS, runJob } from './jobs.js';

export const automationRouter = Router();
automationRouter.use(authenticate);

automationRouter.get(
  '/jobs',
  requirePermission(PERMISSIONS.AUTOMATION_READ),
  handler(async (_req, res) => {
    const { rows } = await query(
      `SELECT j.*, last_run.status AS last_status, last_run.started_at AS last_started_at,
              last_run.finished_at AS last_finished_at, last_run.result AS last_result,
              last_run.error AS last_error
         FROM automation_jobs j
         LEFT JOIN LATERAL (
           SELECT status::text, started_at, finished_at, result, error
             FROM automation_runs r WHERE r.job_id = j.id
            ORDER BY r.started_at DESC LIMIT 1
         ) last_run ON TRUE
        ORDER BY j.code`,
    );
    res.json({ jobs: rows, availableJobs: Object.keys(JOB_HANDLERS) });
  }),
);

automationRouter.get(
  '/runs',
  requirePermission(PERMISSIONS.AUTOMATION_READ),
  handler(async (req, res) => {
    const filters = parse(
      z.object({
        code: z.string().max(60).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      req.query,
      'run filters',
    );

    const { rows } = await query(
      `SELECT r.*, j.code, j.name, u.full_name AS triggered_by_name
         FROM automation_runs r
         JOIN automation_jobs j ON j.id = r.job_id
         LEFT JOIN users u ON u.id = r.triggered_by
        WHERE ($1::text IS NULL OR j.code = $1)
        ORDER BY r.started_at DESC LIMIT $2`,
      [filters.code ?? null, filters.limit],
    );
    res.json({ runs: rows });
  }),
);

/** Runs a job on demand. Same code path as the scheduler, same recorded run. */
automationRouter.post(
  '/jobs/:code/run',
  requirePermission(PERMISSIONS.AUTOMATION_RUN),
  handler(async (req, res) => {
    const actor = currentUser(req);
    const code = z.string().min(1).max(60).parse(req.params.code);
    if (!JOB_HANDLERS[code]) {
      throw badRequest(`Unknown job "${code}". Available: ${Object.keys(JOB_HANDLERS).join(', ')}`);
    }

    const input = parse(
      z.object({ referenceDate: isoDateSchema.optional() }),
      req.body ?? {},
      'run options',
    );

    const result = await runJob(code, {
      userId: actor.id,
      referenceDate: input.referenceDate,
    });
    res.json(result);
  }),
);

automationRouter.patch(
  '/jobs/:code',
  requirePermission(PERMISSIONS.SETTINGS_WRITE),
  handler(async (req, res) => {
    const code = z.string().min(1).max(60).parse(req.params.code);
    const input = parse(
      z.object({
        isEnabled: z.boolean().optional(),
        scheduleCron: z.string().max(120).nullish(),
        name: z.string().max(120).optional(),
        description: z.string().max(500).nullish(),
      }),
      req.body,
      'job settings',
    );

    await query(
      `UPDATE automation_jobs SET
         is_enabled = coalesce($2, is_enabled),
         schedule_cron = coalesce($3, schedule_cron),
         name = coalesce($4, name),
         description = coalesce($5, description),
         updated_at = now()
       WHERE lower(code) = lower($1)`,
      [code, input.isEnabled ?? null, input.scheduleCron ?? null, input.name ?? null, input.description ?? null],
    );
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// Reminder ladder
// ---------------------------------------------------------------------------
automationRouter.get(
  '/reminders',
  requirePermission(PERMISSIONS.AUTOMATION_READ),
  handler(async (_req, res) => {
    const { rows } = await query(
      `SELECT rr.*, b.name AS branch_name FROM reminder_rules rr
         LEFT JOIN branches b ON b.id = rr.branch_id
        ORDER BY rr.day_of_month`,
    );
    res.json({ rules: rows });
  }),
);

automationRouter.post(
  '/reminders',
  requirePermission(PERMISSIONS.SETTINGS_WRITE),
  handler(async (req, res) => {
    const input = parse(
      z.object({
        branchId: z.string().uuid().nullish(),
        dayOfMonth: z.number().int().min(1).max(28),
        templateCode: z.string().min(1).max(60),
        label: z.string().min(1).max(120),
        isActive: z.boolean().default(true),
      }),
      req.body,
      'reminder rule',
    );

    const { rows } = await query<{ id: string }>(
      `INSERT INTO reminder_rules (branch_id, day_of_month, template_code, label, is_active)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (coalesce(branch_id::text, 'default'), day_of_month) DO UPDATE SET
         template_code = EXCLUDED.template_code, label = EXCLUDED.label,
         is_active = EXCLUDED.is_active
       RETURNING id`,
      [input.branchId ?? null, input.dayOfMonth, input.templateCode, input.label, input.isActive],
    );
    res.status(201).json({ id: rows[0]!.id });
  }),
);
