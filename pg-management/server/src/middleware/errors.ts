import type { NextFunction, Request, Response } from 'express';
import pg from 'pg';
import { AppError } from '../lib/errors.js';
import { CalculationError } from '../calc/eb.js';
import { isProduction } from '../config/env.js';

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: { code: 'not_found', message: 'No such endpoint' } });
}

/** Turns a PostgreSQL integrity error into a message the user can act on. */
function translateDatabaseError(error: pg.DatabaseError): AppError | null {
  switch (error.code) {
    case '23505': // unique_violation
      if (error.constraint === 'payments_reference_key') {
        return new AppError(
          409,
          'duplicate_reference',
          'That transaction reference has already been recorded for this tenant.',
        );
      }
      return new AppError(
        409,
        'duplicate',
        'That already exists. Use a different identifier.',
        { constraint: error.constraint },
      );
    case '23P01': // exclusion_violation
      if (error.constraint === 'tenant_stays_no_overlap_per_tenant') {
        return new AppError(
          409,
          'overlapping_stay',
          'This tenant already has a stay covering those dates. Close the existing stay first.',
        );
      }
      if (error.constraint === 'tenant_stays_no_overlap_per_bed') {
        return new AppError(
          409,
          'bed_occupied',
          'That bed is already occupied for part of this period.',
        );
      }
      if (error.constraint === 'price_rules_no_overlap') {
        return new AppError(
          409,
          'overlapping_price',
          'A price for this scope is already in force over those dates. Close it first.',
        );
      }
      if (error.constraint === 'charge_rates_no_overlap') {
        return new AppError(
          409,
          'overlapping_rate',
          'A rate for this charge is already in force over those dates. Close it first.',
        );
      }
      return new AppError(409, 'conflict', 'That conflicts with an existing record.');
    case '23503': // foreign_key_violation
      return new AppError(
        409,
        'in_use',
        'That record is referenced by other data and cannot be removed.',
        { constraint: error.constraint },
      );
    case '23514': // check_violation
      return new AppError(400, 'invalid_value', 'A value failed a database rule.', {
        constraint: error.constraint,
      });
    default:
      return null;
  }
}

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  let appError: AppError;

  if (error instanceof AppError) {
    appError = error;
  } else if (error instanceof CalculationError) {
    appError = new AppError(422, error.code, error.message);
  } else if (error instanceof pg.DatabaseError) {
    appError = translateDatabaseError(error) ??
      new AppError(500, 'database_error', 'The database rejected that operation.');
    if (appError.status >= 500) console.error('[api] database error', error);
  } else {
    appError = new AppError(500, 'internal_error', 'Something went wrong.');
    console.error('[api] unhandled error on', req.method, req.originalUrl, error);
  }

  const body: Record<string, unknown> = {
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.details === undefined ? {} : { details: appError.details }),
    },
  };

  if (!isProduction && appError.status >= 500 && error instanceof Error) {
    (body.error as Record<string, unknown>).stack = error.stack;
  }

  res.status(appError.status).json(body);
}
