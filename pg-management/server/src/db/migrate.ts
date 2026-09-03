import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { pool, closePool } from './pool.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

type AppliedMigration = { name: string; checksum: string };

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      checksum    TEXT        NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function listMigrationFiles(): Promise<string[]> {
  const entries = await readdir(migrationsDir);
  return entries.filter((name) => name.endsWith('.sql')).sort();
}

function checksumOf(sql: string): string {
  return createHash('sha256').update(sql).digest('hex').slice(0, 16);
}

async function appliedMigrations(): Promise<Map<string, string>> {
  const { rows } = await pool.query<AppliedMigration>(
    'SELECT name, checksum FROM schema_migrations',
  );
  return new Map(rows.map((row) => [row.name, row.checksum]));
}

/**
 * Applies every migration that has not run yet, each inside its own
 * transaction so a failure leaves the database on the last good migration
 * rather than half-way through one.
 */
async function up(): Promise<void> {
  await ensureMigrationsTable();
  const applied = await appliedMigrations();
  const files = await listMigrationFiles();

  let ran = 0;
  for (const name of files) {
    const sql = await readFile(join(migrationsDir, name), 'utf8');
    const checksum = checksumOf(sql);
    const previous = applied.get(name);

    if (previous) {
      if (previous !== checksum) {
        throw new Error(
          `Migration ${name} has changed since it was applied (${previous} -> ${checksum}). ` +
            'Applied migrations are immutable — add a new migration instead.',
        );
      }
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
        name,
        checksum,
      ]);
      await client.query('COMMIT');
      console.log(`[migrate] applied ${name}`);
      ran += 1;
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${name} failed: ${(error as Error).message}`, { cause: error });
    } finally {
      client.release();
    }
  }

  console.log(ran === 0 ? '[migrate] already up to date' : `[migrate] applied ${ran} migration(s)`);
}

async function status(): Promise<void> {
  await ensureMigrationsTable();
  const applied = await appliedMigrations();
  const files = await listMigrationFiles();
  for (const name of files) {
    console.log(`${applied.has(name) ? '  applied' : '  pending'}  ${name}`);
  }
}

const command = process.argv[2] ?? 'up';

try {
  if (command === 'up') {
    await up();
  } else if (command === 'status') {
    await status();
  } else {
    console.error(`Unknown command: ${command}. Use "up" or "status".`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error('[migrate] failed:', (error as Error).message);
  process.exitCode = 1;
} finally {
  await closePool();
}
