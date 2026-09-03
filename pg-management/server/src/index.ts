import { createApp } from './app.js';
import { env } from './config/env.js';
import { closePool, query } from './db/pool.js';
import { startScheduler, stopScheduler } from './modules/automation/scheduler.js';

const app = createApp();

// Fail fast on a bad database URL rather than serving 500s once traffic
// arrives.
try {
  await query('SELECT 1');
  console.log('[api] database connection verified');
} catch (error) {
  console.error('[api] cannot reach the database:', (error as Error).message);
  process.exit(1);
}

const server = app.listen(env.PORT, () => {
  console.log(`[api] PG Management API listening on port ${env.PORT} (${env.NODE_ENV})`);
});

if (env.AUTOMATION_ENABLED) startScheduler();

async function shutdown(signal: string): Promise<void> {
  console.log(`[api] ${signal} received, shutting down`);
  stopScheduler();
  server.close(async () => {
    await closePool();
    process.exit(0);
  });
  // Do not hang forever if a connection refuses to drain.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
