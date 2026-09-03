import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { query, withTransaction } from '../../db/pool.js';
import { handler, parse, uuidSchema } from '../../lib/http.js';
import { badRequest, forbidden, unauthorized } from '../../lib/errors.js';
import { AUDIT, writeAudit } from '../../lib/audit.js';
import { ROLE_PERMISSIONS, type Role } from '../../lib/permissions.js';
import {
  authenticate,
  currentUser,
  requirePermission,
  signAccessToken,
} from '../../middleware/auth.js';
import { PERMISSIONS } from '../../lib/permissions.js';

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1, 'Password is required'),
});

type UserRow = {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  password_hash: string;
  is_active: boolean;
};

authRouter.post(
  '/login',
  handler(async (req, res) => {
    const { email, password } = parse(loginSchema, req.body, 'credentials');

    const { rows } = await query<UserRow>(
      'SELECT id, email, full_name, role, password_hash, is_active FROM users WHERE lower(email) = lower($1)',
      [email],
    );
    const user = rows[0];

    // The same message and roughly the same work either way, so the response
    // does not reveal whether an email address has an account.
    const hash = user?.password_hash ?? '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';
    const passwordMatches = await bcrypt.compare(password, hash);

    if (!user || !passwordMatches) {
      await withTransaction((tx) =>
        writeAudit(tx, {
          userId: user?.id ?? null,
          action: AUDIT.LOGIN_FAILED,
          entityType: 'user',
          entityId: user?.id ?? null,
          meta: { email },
          ipAddress: req.ip ?? null,
          userAgent: req.header('user-agent') ?? null,
        }),
      );
      throw unauthorized('Email or password is incorrect');
    }

    if (!user.is_active) throw forbidden('This account has been deactivated');

    await withTransaction(async (tx) => {
      await tx.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
      await writeAudit(tx, {
        userId: user.id,
        action: AUDIT.LOGIN,
        entityType: 'user',
        entityId: user.id,
        ipAddress: req.ip ?? null,
        userAgent: req.header('user-agent') ?? null,
      });
    });

    const branches = await query<{ branch_id: string }>(
      'SELECT branch_id FROM user_branches WHERE user_id = $1',
      [user.id],
    );
    const overrides = await query<{ permission: string; granted: boolean }>(
      'SELECT permission, granted FROM user_permissions WHERE user_id = $1',
      [user.id],
    );

    const permissions = new Set<string>(ROLE_PERMISSIONS[user.role]);
    for (const override of overrides.rows) {
      if (override.granted) permissions.add(override.permission);
      else permissions.delete(override.permission);
    }

    res.json({
      token: signAccessToken(user.id, user.role),
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        role: user.role,
        permissions: [...permissions],
        branchIds:
          user.role === 'admin' || branches.rows.length === 0
            ? null
            : branches.rows.map((row) => row.branch_id),
      },
    });
  }),
);

authRouter.get(
  '/me',
  authenticate,
  handler(async (req, res) => {
    const user = currentUser(req);
    res.json({
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        permissions: [...user.permissions],
        branchIds: user.branchIds,
      },
    });
  }),
);

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'New password must be at least 8 characters'),
});

authRouter.post(
  '/change-password',
  authenticate,
  handler(async (req, res) => {
    const user = currentUser(req);
    const { currentPassword, newPassword } = parse(changePasswordSchema, req.body, 'password change');

    const { rows } = await query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [user.id],
    );
    const matches = await bcrypt.compare(currentPassword, rows[0]?.password_hash ?? '');
    if (!matches) throw badRequest('Your current password is incorrect');

    const hash = await bcrypt.hash(newPassword, env.BCRYPT_ROUNDS);
    await withTransaction(async (tx) => {
      await tx.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [
        hash,
        user.id,
      ]);
      await writeAudit(tx, {
        userId: user.id,
        action: AUDIT.USER_UPDATED,
        entityType: 'user',
        entityId: user.id,
        meta: { field: 'password' },
      });
    });

    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// User administration
// ---------------------------------------------------------------------------
authRouter.get(
  '/users',
  authenticate,
  requirePermission(PERMISSIONS.USER_MANAGE),
  handler(async (_req, res) => {
    const { rows } = await query(
      `SELECT u.id, u.email, u.full_name, u.phone, u.role, u.is_active, u.last_login_at, u.created_at,
              coalesce(
                (SELECT json_agg(json_build_object('id', b.id, 'name', b.name))
                   FROM user_branches ub JOIN branches b ON b.id = ub.branch_id
                  WHERE ub.user_id = u.id),
                '[]'::json
              ) AS branches
         FROM users u
        ORDER BY u.full_name`,
    );
    res.json({ users: rows });
  }),
);

const createUserSchema = z.object({
  email: z.string().email(),
  fullName: z.string().min(1),
  phone: z.string().optional(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  role: z.enum(['admin', 'manager', 'staff']),
  branchIds: z.array(uuidSchema).default([]),
});

authRouter.post(
  '/users',
  authenticate,
  requirePermission(PERMISSIONS.USER_MANAGE),
  handler(async (req, res) => {
    const actor = currentUser(req);
    const input = parse(createUserSchema, req.body, 'user');
    const hash = await bcrypt.hash(input.password, env.BCRYPT_ROUNDS);

    const created = await withTransaction(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO users (email, full_name, phone, password_hash, role)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [input.email, input.fullName, input.phone ?? null, hash, input.role],
      );
      const userId = rows[0]!.id;

      for (const branchId of input.branchIds) {
        await tx.query('INSERT INTO user_branches (user_id, branch_id) VALUES ($1, $2)', [
          userId,
          branchId,
        ]);
      }

      await writeAudit(tx, {
        userId: actor.id,
        action: AUDIT.USER_CREATED,
        entityType: 'user',
        entityId: userId,
        after: { email: input.email, role: input.role, branchIds: input.branchIds },
      });

      return userId;
    });

    res.status(201).json({ id: created });
  }),
);

const updateUserSchema = z.object({
  fullName: z.string().min(1).optional(),
  phone: z.string().nullable().optional(),
  role: z.enum(['admin', 'manager', 'staff']).optional(),
  isActive: z.boolean().optional(),
  branchIds: z.array(uuidSchema).optional(),
  password: z.string().min(8).optional(),
});

authRouter.patch(
  '/users/:id',
  authenticate,
  requirePermission(PERMISSIONS.USER_MANAGE),
  handler(async (req, res) => {
    const actor = currentUser(req);
    const userId = parse(uuidSchema, req.params.id, 'user id');
    const input = parse(updateUserSchema, req.body, 'user');

    await withTransaction(async (tx) => {
      const { rows } = await tx.query(
        'SELECT id, email, full_name, phone, role, is_active FROM users WHERE id = $1',
        [userId],
      );
      const before = rows[0];
      if (!before) throw badRequest('No such user');

      // An admin must not be able to lock the business out of its own system.
      if (input.isActive === false || (input.role && input.role !== 'admin')) {
        const { rows: admins } = await tx.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM users WHERE role = 'admin' AND is_active AND id <> $1",
          [userId],
        );
        if (before.role === 'admin' && (admins[0]?.count ?? 0) === 0) {
          throw badRequest('This is the last active admin — promote another admin first');
        }
      }

      await tx.query(
        `UPDATE users SET
            full_name  = coalesce($2, full_name),
            phone      = CASE WHEN $3::boolean THEN $4 ELSE phone END,
            role       = coalesce($5, role),
            is_active  = coalesce($6, is_active),
            password_hash = coalesce($7, password_hash),
            updated_at = now()
          WHERE id = $1`,
        [
          userId,
          input.fullName ?? null,
          input.phone !== undefined,
          input.phone ?? null,
          input.role ?? null,
          input.isActive ?? null,
          input.password ? await bcrypt.hash(input.password, env.BCRYPT_ROUNDS) : null,
        ],
      );

      if (input.branchIds) {
        await tx.query('DELETE FROM user_branches WHERE user_id = $1', [userId]);
        for (const branchId of input.branchIds) {
          await tx.query('INSERT INTO user_branches (user_id, branch_id) VALUES ($1, $2)', [
            userId,
            branchId,
          ]);
        }
      }

      await writeAudit(tx, {
        userId: actor.id,
        action: AUDIT.USER_UPDATED,
        entityType: 'user',
        entityId: userId,
        before,
        after: { ...input, password: input.password ? '[changed]' : undefined },
      });
    });

    res.json({ ok: true });
  }),
);

/** The permission catalogue, so the client can render role management. */
authRouter.get(
  '/permissions',
  authenticate,
  requirePermission(PERMISSIONS.USER_MANAGE),
  handler(async (_req, res) => {
    res.json({ roles: ROLE_PERMISSIONS });
  }),
);
