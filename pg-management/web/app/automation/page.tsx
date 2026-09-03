'use client';

import { AppShell } from '@/components/AppShell';
import { Badge, Button, Card, EmptyState, ErrorState, Loading, SectionHeading } from '@/components/ui';
import { useApiQuery, useApiMutation } from '@/lib/useApi';
import { useAuth, P } from '@/lib/auth';

type Job = {
  id: string; code: string; name: string; description: string | null;
  schedule_cron: string | null; is_enabled: boolean;
  last_status: string | null; last_started_at: string | null;
  last_result: { summary?: string } | null; last_error: string | null;
};

/**
 * The automation catalogue.
 *
 * These jobs are what keeps the owner's daily work down to exceptions: bills
 * generate themselves on the 1st, reminders go out on their ladder and stop
 * when a bill is paid. Every run is recorded, so a job that quietly stopped
 * working shows up here rather than being noticed a month later.
 */
export default function AutomationPage() {
  const { can } = useAuth();
  const jobs = useApiQuery<{ jobs: Job[] }>('/api/automation/jobs');
  const runs = useApiQuery<{
    runs: { id: string; code: string; name: string; status: string; started_at: string;
            result: { summary?: string } | null; error: string | null }[];
  }>('/api/automation/runs', { limit: 20 });

  const run = useApiMutation<{ status: string }, string>((code) => ({
    path: `/api/automation/jobs/${code}/run`,
    body: {},
  }));

  return (
    <AppShell title="Automation" subtitle="Scheduled work and its history">
      {jobs.loading ? <Loading /> : null}
      {jobs.error ? <ErrorState message={jobs.error.message} onRetry={jobs.reload} /> : null}

      {jobs.data ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {jobs.data.jobs.map((job) => (
            <Card key={job.id}>
              <div className="flex items-start justify-between gap-2">
                <p className="font-medium">{job.name}</p>
                <Badge tone={job.is_enabled ? 'positive' : 'neutral'}>
                  {job.is_enabled ? 'on' : 'off'}
                </Badge>
              </div>
              {job.description ? (
                <p className="mt-1 text-sm text-content-muted">{job.description}</p>
              ) : null}
              {job.schedule_cron ? (
                <p className="mt-2 font-mono text-xs text-content-muted">{job.schedule_cron}</p>
              ) : null}

              {job.last_status ? (
                <p className="mt-2 text-xs text-content-muted">
                  Last run:{' '}
                  <span
                    className={
                      job.last_status === 'failed' ? 'text-critical' : 'text-content-muted'
                    }
                  >
                    {job.last_status}
                  </span>
                  {job.last_result?.summary ? ` — ${job.last_result.summary}` : ''}
                  {job.last_error ? ` — ${job.last_error}` : ''}
                </p>
              ) : (
                <p className="mt-2 text-xs text-content-muted">Not run yet.</p>
              )}

              {can(P.AUTOMATION_RUN) ? (
                <div className="mt-3">
                  <Button
                    size="sm"
                    variant="secondary"
                    fullWidth
                    disabled={run.pending}
                    onClick={async () => {
                      await run.run(job.code);
                      jobs.reload();
                      runs.reload();
                    }}
                  >
                    Run now
                  </Button>
                </div>
              ) : null}
            </Card>
          ))}
        </div>
      ) : null}

      <section className="mt-6">
        <SectionHeading title="Recent runs" />
        {runs.data ? (
          runs.data.runs.length === 0 ? (
            <EmptyState title="No runs recorded yet" />
          ) : (
            <ul className="space-y-2">
              {runs.data.runs.map((item) => (
                <li key={item.id}>
                  <Card className="flex items-start justify-between gap-3 text-sm">
                    <div className="min-w-0">
                      <p className="font-medium">{item.name}</p>
                      <p className="truncate text-content-muted">
                        {item.result?.summary ?? item.error ?? '—'}
                      </p>
                    </div>
                    <Badge
                      tone={
                        item.status === 'success'
                          ? 'positive'
                          : item.status === 'failed'
                            ? 'critical'
                            : 'caution'
                      }
                    >
                      {item.status}
                    </Badge>
                  </Card>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </section>
    </AppShell>
  );
}
