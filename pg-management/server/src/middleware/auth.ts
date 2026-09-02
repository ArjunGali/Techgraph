import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { query } from '../db/pool.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { effectivePermissions, type Permission, type Role } from '../lib/permissions.js';

export type AuthenticatedUser = {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  permissions: Set<string>;
  /** Branches this user may act on. `null` means every branch (admins). */
  branchIds: string[] | null;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

export type TokenPayload = { sub: string; role: Role };

export function signAccessToken(userId: string, role: Role): string {
  return jwt.sign({ sub: userId, role } satisfies TokenPayload, env.JWT_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL as jwt.SignOptions['expiresIn'],
  });
}

type UserRow = {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  is_active: boolean;
};

/**
 * Verifies the bearer token and loads the caller's live role, permission
 * overrides and branch assignments.
 *
 * These are read from the database on every request rather than trusted from
 * the token, so revoking a permission or deactivating a user takes effect
 * immediately instead of when their token happens to expire.
 */
export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const header = req.header('authorization');
    if (!header?.startsWith('Bearer ')) throw unauthorized();

    let payload: TokenPayload;
    try {
      payload = jwt.verify(header.slice(7), env.JWT_SECRET) as TokenPayload;
    } catch {
      throw unauthorized('Your session has expired. Sign in again.');
    }

    const { rows } = await query<UserRow>(
      'SELECT id, email, full_name, role, is_active FROM users WHERE id = $1',
      [payload.sub],
    );
    const user = rows[0];
    if (!user) throw unauthorized('Account no longer exists');
    if (!user.is_active) throw forbidden('This account has been deactivated');

    const [overrides, branches] = await Promise.all([
      query<{ permission: string; granted: boolean }>(
        'SELECT permission, granted FROM user_permissions WHERE user_id = $1',
        [user.id],
      ),
      query<{ branch_id: string }>('SELECT branch_id FROM user_branches WHERE user_id = $1', [
        user.id,
      ]),
    ]);

    const assigned = branches.rows.map((row) => row.branch_id);

    req.user = {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      role: user.role,
      permissions: effectivePermissions(user.role, overrides.rows),
      // An admin, or any user with no explicit assignment, works across every
      // branch; otherwise they are confined to the branches listed for them.
      branchIds: user.role === 'admin' || assigned.length === 0 ? null : assigned,
    };

    next();
  } catch (error) {
    next(error);
  }
}

export function currentUser(req: Request): AuthenticatedUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

/** Refuses the request unless the caller holds every listed permission. */
export function requirePermission(...required: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const user = currentUser(req);
      const missing = required.filter((permission) => !user.permissions.has(permission));
      if (missing.length > 0) {
        throw forbidden(
          `Your role (${user.role}) cannot do this. Missing permission: ${missing.join(', ')}.`,
        );
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Throws unless the caller is assigned to the branch they are acting on. */
export function assertBranchAccess(user: AuthenticatedUser, branchId: string): void {
  if (user.branchIds === null) return;
  if (!user.branchIds.includes(branchId)) {
    throw forbidden('You are not assigned to this branch');
  }
}

/**
 * A SQL fragment restricting a query to the caller's branches, for list
 * endpoints. Returns null when the caller may see everything.
 */
export function branchFilter(user: AuthenticatedUser): string[] | null {
  return user.branchIds;
}
