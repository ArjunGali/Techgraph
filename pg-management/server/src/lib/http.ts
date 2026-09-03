import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z, type ZodTypeAny } from 'zod';
import { badRequest } from './errors.js';

/** Wraps an async handler so a rejected promise reaches the error middleware. */
export function handler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/**
 * Parses a request part against a schema, turning issues into a 400.
 *
 * Generic over the schema rather than its output type, so a schema using
 * `.default()` — whose input and output types differ — still yields the parsed
 * output type at the call site.
 */
export function parse<S extends ZodTypeAny>(schema: S, value: unknown, what: string): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw badRequest(
      `Invalid ${what}`,
      result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

export const uuidSchema = z.string().uuid('must be a UUID');

/** A calendar date, kept as a string so no timezone can shift it. */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a YYYY-MM-DD date');

/** The first day of a billing month. */
export const periodMonthSchema = isoDateSchema.refine(
  (value) => value.endsWith('-01'),
  'must be the first day of a month, e.g. 2026-08-01',
);

/** An amount in whole paise. */
export const paiseSchema = z
  .number()
  .int('must be a whole number of paise')
  .nonnegative('cannot be negative');

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type Pagination = z.infer<typeof paginationSchema>;
