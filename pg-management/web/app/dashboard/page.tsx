'use client';

import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { Badge, Card, ErrorState, Loading, SectionHeading, Stat, cx } from '@/components/ui';
import { useApiQuery } from '@/lib/useApi';
import { useLayoutShape } from '@/lib/useMediaQuery';
import { formatMonth, formatRupees } from '@/lib/format';
import { useAuth } from '@/lib/auth';

type Exception = {
  code: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  entityId: string | null;
  branchName: string | null;
  action?: { route: string; label: string };
};

type DashboardResponse = {
  periodMonth: string;
  occupancy: {
    totalCapacity: number;
    occupied: number;
    vacant: number;
    occupancyPercent: number;
    upcomingVacancies: number;
  };
  finance: {
    expected_paise: number;
    collected_paise: number;
    pending_paise: number;
    overdue_paise: number;
    pending_approvals: number;
  } | null;
  exceptions: Exception[];
  exceptionCounts: { critical: number; warning: number; info: number };
};

/**
 * The owner's home screen.
 *
 * Ordered by what needs a decision. Anything requiring attention comes first,
 * then money, then occupancy — the routine numbers are there to confirm
 * nothing is wrong, not to be worked through.
 */
export default function DashboardPage() {
  const { data, error, loading, reload } = useApiQuery<DashboardResponse>('/api/dashboard');
  const { isTablet, isWide } = useLayoutShape();
  const { user } = useAuth();

  return (
    <AppShell
      title="Dashboard"
      subtitle={data ? formatMonth(data.periodMonth) : 'Loading'}
    >
      {loading ? <Loading /> : null}
      {error ? <ErrorState message={error.message} onRetry={reload} /> : null}

      {data ? (
        <div
          className={cx(
            'gap-4',
            // A single column on phones; on large tablets the attention list
            // sits beside the figures rather than below them.
            isWide ? 'grid grid-cols-3' : 'flex flex-col',
          )}
        >
          <div className={cx('space-y-4', isWide && 'col-span-2')}>
            <section>
              <SectionHeading title="Occupancy" />
              {/* Two across on the smallest phones, four once there is width. */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Capacity" value={String(data.occupancy.totalCapacity)} hint="beds" />
                <Stat label="Occupied" value={String(data.occupancy.occupied)} />
                <Stat
                  label="Vacant"
                  value={String(data.occupancy.vacant)}
                  tone={data.occupancy.vacant > 0 ? 'caution' : 'default'}
                />
                <Stat
                  label="Filled"
                  value={`${data.occupancy.occupancyPercent}%`}
                  hint={`${data.occupancy.upcomingVacancies} leaving soon`}
                />
              </div>
            </section>

            {data.finance ? (
              <section>
                <SectionHeading
                  title="This month"
                  subtitle={formatMonth(data.periodMonth)}
                />
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Stat label="Expected" value={formatRupees(data.finance.expected_paise)} />
                  <Stat
                    label="Collected"
                    value={formatRupees(data.finance.collected_paise)}
                    tone="positive"
                  />
                  <Stat
                    label="Pending"
                    value={formatRupees(data.finance.pending_paise)}
                    tone={data.finance.pending_paise > 0 ? 'caution' : 'default'}
                  />
                  <Stat
                    label="Overdue"
                    value={formatRupees(data.finance.overdue_paise)}
                    tone={data.finance.overdue_paise > 0 ? 'critical' : 'default'}
                  />
                </div>

                {data.finance.pending_approvals > 0 ? (
                  <Link href="/payments" className="mt-3 block">
                    <Card className="flex items-center justify-between gap-3 border-brand/40">
                      <div>
                        <p className="font-medium">
                          {data.finance.pending_approvals} payment
                          {data.finance.pending_approvals === 1 ? '' : 's'} awaiting your approval
                        </p>
                        <p className="text-sm text-content-muted">
                          Nothing is credited until you approve it.
                        </p>
                      </div>
                      <span aria-hidden className="text-brand">
                        →
                      </span>
                    </Card>
                  </Link>
                ) : null}
              </section>
            ) : null}

            {!isWide ? <AttentionList exceptions={data.exceptions} counts={data.exceptionCounts} /> : null}
          </div>

          {isWide ? (
            <div className="col-span-1">
              <AttentionList exceptions={data.exceptions} counts={data.exceptionCounts} />
            </div>
          ) : null}
        </div>
      ) : null}

      {data && !data.finance ? (
        <p className="mt-4 text-sm text-content-muted">
          Signed in as {user?.role}. Financial figures are not shown for this role.
        </p>
      ) : null}

      {isTablet ? null : null}
    </AppShell>
  );
}

function AttentionList({
  exceptions,
  counts,
}: {
  exceptions: Exception[];
  counts: { critical: number; warning: number; info: number };
}) {
  return (
    <section>
      <SectionHeading
        title="Needs attention"
        subtitle={
          exceptions.length === 0
            ? 'Everything is running normally'
            : `${counts.critical} critical, ${counts.warning} warning, ${counts.info} informational`
        }
      />

      {exceptions.length === 0 ? (
        <Card>
          <p className="text-sm text-content-muted">
            No exceptions. Routine work is being handled automatically.
          </p>
        </Card>
      ) : (
        <ul className="space-y-2">
          {exceptions.map((exception, index) => (
            <li key={`${exception.code}-${exception.entityId ?? index}`}>
              <ExceptionCard exception={exception} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ExceptionCard({ exception }: { exception: Exception }) {
  const tone =
    exception.severity === 'critical'
      ? 'critical'
      : exception.severity === 'warning'
        ? 'caution'
        : 'neutral';

  const body = (
    <Card
      className={cx(
        'border-l-4',
        exception.severity === 'critical'
          ? 'border-l-critical'
          : exception.severity === 'warning'
            ? 'border-l-caution'
            : 'border-l-border',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium">{exception.title}</p>
        <Badge tone={tone}>{exception.severity}</Badge>
      </div>
      <p className="mt-1 text-sm text-content-muted">{exception.detail}</p>
      {exception.branchName ? (
        <p className="mt-1 text-xs text-content-muted">{exception.branchName}</p>
      ) : null}
    </Card>
  );

  if (!exception.action) return body;
  return (
    <Link href={exception.action.route} className="block">
      {body}
    </Link>
  );
}
