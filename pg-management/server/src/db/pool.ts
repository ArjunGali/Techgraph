import pg from 'pg';
import { env } from '../config/env.js';

const { Pool, types } = pg;

// node-postgres hands back DATE columns as JS Date objects in the server's
// local timezone, which silently shifts a date by a day either side of UTC.
// Billing is entirely date-driven, so DATE is parsed as a plain 'YYYY-MM-DD'
// string and never touches a timezone.
types.setTypeParser(types.builtins.DATE, (value: string) => value);

// BIGINT arrives as a string so precision cannot be lost. Every bigint column
// in this schema holds paise or a day count, both far inside Number.MAX_SAFE_INTEGER.
types.setTypeParser(types.builtins.INT8, (value: string) => Number(value));

// NUMERIC (meter readings) likewise.
types.setTypeParser(types.builtins.NUMERIC, (value: string) => Number(value));

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
  application_name: 'pg-management-api',
});

pool.on('error', (error) => {
  console.error('[db] idle client error', error);
});

export type QueryParam = unknown;

/** Runs a query on the shared pool. */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: QueryParam[] = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as never[]);
}

export type Db = {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: QueryParam[],
  ): Promise<pg.QueryResult<T>>;
};

/**
 * Runs `fn` inside a transaction, rolling back on any thrown error.
 *
 * Every write that touches more than one table — a tenant move, a payment
 * approval, closing a month — goes through here, so a partial write can never
 * be committed and its audit row is written atomically alongside it.
 */
export async function withTransaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
