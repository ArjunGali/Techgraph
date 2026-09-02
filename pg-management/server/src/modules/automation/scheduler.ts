import { query } from '../../db/pool.js';
import { JOB_HANDLERS, runJob } from './jobs.js';

/**
 * The in-process scheduler.
 *
 * Ticks once a minute and runs any enabled job whose schedule matches. Kept
 * deliberately small: it understands the five standard cron fields and nothing
 * more, which covers "the 1st at 9am" and "every day at 8am" without pulling
 * in a dependency. Set AUTOMATION_ENABLED=false to run jobs from an external
 * scheduler against the same API instead.
 */

const TICK_MS = 60_000;

// Matches one cron field against a value. Handles `*`, `5`, `1,15`, `1-5` and
// step syntax such as `*/2`.
function matchesField(field: string, value: number): boolean {
  if (field === '*') return true;

  return field.split(',').some((part) => {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isFinite(step) || step <= 0) return false;

    if (rangePart === '*' || rangePart === undefined) return value % step === 0;

    if (rangePart.includes('-')) {
      const [startText, endText] = rangePart.split('-');
      const start = Number(startText);
      const end = Number(endText);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
      return value >= start && value <= end && (value - start) % step === 0;
    }

    const exact = Number(rangePart);
    return Number.isFinite(exact) && exact === value;
  });
}

/** True when `cron` (minute hour day month weekday) fires at `when`. */
export function cronMatches(cron: string, when: Date): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string, string, string, string, string,
  ];

  return (
    matchesField(minute, when.getMinutes()) &&
    matchesField(hour, when.getHours()) &&
    matchesField(dayOfMonth, when.getDate()) &&
    matchesField(month, when.getMonth() + 1) &&
    matchesField(dayOfWeek, when.getDay())
  );
}

let timer: NodeJS.Timeout | null = null;

async function tick(): Promise<void> {
  const now = new Date();
  try {
    const { rows } = await query<{ code: string; schedule_cron: string | null; last_run_at: string | null }>(
      `SELECT code, schedule_cron, last_run_at FROM automation_jobs
        WHERE is_enabled AND schedule_cron IS NOT NULL`,
    );

    for (const job of rows) {
      if (!job.schedule_cron || !JOB_HANDLERS[job.code]) continue;
      if (!cronMatches(job.schedule_cron, now)) continue;

      // The tick fires once a minute, so a job that already ran inside this
      // minute is skipped rather than run twice.
      if (job.last_run_at) {
        const lastRun = new Date(job.last_run_at);
        if (now.getTime() - lastRun.getTime() < TICK_MS) continue;
      }

      console.log(`[scheduler] running ${job.code}`);
      const result = await runJob(job.code, { userId: null });
      console.log(`[scheduler] ${job.code}: ${result.status} — ${result.result?.summary ?? result.error}`);
    }
  } catch (error) {
    // A scheduler failure must never take the API process down with it.
    console.error('[scheduler] tick failed', error);
  }
}

export function startScheduler(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
  console.log('[scheduler] started, ticking every 60s');
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
